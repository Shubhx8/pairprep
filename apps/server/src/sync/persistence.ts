import * as Y from "yjs";
import mongoose from "mongoose";
import { DocUpdateModel, IDocUpdate } from "../models/doc_updates.js";
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

export const MIN_RETRY_BACKOFF_MS = 250;
export const MAX_RETRY_BACKOFF_MS = 5000;
export const RETRY_BACKOFF_FACTOR = 2;
export const MAX_PENDING_UPDATES_PER_ROOM = 1000;
export const MAX_PENDING_BYTES_PER_ROOM = 4 * 1024 * 1024; // 4 MB byte cap
export const RECOVERY_THRESHOLD_RATIO = 0.5;

/**
 * Keyed Promise mutex to ensure strictly sequential, serialized operations per room.
 * Stores and compares against the actual tail promise to prevent memory leaks.
 */
export class RoomMutex {
  private queues = new Map<string, Promise<unknown>>();

  runExclusive<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(roomId) || Promise.resolve();
    const result = prev.then(fn, fn);

    const cleanup = () => {
      if (this.queues.get(roomId) === tailPromise) {
        this.queues.delete(roomId);
      }
    };

    const tailPromise: Promise<unknown> = result.then(cleanup, cleanup);
    this.queues.set(roomId, tailPromise);
    return result;
  }

  hasRoom(roomId: string): boolean {
    return this.queues.has(roomId);
  }

  get size(): number {
    return this.queues.size;
  }
}

export const roomMutex = new RoomMutex();

export interface QueuedUpdate {
  authorId: string;
  update: Uint8Array;
  ts: Date;
  seq?: number;
}

interface PendingQueue {
  roomId: string;
  document: Y.Doc;
  updates: QueuedUpdate[];
  firstUnflushedAt: number;
  failureCount: number;
  totalBytes: number;
  flushDeadlineTimeout?: NodeJS.Timeout;
  debounceTimeout?: NodeJS.Timeout;
  retryTimeout?: NodeJS.Timeout;
}

export interface PersistenceStats {
  pendingUpdates: number;
  queuedUpdates: number;
  inFlightUpdates: number;
  roomsWithPendingUpdates: number;
  oldestPendingAgeMs: number;
  flushesCompleted: number;
  flushFailures: number;
  snapshotsSaved: number;
  snapshotFailures: number;
  activeSnapshotOperations: number;
}

const pendingQueues = new Map<string, PendingQueue>();
const snapshotIntervals = new Map<string, NodeJS.Timeout>();
const activeLoadedDocuments = new Map<string, Y.Doc>();

let flushesCompleted = 0;
let flushFailures = 0;
let snapshotsSaved = 0;
let snapshotFailures = 0;
let inFlightUpdatesCount = 0;
const inFlightFlushes = new Set<Promise<void>>();
const inFlightSnapshots = new Set<Promise<void>>();

export function registerLoadedDocument(roomId: string, document: Y.Doc): void {
  activeLoadedDocuments.set(roomId, document);
}

export function unregisterLoadedDocument(roomId: string): void {
  activeLoadedDocuments.delete(roomId);
}

export function getActiveLoadedDocuments(): Map<string, Y.Doc> {
  return new Map(activeLoadedDocuments);
}

/**
 * Loads a document by replaying the latest snapshot and all subsequent updates.
 * Serialized under roomMutex to prevent races with ongoing flushes or snapshots.
 * Fails visibly if MongoDB is disconnected.
 */
export async function loadDocument(
  roomId: string,
  targetDoc: Y.Doc
): Promise<{ lastSeq: number; loadedUpdatesCount: number; hasSnapshot: boolean }> {
  if (mongoose.connection.readyState !== 1) {
    throw new Error(
      `Database unavailable: cannot load document for room ${roomId} while MongoDB is disconnected`
    );
  }

  return roomMutex.runExclusive(roomId, async () => {
    return loadDocumentLocked(roomId, targetDoc);
  });
}

