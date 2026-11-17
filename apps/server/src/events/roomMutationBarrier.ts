import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../errors/AppError.js";

export class DrainTimeoutError extends AppError {
  constructor(message = "Timed out waiting for room mutations to drain") {
    super(message, 503, "DRAIN_TIMEOUT");
    this.name = "DrainTimeoutError";
  }
}

interface RoomBarrierState {
  isClosed: boolean;
  activeCount: number;
  drainPromise?: Promise<void>;
  resolveDrain?: () => void;
}

/**
 * RoomMutationBarrier: Single-process in-memory admission control and mutation drain barrier (H-1).
 *
 * GUARANTEES (Single-Process Architecture):
 * 1. Every relevant room mutation (chat send, sequence allocation, join, role change, removal, room end)
 *    enters via withAdmission(roomId, fn) before executing authorization- or state-dependent DB operations.
 * 2. Nested / re-entrant admission calls inherit the existing admission lease via AsyncLocalStorage
 *    without double-counting active leases or deadlocking.
 * 3. When room deletion wins the barrier in MongoDB, closeRoomAdmission(roomId) is immediately called.
 * 4. All subsequent requests attempting withAdmission(roomId, ...) are rejected immediately (404 ROOM_NOT_FOUND).
 * 5. drainRoomMutations(roomId) tracks mutations admitted before deletion and awaits their completion.
 *    If the drain exceeds timeoutMs, it throws DrainTimeoutError; it NEVER reports a timeout as a success.
 *
 * DEPLOYMENT NOTE:
 * PairPrep runs as a single Node.js HTTP/WebSocket server. For horizontal multi-instance scale-out,
 * this barrier must be backed by a distributed locking/leasing service (e.g. Redis Redlock).
 */
export class RoomMutationBarrier {
  private readonly rooms = new Map<string, RoomBarrierState>();
  private readonly asyncLocalStorage = new AsyncLocalStorage<Set<string>>();

  private getOrCreate(roomId: string): RoomBarrierState {
    let state = this.rooms.get(roomId);
    if (!state) {
      state = { isClosed: false, activeCount: 0 };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  /**
   * Checks whether the current async execution context holds an admission lease for this room.
   */
  public isAdmitted(roomId: string): boolean {
    return this.asyncLocalStorage.getStore()?.has(roomId) ?? false;
  }

  /**
   * Checks whether the room is currently accepting new mutations.
   */
  public isRoomOpen(roomId: string): boolean {
    const state = this.rooms.get(roomId);
    return !state || !state.isClosed;
  }

  /**
   * Atomically closes mutation admission for a room (called immediately when deletion barrier wins).
   */
  public closeRoomAdmission(roomId: string): void {
    const state = this.getOrCreate(roomId);
    state.isClosed = true;
  }

  /**
   * Enters the mutation protocol. Rejects if room is closed. Tracks active mutations.
   * If caller already holds an admission lease for roomId, re-uses lease re-entrantly.
   */
  public async withAdmission<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const currentStore = this.asyncLocalStorage.getStore();
    if (currentStore && currentStore.has(roomId)) {
      // Re-entrant: caller already holds an active admission lease for this room
      return await fn();
    }

    const state = this.getOrCreate(roomId);
    if (state.isClosed) {
      throw new AppError("Room not found or closed", 404, "ROOM_NOT_FOUND");
    }

    state.activeCount++;
    const newStore = new Set(currentStore || []);
    newStore.add(roomId);

    return await this.asyncLocalStorage.run(newStore, async () => {
      try {
        return await fn();
      } finally {
        state.activeCount--;
        if (state.activeCount <= 0 && state.resolveDrain) {
          state.resolveDrain();
          state.resolveDrain = undefined;
          state.drainPromise = undefined;
        }
      }
    });
  }

  /**
   * Awaits all currently active mutations admitted before the barrier to finish.
   * Rejects with DrainTimeoutError if activeCount > 0 after timeoutMs.
   */
  public async drainRoomMutations(roomId: string, timeoutMs = 5000): Promise<void> {
    const state = this.rooms.get(roomId);
    if (!state || state.activeCount <= 0) {
      return;
    }

    if (!state.drainPromise) {
      state.drainPromise = new Promise<void>((resolve) => {
        state.resolveDrain = resolve;
      });
    }

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([state.drainPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (timedOut && state.activeCount > 0) {
      throw new DrainTimeoutError(
        `Timed out waiting for room ${roomId} mutations to drain (${state.activeCount} active)`
      );
    }
  }

  /**
   * Resets the barrier state for a room (e.g. after cascade deletion completes or during tests).
   */
  public resetRoom(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (state?.resolveDrain) {
      state.resolveDrain();
    }
    this.rooms.delete(roomId);
  }

  /**
   * Returns current active in-flight mutation count for a room.
   */
  public getActiveCount(roomId: string): number {
    return this.rooms.get(roomId)?.activeCount ?? 0;
  }
}

export const roomMutationBarrier = new RoomMutationBarrier();
