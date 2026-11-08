/**
 * Document Load Waiter Registry
 *
 * Tracks pending room reservations (connection socket IDs) that are awaiting
 * an in-flight Hocuspocus document load.
 *
 * Because Hocuspocus 4.7.1 createDocument() deduplicates concurrent loads by
 * document name, multiple connections share a single loadDocument promise.
 * If that shared load fails, all waiting connections must have their reservations
 * and rate-limiter entries cleanly released.
 */
export class DocumentLoadWaiterRegistry {
  private waiters = new Map<string, Set<string>>(); // roomId -> Set<socketId>

  /**
   * Registers a socket ID as an awaiting connection for an in-flight document load.
   */
  addWaiter(roomId: string, socketId: string): void {
    if (!roomId || !socketId) return;
    let set = this.waiters.get(roomId);
    if (!set) {
      set = new Set();
      this.waiters.set(roomId, set);
    }
    set.add(socketId);
  }

  /**
   * Removes a socket ID from the document loading waiters (e.g. after successful connection).
   */
  removeWaiter(roomId: string, socketId: string): void {
    const set = this.waiters.get(roomId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.waiters.delete(roomId);
      }
    }
  }

  /**
   * Returns all socket IDs currently awaiting document load for roomId.
   */
  getWaiters(roomId: string): string[] {
    const set = this.waiters.get(roomId);
    return set ? Array.from(set) : [];
  }

  /**
   * Clears and returns all socket IDs that were awaiting document load for roomId.
   */
  clearWaiters(roomId: string): string[] {
    const set = this.waiters.get(roomId);
    if (!set) return [];
    this.waiters.delete(roomId);
    return Array.from(set);
  }

  /**
   * Resets all internal waiter tracking state (for shutdown and testing).
   */
  resetAll(): void {
    this.waiters.clear();
  }
}

export const documentLoadWaiters = new DocumentLoadWaiterRegistry();
