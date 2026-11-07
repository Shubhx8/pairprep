import * as Y from "yjs";
import mongoose from "mongoose";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";
import { docUpdateRepo } from "../repos/docUpdateRepo.js";
import { docSnapshotRepo } from "../repos/docSnapshotRepo.js";
import { syncRegistry } from "./syncRegistry.js";
import { rootLogger } from "../middleware/logger.js";

export const FLUSH_DEBOUNCE_MS = 250;
export const MAX_FLUSH_DEADLINE_MS = 2000;
export const MAX_DOC_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB cap
export const MAX_SNAPSHOTS_TO_KEEP = 3;
export const SNAPSHOT_UPDATE_INTERVAL = 50; // Save snapshot every 50 updates

/**
 * Keyed Promise mutex to ensure strictly sequential, serialized flush and snapshot
 * operations per room document without gaps or race conditions.
 */
export class RoomMutex {
  private queues = new Map<string, Promise<unknown>>();

  runExclusive<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(roomId) || Promise.resolve();
    const result = prev.then(fn, fn);
    this.queues.set(
      roomId,
      result.then(
        () => {
          if (this.queues.get(roomId) === result) {
            this.queues.delete(roomId);
          }
        },
        () => {
          if (this.queues.get(roomId) === result) {
            this.queues.delete(roomId);
          }
        }
      )
    );
    return result;
  }
}

export const roomMutex = new RoomMutex();

interface PendingQueue {
  roomId: string;
  document: Y.Doc;
  authorUpdates: Map<string, Uint8Array[]>; // authorId -> array of updates
  firstUnflushedAt: number;
  flushDeadlineTimeout?: NodeJS.Timeout;
  debounceTimeout?: NodeJS.Timeout;
}

const pendingQueues = new Map<string, PendingQueue>();

/**
 * Loads a document by replaying the latest snapshot and all subsequent updates.
 * PRD requirement: Read-only; writes nothing to doc_updates or doc_snapshots.
 */
export async function loadDocument(
  roomId: string,
  targetDoc: Y.Doc
): Promise<{ lastSeq: number; loadedUpdatesCount: number; hasSnapshot: boolean }> {
  // If MongoDB is not connected (e.g. unauthenticated test, offline mode, or DB down), return empty state
  if (mongoose.connection.readyState !== 1) {
    return { lastSeq: 0, loadedUpdatesCount: 0, hasSnapshot: false };
  }

  // 1. Fetch latest snapshot if one exists
  const snapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
  let lastSeq = 0;
  let hasSnapshot = false;

  if (snapshot) {
    hasSnapshot = true;
    lastSeq = snapshot.seq;
    if (snapshot.state && snapshot.state.length > 0) {
      Y.applyUpdate(targetDoc, snapshot.state);
    }
  }

  // 2. Fetch all sequential updates since the snapshot
  const updates = await docUpdateRepo.getUpdatesSince(roomId, lastSeq);
  for (const u of updates) {
    if (u.update && u.update.length > 0) {
      Y.applyUpdate(targetDoc, u.update);
    }
  }

  if (updates.length > 0) {
    lastSeq = updates[updates.length - 1]!.seq;
  }

  return {
    lastSeq,
    loadedUpdatesCount: updates.length,
    hasSnapshot,
  };
}

/**
 * Enqueues an inbound update for deferred persistence.
 * Implements coalescence per author with a fixed 2,000 ms durability bound (PER-1).
 */
export function queueUpdate(
  roomId: string,
  authorId: string,
  update: Uint8Array,
  document: Y.Doc
): void {
  let queue = pendingQueues.get(roomId);
  const now = Date.now();

  if (!queue) {
    queue = {
      roomId,
      document,
      authorUpdates: new Map<string, Uint8Array[]>(),
      firstUnflushedAt: now,
    };
    pendingQueues.set(roomId, queue);

    // Hard deadline timer: guarantees flush within 2 seconds even during continuous typing
    queue.flushDeadlineTimeout = setTimeout(() => {
      flushRoom(roomId).catch((err) => {
        rootLogger.error({ err, roomId }, "Error in deadline flush");
      });
    }, MAX_FLUSH_DEADLINE_MS);
  }

  // Add update to author's bucket
  if (!queue.authorUpdates.has(authorId)) {
    queue.authorUpdates.set(authorId, []);
  }
  queue.authorUpdates.get(authorId)!.push(update);

  // Debounce timer: flushes within 250 ms of quiet period, capped at hard deadline
  if (queue.debounceTimeout) {
    clearTimeout(queue.debounceTimeout);
  }
  const remainingDeadline = Math.max(
    0,
    queue.firstUnflushedAt + MAX_FLUSH_DEADLINE_MS - now
  );
  const debounceDelay = Math.min(FLUSH_DEBOUNCE_MS, remainingDeadline);

  queue.debounceTimeout = setTimeout(() => {
    flushRoom(roomId).catch((err) => {
      rootLogger.error({ err, roomId }, "Error in debounced flush");
    });
  }, debounceDelay);
}