async function loadDocumentLocked(
  roomId: string,
  targetDoc: Y.Doc
): Promise<{ lastSeq: number; loadedUpdatesCount: number; hasSnapshot: boolean }> {
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

  registerLoadedDocument(roomId, targetDoc);

  return {
    lastSeq,
    loadedUpdatesCount: updates.length,
    hasSnapshot,
  };
}

/**
 * Enqueues an inbound update for deferred persistence in arrival order.
 * Enforces per-room update count and byte budget backpressure.
 */
export function queueUpdate(
  roomId: string,
  authorId: string,
  update: Uint8Array,
  document: Y.Doc
): void {
  registerLoadedDocument(roomId, document);
  let queue = pendingQueues.get(roomId);
  const now = Date.now();

  if (!queue) {
    queue = {
      roomId,
      document,
      updates: [],
      firstUnflushedAt: now,
      failureCount: 0,
      totalBytes: 0,
    };
    pendingQueues.set(roomId, queue);
  } else {
    queue.document = document;
    if (queue.firstUnflushedAt === 0) {
      queue.firstUnflushedAt = now;
    }
  }

  // Preserve every update accepted into the Y.Doc
  queue.updates.push({
    authorId,
    update,
    ts: new Date(),
  });
  queue.totalBytes += update.byteLength;

  // Check protective backpressure thresholds before accepting unbounded memory
  if (
    queue.updates.length >= MAX_PENDING_UPDATES_PER_ROOM ||
    queue.totalBytes >= MAX_PENDING_BYTES_PER_ROOM
  ) {
    syncRegistry.setRoomBackpressure(roomId, true);
    rootLogger.warn(
      {
        roomId,
        count: queue.updates.length,
        bytes: queue.totalBytes,
        capCount: MAX_PENDING_UPDATES_PER_ROOM,
        capBytes: MAX_PENDING_BYTES_PER_ROOM,
      },
      "Room reached persistence queue capacity; synchronous write backpressure engaged"
    );
  }

  // Deadline timer: guarantees flush within 2 seconds of the first unflushed edit
  if (!queue.flushDeadlineTimeout && queue.failureCount === 0) {
    queue.flushDeadlineTimeout = setTimeout(() => {
      flushRoom(roomId).catch((err) => {
        rootLogger.error({ err, roomId }, "Error in deadline flush");
      });
    }, MAX_FLUSH_DEADLINE_MS);
  }

  // Debounce timer: flushes within 250ms quiet period, capped at hard deadline
  if (queue.debounceTimeout) {
    clearTimeout(queue.debounceTimeout);
  }
  if (queue.failureCount === 0) {
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
}

/**
 * Re-queues updates on flush failure, preserving original arrival order,
 * assigned sequence numbers, and original firstUnflushedAt timestamp.
 * Applies bounded exponential backoff with jitter (no 0ms spin loops).
 */
export function requeueUpdates(
  roomId: string,
  failedBatch: QueuedUpdate[],
  originalFirstUnflushedAt: number,
  document?: Y.Doc
): void {
  let queue = pendingQueues.get(roomId);

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
      failureCount: 1,
      totalBytes: failedBatch.reduce((acc, u) => acc + u.update.byteLength, 0),
    };
    pendingQueues.set(roomId, queue);
  } else {
    // Prepend failed batch in front of updates that arrived during the DB attempt
    queue.updates = [...failedBatch, ...queue.updates];
    queue.totalBytes = queue.updates.reduce((acc, u) => acc + u.update.byteLength, 0);
    queue.firstUnflushedAt =
      queue.firstUnflushedAt > 0
        ? Math.min(queue.firstUnflushedAt, originalFirstUnflushedAt)
        : originalFirstUnflushedAt;
    queue.failureCount = (queue.failureCount || 0) + 1;
  }

  // Enforce backpressure if queue is saturated
  if (
    queue.updates.length >= MAX_PENDING_UPDATES_PER_ROOM ||
    queue.totalBytes >= MAX_PENDING_BYTES_PER_ROOM
  ) {
    syncRegistry.setRoomBackpressure(roomId, true);
  }

  // Clear existing timers
  if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
  if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
  if (queue.retryTimeout) clearTimeout(queue.retryTimeout);

  // Compute bounded exponential backoff with jitter
  const backoffBase = Math.min(
    MAX_RETRY_BACKOFF_MS,
    MIN_RETRY_BACKOFF_MS * Math.pow(RETRY_BACKOFF_FACTOR, Math.min(10, queue.failureCount - 1))
  );
  const jitter = Math.floor(Math.random() * 50);
  const retryDelay = Math.min(MAX_RETRY_BACKOFF_MS, backoffBase + jitter);

  queue.retryTimeout = setTimeout(() => {
    flushRoom(roomId).catch((err) => {
      rootLogger.error({ err, roomId }, "Error in backoff retry flush");
    });
  }, retryDelay);
}

