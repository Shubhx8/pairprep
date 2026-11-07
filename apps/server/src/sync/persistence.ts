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
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

export interface QueuedUpdate {
  authorId: string;
  update: Uint8Array;
  ts: Date;
}

interface PendingQueue {
  roomId: string;
  document: Y.Doc;
  updates: QueuedUpdate[]; // flat arrival-order array
  firstUnflushedAt: number;
  flushDeadlineTimeout?: NodeJS.Timeout;
  debounceTimeout?: NodeJS.Timeout;
}

const pendingQueues = new Map<string, PendingQueue>();
const snapshotIntervals = new Map<string, NodeJS.Timeout>();

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
 * Enqueues an inbound update for deferred persistence in arrival order.
 * Implements a flat arrival-order array with a fixed 2,000 ms durability bound (PER-1).
 */
export function queueUpdate(
  roomId: string,
  authorId: string,
  update: Uint8Array,
  document: Y.Doc
): void {
  let queue = pendingQueues.get(roomId);
  const now = Date.now();

  if (!queue || queue.updates.length === 0) {
    if (!queue) {
      queue = {
        roomId,
        document,
        updates: [],
        firstUnflushedAt: now,
      };
      pendingQueues.set(roomId, queue);
    } else {
      queue.document = document;
      queue.firstUnflushedAt = now;
    }

    // Hard deadline timer: guarantees flush within 2 seconds even during continuous typing
    queue.flushDeadlineTimeout = setTimeout(() => {
      flushRoom(roomId).catch((err) => {
        rootLogger.error({ err, roomId }, "Error in deadline flush");
      });
    }, MAX_FLUSH_DEADLINE_MS);
  }

  // Append update in flat arrival order
  queue.updates.push({
    authorId,
    update,
    ts: new Date(),
  });

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
 * Re-queues updates on flush failure, preserving original arrival order and firstUnflushedAt.
 * Schedules the deadline timer for the remaining durability time.
 */
export function requeueUpdates(
  roomId: string,
  failedBatch: QueuedUpdate[],
  originalFirstUnflushedAt: number,
  document?: Y.Doc
): void {
  let queue = pendingQueues.get(roomId);
  const now = Date.now();

  if (!queue) {
    if (!document) {
      rootLogger.error({ roomId }, "Cannot requeue updates without document reference");
      return;
    }
    queue = {
      roomId,
      document,
      updates: [...failedBatch],
      firstUnflushedAt: originalFirstUnflushedAt,
    };
    pendingQueues.set(roomId, queue);
  } else {
    // Prepend failed batch in front of any updates that arrived while flush was executing
    queue.updates = [...failedBatch, ...queue.updates];
    // Preserve the original (older) firstUnflushedAt
    queue.firstUnflushedAt =
      queue.firstUnflushedAt > 0
        ? Math.min(queue.firstUnflushedAt, originalFirstUnflushedAt)
        : originalFirstUnflushedAt;
  }

  // Clear timers before rescheduling with remaining deadline
  if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
  if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);

  const remainingDeadline = Math.max(
    0,
    queue.firstUnflushedAt + MAX_FLUSH_DEADLINE_MS - now
  );

  queue.flushDeadlineTimeout = setTimeout(() => {
    flushRoom(roomId).catch((err) => {
      rootLogger.error({ err, roomId }, "Error in deadline flush after requeue");
    });
  }, remainingDeadline);

  const debounceDelay = Math.min(FLUSH_DEBOUNCE_MS, remainingDeadline);
  queue.debounceTimeout = setTimeout(() => {
    flushRoom(roomId).catch((err) => {
      rootLogger.error({ err, roomId }, "Error in debounced flush after requeue");
    });
  }, debounceDelay);
}

/**
 * Flushes all pending updates for a room under the room mutex.
 * Writes each update in flat arrival order, checks 2 MB doc cap,
 * and handles failures without losing updates or resetting firstUnflushedAt.
 */