/**
 * Flushes all pending updates for a room under the room mutex.
 * Coalesces updates per author using Y.mergeUpdates, writes them to doc_updates
 * with strictly increasing seq, checks 2 MB doc cap, and creates/prunes snapshots.
 */
export async function flushRoom(
  roomId: string,
  forceSnapshot = false
): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  const queue = pendingQueues.get(roomId);
  if (!queue) return;

  // Clear timers and remove from pending queue
  if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
  if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
  pendingQueues.delete(roomId);

  if (queue.authorUpdates.size === 0) return;

  await roomMutex.runExclusive(roomId, async () => {
    try {
      // Find latest sequence in database for this room
      const lastDoc = await DocUpdateModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      let currentSeq = lastDoc?.seq ?? 0;

      // Coalesce updates per author with Y.mergeUpdates
      for (const [authorId, updates] of queue.authorUpdates.entries()) {
        if (!updates || updates.length === 0) continue;

        const mergedUpdate =
          updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);

        currentSeq++;
        await DocUpdateModel.create({
          roomId,
          seq: currentSeq,
          authorId,
          update: Buffer.from(mergedUpdate),
          size: mergedUpdate.byteLength,
          ts: new Date(),
        });
      }

      // Check document size against 2 MB cap
      const fullDocState = Y.encodeStateAsUpdate(queue.document);
      if (fullDocState.byteLength > MAX_DOC_SIZE_BYTES) {
        syncRegistry.setRoomReadOnly(roomId);
        rootLogger.warn(
          { roomId, size: fullDocState.byteLength, cap: MAX_DOC_SIZE_BYTES },
          "Room document exceeded 2 MB size cap; set to read-only"
        );
      }

      // Snapshot rule: save snapshot if interval reached or forced, and prune to 3 latest
      const lastSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
      const shouldSnapshot =
        forceSnapshot ||
        !lastSnapshot ||
        currentSeq - lastSnapshot.seq >= SNAPSHOT_UPDATE_INTERVAL;

      if (shouldSnapshot && (!lastSnapshot || lastSnapshot.seq < currentSeq)) {
        await saveSnapshot(roomId, currentSeq, fullDocState, queue.document);
      }
    } catch (err) {
      rootLogger.error({ err, roomId }, "Failed to flush updates to MongoDB");
      // Re-queue updates so they are not lost
      for (const [authorId, updates] of queue.authorUpdates.entries()) {
        for (const u of updates) {
          queueUpdate(roomId, authorId, u, queue.document);
        }
      }
      throw err;
    }
  });
}

/**
 * Saves a document snapshot and prunes older snapshots to keep only the 3 latest.
 */
export async function saveSnapshot(
  roomId: string,
  seq: number,
  stateUpdate: Uint8Array,
  document: Y.Doc
): Promise<void> {
  const text = document.getText("monaco")?.toString() || "";

  await docSnapshotRepo.createSnapshot({
    roomId,
    seq,
    state: Buffer.from(stateUpdate),
    text,
  });

  // Prune snapshots: keep only the latest 3
  const snapshots = await DocSnapshotModel.find({ roomId })
    .sort({ seq: -1 })
    .exec();

  if (snapshots.length > MAX_SNAPSHOTS_TO_KEEP) {
    const toDelete = snapshots.slice(MAX_SNAPSHOTS_TO_KEEP).map((s) => s._id);
    await DocSnapshotModel.deleteMany({ _id: { $in: toDelete } }).exec();
  }
}

/**
 * Flushes all pending updates for all rooms (e.g. during graceful shutdown).
 */
export async function flushAllPending(): Promise<void> {
  const roomIds = Array.from(pendingQueues.keys());
  for (const roomId of roomIds) {
    try {
      await flushRoom(roomId, true);
    } catch (err) {
      rootLogger.error({ err, roomId }, "Error flushing room during flushAll");
    }
  }
}

/**
 * Clears all in-memory queues and timers (for unit tests).
 */
export function resetPersistenceState(): void {
  for (const queue of pendingQueues.values()) {
    if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
    if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
  }
  pendingQueues.clear();
}