/**
 * Flushes pending updates for a room under the room mutex.
 */
export async function flushRoom(
  roomId: string,
  forceSnapshot = false
): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  const flushPromise = (async () => {
    await roomMutex.runExclusive(roomId, async () => {
      await flushRoomLocked(roomId, forceSnapshot);
    });
  })();

  inFlightFlushes.add(flushPromise);
  try {
    await flushPromise;
  } finally {
    inFlightFlushes.delete(flushPromise);
  }
}

/**
 * Internal locked flush implementation: assumes caller holds roomMutex.
 * Assigns sequence numbers stably, reconciles existing DB records to guarantee
 * idempotent retries, and enforces the 2 MB document cap.
 */
async function flushRoomLocked(
  roomId: string,
  forceSnapshot = false
): Promise<void> {
  const queue = pendingQueues.get(roomId);
  const doc = queue?.document ?? activeLoadedDocuments.get(roomId);

  if (!queue || queue.updates.length === 0) {
    if (forceSnapshot && doc) {
      await takeSnapshotLocked(roomId, doc, true);
    }
    return;
  }

  // Clear timers on captured queue
  if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
  if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
  if (queue.retryTimeout) clearTimeout(queue.retryTimeout);

  // Stably allocate sequence numbers to all queued updates that lack them
  let currentSeq = 0;
  const firstWithSeq = queue.updates.find((u) => u.seq !== undefined);
  if (firstWithSeq) {
    let maxAssigned = 0;
    for (const u of queue.updates) {
      if (u.seq !== undefined) {
        maxAssigned = Math.max(maxAssigned, u.seq);
      }
    }
    currentSeq = maxAssigned;
    for (const u of queue.updates) {
      if (u.seq === undefined) {
        currentSeq++;
        u.seq = currentSeq;
      }
    }
  } else {
    const lastDoc = await DocUpdateModel.findOne({ roomId })
      .sort({ seq: -1, ts: -1, _id: -1 })
      .exec();
    currentSeq = lastDoc?.seq ?? 0;
    for (const u of queue.updates) {
      currentSeq++;
      u.seq = currentSeq;
    }
  }

  const batch = queue.updates;
  const originalFirstUnflushedAt = queue.firstUnflushedAt;
  const document = queue.document;

  inFlightUpdatesCount += batch.length;

  pendingQueues.set(roomId, {
    roomId,
    document,
    updates: [],
    firstUnflushedAt: 0,
    failureCount: queue.failureCount,
    totalBytes: 0,
  });

  try {
    const minSeq = batch[0]!.seq!;
    const maxSeq = batch[batch.length - 1]!.seq!;

    // Query existing records in sequence range to reconcile partial writes & ambiguous timeouts
    const existing = await DocUpdateModel.find({
      roomId,
      seq: { $gte: minSeq, $lte: maxSeq },
    })
      .sort({ seq: 1 })
      .exec();

    const existingMap = new Map<number, IDocUpdate>();
    for (const d of existing) {
      existingMap.set(d.seq, d);
    }

    const toInsert: {
      roomId: string;
      seq: number;
      authorId: string;
      update: Buffer;
      size: number;
      ts: Date;
    }[] = [];

    for (const item of batch) {
      const match = existingMap.get(item.seq!);
      if (match) {
        const itemBuf = Buffer.from(item.update);
        const isMatch =
          match.authorId === item.authorId &&
          Buffer.compare(match.update, itemBuf) === 0;

        if (!isMatch) {
          throw new Error(
            `Consistency failure: conflicting record in roomId=${roomId} at seq=${item.seq}`
          );
        }
        // Matching record already persisted in MongoDB: skip re-inserting
      } else {
        toInsert.push({
          roomId,
          seq: item.seq!,
          authorId: item.authorId,
          update: Buffer.from(item.update),
          size: item.update.byteLength,
          ts: item.ts,
        });
      }
    }

    if (toInsert.length > 0) {
      for (const item of toInsert) {
        await DocUpdateModel.create({
          roomId,
          seq: item.seq,
          authorId: item.authorId,
          update: item.update,
          size: item.size,
          ts: item.ts,
        });
      }
    }

    // Reset failure counter on successful database confirmation
    const currentQ = pendingQueues.get(roomId);
    if (currentQ) {
      currentQ.failureCount = 0;
    }

    // Check document size against 2 MB cap
    const docToEncode = document || activeLoadedDocuments.get(roomId);
    if (docToEncode) {
      const fullDocState = Y.encodeStateAsUpdate(docToEncode);
      if (fullDocState.byteLength > MAX_DOC_SIZE_BYTES) {
        syncRegistry.setRoomReadOnly(roomId);
        rootLogger.warn(
          { roomId, size: fullDocState.byteLength, cap: MAX_DOC_SIZE_BYTES },
          "Room document exceeded 2 MB size cap; set to read-only"
        );
      }
    }

    // Release backpressure if queue fell below recovery threshold
    if (syncRegistry.isRoomBackpressured(roomId)) {
      const activeQ = pendingQueues.get(roomId);
      const remainingCount = activeQ?.updates.length ?? 0;
      const remainingBytes = activeQ?.totalBytes ?? 0;
      if (
        remainingCount <= MAX_PENDING_UPDATES_PER_ROOM * RECOVERY_THRESHOLD_RATIO &&
        remainingBytes <= MAX_PENDING_BYTES_PER_ROOM * RECOVERY_THRESHOLD_RATIO
      ) {
        syncRegistry.setRoomBackpressure(roomId, false);
      }
    }

    if (forceSnapshot && docToEncode) {
      await takeSnapshotLocked(roomId, docToEncode, true);
    }

    inFlightUpdatesCount -= batch.length;
    flushesCompleted++;

    // Clean up empty queue if no new updates arrived during DB write and not backpressured
    const remainingQueue = pendingQueues.get(roomId);
    if (
      remainingQueue &&
      remainingQueue.updates.length === 0 &&
      !syncRegistry.isRoomBackpressured(roomId)
    ) {
      pendingQueues.delete(roomId);
    }
  } catch (err) {
    inFlightUpdatesCount -= batch.length;
    flushFailures++;
    rootLogger.error({ err, roomId }, "Failed to flush updates to MongoDB");
    requeueUpdates(roomId, batch, originalFirstUnflushedAt, document);
    throw err;
  }
}