export async function flushRoom(
  roomId: string,
  forceSnapshot = false
): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  await roomMutex.runExclusive(roomId, async () => {
    const queue = pendingQueues.get(roomId);
    if (!queue || queue.updates.length === 0) {
      if (forceSnapshot && queue?.document) {
        await takeSnapshot(roomId, queue.document, true);
      }
      return;
    }

    // Clear timers on captured queue
    if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
    if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);

    // Atomically capture batch and replace pending queue with an empty queue
    const batch = queue.updates;
    const originalFirstUnflushedAt = queue.firstUnflushedAt;
    const document = queue.document;

    pendingQueues.set(roomId, {
      roomId,
      document,
      updates: [],
      firstUnflushedAt: 0,
    });

    try {
      // Find latest sequence in database for this room
      const lastDoc = await DocUpdateModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      let currentSeq = lastDoc?.seq ?? 0;

      // Write one doc_updates row per update in arrival order (no merging)
      for (const item of batch) {
        currentSeq++;
        await DocUpdateModel.create({
          roomId,
          seq: currentSeq,
          authorId: item.authorId,
          update: Buffer.from(item.update),
          size: item.update.byteLength,
          ts: item.ts,
        });
      }

      // Check document size against 2 MB cap
      const fullDocState = Y.encodeStateAsUpdate(document);
      if (fullDocState.byteLength > MAX_DOC_SIZE_BYTES) {
        syncRegistry.setRoomReadOnly(roomId);
        rootLogger.warn(
          { roomId, size: fullDocState.byteLength, cap: MAX_DOC_SIZE_BYTES },
          "Room document exceeded 2 MB size cap; set to read-only"
        );
      }

      if (forceSnapshot) {
        await saveSnapshot(roomId, currentSeq, fullDocState, document);
      }

      // Clean up empty queue if no new updates arrived during DB write
      const currentQueue = pendingQueues.get(roomId);
      if (currentQueue && currentQueue.updates.length === 0) {
        pendingQueues.delete(roomId);
      }
    } catch (err) {
      rootLogger.error({ err, roomId }, "Failed to flush updates to MongoDB");
      requeueUpdates(roomId, batch, originalFirstUnflushedAt, document);
      throw err;
    }
  });
}

/**
 * Takes a snapshot of the document if updates occurred since the last snapshot, or if forced.
 */
export async function takeSnapshot(
  roomId: string,
  document: Y.Doc,
  force = false
): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;

  await roomMutex.runExclusive(roomId, async () => {
    const lastDoc = await DocUpdateModel.findOne({ roomId })
      .sort({ seq: -1 })
      .exec();
    const currentSeq = lastDoc?.seq ?? 0;

    const lastSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
    if (force || !lastSnapshot || lastSnapshot.seq < currentSeq) {
      const fullDocState = Y.encodeStateAsUpdate(document);
      await saveSnapshot(roomId, currentSeq, fullDocState, document);
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
 * Starts a 5-minute recurring snapshot timer for a loaded room.
 */
export function startSnapshotInterval(roomId: string, document: Y.Doc): void {
  stopSnapshotInterval(roomId);

  const timer = setInterval(() => {
    takeSnapshot(roomId, document).catch((err) => {
      rootLogger.error({ err, roomId }, "Error in periodic 5-minute snapshot");
    });
  }, SNAPSHOT_INTERVAL_MS);

  timer.unref();
  snapshotIntervals.set(roomId, timer);
}

/**
 * Stops the periodic snapshot timer for a room.
 */
export function stopSnapshotInterval(roomId: string): void {
  const timer = snapshotIntervals.get(roomId);
  if (timer) {
    clearInterval(timer);
    snapshotIntervals.delete(roomId);
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

  for (const timer of snapshotIntervals.values()) {
    clearInterval(timer);
  }
  snapshotIntervals.clear();
}