/**
 * Takes a consistent snapshot of the document under the room mutex.
 * Flushes all pending updates to MongoDB before capturing Y.Doc state
 * to ensure exact watermark lockstep with zero asynchronous gap.
 */
export async function takeSnapshot(
  roomId: string,
  document: Y.Doc,
  force = false
): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;

  const snapPromise = (async () => {
    try {
      await roomMutex.runExclusive(roomId, async () => {
        await takeSnapshotLocked(roomId, document, force);
      });
    } catch (err) {
      snapshotFailures++;
      throw err;
    }
  })();

  inFlightSnapshots.add(snapPromise);
  try {
    await snapPromise;
  } finally {
    inFlightSnapshots.delete(snapPromise);
  }
}

async function takeSnapshotLocked(
  roomId: string,
  document: Y.Doc,
  force = false
): Promise<void> {
  // 1. Flush any pending updates first under mutex so sequence advances
  if (pendingQueues.get(roomId)?.updates.length) {
    await flushRoomLocked(roomId, false);
  }

  // 2. Fetch the latest sequence in MongoDB
  const lastDoc = await DocUpdateModel.findOne({ roomId })
    .sort({ seq: -1, ts: -1, _id: -1 })
    .exec();
  const currentSeq = lastDoc?.seq ?? 0;

  // 3. Deduplicate: skip if an equal or newer snapshot is already saved
  const lastSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
  if (!force && lastSnapshot && lastSnapshot.seq >= currentSeq) {
    return;
  }
  if (force && lastSnapshot && lastSnapshot.seq === currentSeq) {
    return;
  }

  // 4. Capture state at exact sequence watermark
  const fullDocState = Y.encodeStateAsUpdate(document);
  await saveSnapshot(roomId, currentSeq, fullDocState, document);
}

/**
 * Saves a document snapshot and prunes older snapshots to keep only the 3 latest.
 * Pruning uses deterministic sorting with timestamp and _id tie-breakers.
 */
export async function saveSnapshot(
  roomId: string,
  seq: number,
  stateUpdate: Uint8Array,
  document: Y.Doc
): Promise<void> {
  const text = document.getText("monaco")?.toString() || "";

  try {
    await docSnapshotRepo.createSnapshot({
      roomId,
      seq,
      state: Buffer.from(stateUpdate),
      text,
    });

    // Prune snapshots: keep only the latest 3 with deterministic sorting
    const snapshots = await DocSnapshotModel.find({ roomId })
      .sort({ seq: -1, ts: -1, _id: -1 })
      .exec();

    if (snapshots.length > MAX_SNAPSHOTS_TO_KEEP) {
      const toDelete = snapshots.slice(MAX_SNAPSHOTS_TO_KEEP).map((s) => s._id);
      await DocSnapshotModel.deleteMany({ _id: { $in: toDelete } }).exec();
    }

    snapshotsSaved++;
  } catch (err) {
    snapshotFailures++;
    throw err;
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
 * Stops all active recurring snapshot timers across all rooms.
 */
export function stopAllSnapshotIntervals(): void {
  for (const timer of snapshotIntervals.values()) {
    clearInterval(timer);
  }
  snapshotIntervals.clear();
}

/**
 * Returns an operational snapshot of persistence queues and health.
 */
export function getPendingPersistenceStats(now = Date.now()): PersistenceStats {
  let queuedUpdates = 0;
  let roomsWithPendingUpdates = 0;
  let oldestTimestamp = 0;

  for (const queue of pendingQueues.values()) {
    if (queue.updates.length > 0) {
      queuedUpdates += queue.updates.length;
      roomsWithPendingUpdates++;
      if (queue.firstUnflushedAt > 0) {
        if (oldestTimestamp === 0 || queue.firstUnflushedAt < oldestTimestamp) {
          oldestTimestamp = queue.firstUnflushedAt;
        }
      }
    }
  }

  const oldestPendingAgeMs =
    oldestTimestamp > 0 ? Math.max(0, now - oldestTimestamp) : 0;

  return {
    pendingUpdates: queuedUpdates + inFlightUpdatesCount,
    queuedUpdates,
    inFlightUpdates: inFlightUpdatesCount,
    roomsWithPendingUpdates,
    oldestPendingAgeMs,
    flushesCompleted,
    flushFailures,
    snapshotsSaved,
    snapshotFailures,
    activeSnapshotOperations: inFlightSnapshots.size,
  };
}

/**
 * Flushes all pending updates for all rooms and takes consistent final snapshots.
 * Discovers rooms from both pendingQueues and the active loaded documents registry.
 * Drains all rooms even if individual writes fail, and surfaces unconfirmed work honestly.
 */
export async function drainPersistenceAndSnapshot(
  options: { takeFinalSnapshots?: boolean } = {}
): Promise<void> {
  const takeFinalSnapshots = options.takeFinalSnapshots ?? true;

  // 1. Clear all recurring 5-minute snapshot timers
  stopAllSnapshotIntervals();

  // If MongoDB is not connected, skip database operations
  if (mongoose.connection.readyState !== 1) {
    rootLogger.warn(
      { readyState: mongoose.connection.readyState },
      "MongoDB is not connected. Skipping database persistence drain."
    );
    for (const queue of pendingQueues.values()) {
      if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
      if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
      if (queue.retryTimeout) clearTimeout(queue.retryTimeout);
    }
    pendingQueues.clear();
    return;
  }

  const inFlightErrors: unknown[] = [];

  // 2. Await in-flight snapshot operations already running
  if (inFlightSnapshots.size > 0) {
    const results = await Promise.allSettled(Array.from(inFlightSnapshots));
    for (const r of results) {
      if (r.status === "rejected") inFlightErrors.push(r.reason);
    }
  }

  // 3. Await in-flight flush operations already running
  if (inFlightFlushes.size > 0) {
    const results = await Promise.allSettled(Array.from(inFlightFlushes));
    for (const r of results) {
      if (r.status === "rejected") inFlightErrors.push(r.reason);
    }
  }

  // 4. Capture all rooms: union of pendingQueues and active loaded documents
  const allRoomIds = new Set<string>([
    ...pendingQueues.keys(),
    ...activeLoadedDocuments.keys(),
  ]);

  const drainErrors: unknown[] = [];

  // 5. Drain pending updates for all rooms
  for (const roomId of allRoomIds) {
    try {
      await flushRoom(roomId, false);
    } catch (err) {
      drainErrors.push(err);
    }
  }

  // 6. Take final snapshots if requested and document exists
  if (takeFinalSnapshots) {
    for (const roomId of allRoomIds) {
      const doc =
        activeLoadedDocuments.get(roomId) ?? pendingQueues.get(roomId)?.document;
      if (doc) {
        try {
          await takeSnapshot(roomId, doc, true);
        } catch (err) {
          drainErrors.push(err);
        }
      }
    }
  }

  // 7. Await any newly spawned in-flight operations
  if (inFlightFlushes.size > 0) {
    const results = await Promise.allSettled(Array.from(inFlightFlushes));
    for (const r of results) {
      if (r.status === "rejected") inFlightErrors.push(r.reason);
    }
  }
  if (inFlightSnapshots.size > 0) {
    const results = await Promise.allSettled(Array.from(inFlightSnapshots));
    for (const r of results) {
      if (r.status === "rejected") inFlightErrors.push(r.reason);
    }
  }

  // 8. Verify no pending queues remain and surface any failures honestly
  const stats = getPendingPersistenceStats();
  const totalErrors = [...inFlightErrors, ...drainErrors];
  if (totalErrors.length > 0) {
    throw totalErrors[0];
  }
  if (stats.pendingUpdates > 0) {
    throw new Error(
      `Persistence drain incomplete: ${stats.pendingUpdates} updates remain unflushed`
    );
  }
}

/**
 * Legacy alias for drainPersistenceAndSnapshot.
 */
export async function flushAllPending(): Promise<void> {
  await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });
}

/**
 * Clears all in-memory queues and timers (for unit tests).
 */
export function resetPersistenceState(): void {
  for (const queue of pendingQueues.values()) {
    if (queue.flushDeadlineTimeout) clearTimeout(queue.flushDeadlineTimeout);
    if (queue.debounceTimeout) clearTimeout(queue.debounceTimeout);
    if (queue.retryTimeout) clearTimeout(queue.retryTimeout);
  }
  pendingQueues.clear();
  activeLoadedDocuments.clear();
  stopAllSnapshotIntervals();
  flushesCompleted = 0;
  flushFailures = 0;
  snapshotsSaved = 0;
  snapshotFailures = 0;
  inFlightUpdatesCount = 0;
  inFlightFlushes.clear();
  inFlightSnapshots.clear();
}
