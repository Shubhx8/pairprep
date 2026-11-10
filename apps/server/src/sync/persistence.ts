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
export const MAX_UPDATE_SIZE_BYTES = 1024 * 1024; // 1 MB single update limit
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
  requiresFinalSnapshot?: boolean;
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

// In-flight per-room capacity tracking
const inFlightUpdatesByRoom = new Map<string, number>();
const inFlightBytesByRoom = new Map<string, number>();

// Admission reservations for pre-mutation capacity gating
interface AdmissionReservation {
  roomId: string;
  socketId: string;
  bytes: number;
  ts: number;
}

const reservedUpdatesByRoom = new Map<string, number>();
const reservedBytesByRoom = new Map<string, number>();
const activeReservationsBySocket = new Map<string, AdmissionReservation[]>();

/**
 * Checks if a room has reached its configured persistence capacity (including in-flight and reservations).
 */
export function isRoomAtPersistenceCapacity(
  roomId: string,
  additionalBytes = 0
): boolean {
  const queue = pendingQueues.get(roomId);
  const pendingCount = queue?.updates.length ?? 0;
  const pendingBytes = queue?.totalBytes ?? 0;
  const inFlightCount = inFlightUpdatesByRoom.get(roomId) ?? 0;
  const inFlightBytes = inFlightBytesByRoom.get(roomId) ?? 0;
  const reservedCount = reservedUpdatesByRoom.get(roomId) ?? 0;
  const reservedBytes = reservedBytesByRoom.get(roomId) ?? 0;

  const totalCount = pendingCount + inFlightCount + reservedCount;
  const totalBytes = pendingBytes + inFlightBytes + reservedBytes + additionalBytes;

  return (
    totalCount >= MAX_PENDING_UPDATES_PER_ROOM || totalBytes >= MAX_PENDING_BYTES_PER_ROOM
  );
}

/**
 * Attempts to synchronously reserve admission capacity BEFORE a document mutation is applied.
 * Returns { allowed: true } if capacity is available, or { allowed: false, reason: "queue_capacity_exceeded" }
 * and activates room backpressure if capacity is exhausted.
 */
export function tryReserveAdmission(
  roomId: string,
  socketId: string,
  frameBytes: number
): { allowed: boolean; reason?: string } {
  const queue = pendingQueues.get(roomId);
  const pendingCount = queue?.updates.length ?? 0;
  const pendingBytes = queue?.totalBytes ?? 0;
  const inFlightCount = inFlightUpdatesByRoom.get(roomId) ?? 0;
  const inFlightBytes = inFlightBytesByRoom.get(roomId) ?? 0;
  const reservedCount = reservedUpdatesByRoom.get(roomId) ?? 0;
  const reservedBytes = reservedBytesByRoom.get(roomId) ?? 0;

  const totalCount = pendingCount + inFlightCount + reservedCount;
  const totalBytes = pendingBytes + inFlightBytes + reservedBytes;

  if (
    totalCount + 1 > MAX_PENDING_UPDATES_PER_ROOM ||
    totalBytes + frameBytes > MAX_PENDING_BYTES_PER_ROOM
  ) {
    syncRegistry.setRoomBackpressure(roomId, true);
    rootLogger.warn(
      {
        roomId,
        socketId,
        totalCount,
        totalBytes,
        frameBytes,
        capCount: MAX_PENDING_UPDATES_PER_ROOM,
        capBytes: MAX_PENDING_BYTES_PER_ROOM,
      },
      "Pre-mutation admission rejected: room persistence capacity exhausted"
    );
    return { allowed: false, reason: "queue_capacity_exceeded" };
  }

  reservedUpdatesByRoom.set(roomId, reservedCount + 1);
  reservedBytesByRoom.set(roomId, reservedBytes + frameBytes);

  const list = activeReservationsBySocket.get(socketId) ?? [];
  list.push({ roomId, socketId, bytes: frameBytes, ts: Date.now() });
  activeReservationsBySocket.set(socketId, list);

  return { allowed: true };
}

/**
 * Transfers an active admission reservation into the pending persistence queue.
 * Decrements reserved counters and increments queued counters without double-counting.
 */
export function transferAdmissionReservation(roomId: string, socketId: string): void {
  const list = activeReservationsBySocket.get(socketId);
  if (list && list.length > 0) {
    const idx = list.findIndex((r) => r.roomId === roomId);
    if (idx !== -1) {
      const res = list.splice(idx, 1)[0]!;
      if (list.length === 0) {
        activeReservationsBySocket.delete(socketId);
      }
      const curResCount = reservedUpdatesByRoom.get(roomId) ?? 0;
      reservedUpdatesByRoom.set(roomId, Math.max(0, curResCount - 1));
      const curResBytes = reservedBytesByRoom.get(roomId) ?? 0;
      reservedBytesByRoom.set(roomId, Math.max(0, curResBytes - res.bytes));
    }
  }
}

/**
 * Checks whether room load has dropped below recovery threshold and releases write backpressure.
 */
export function checkAndReleaseBackpressure(roomId: string): void {
  if (syncRegistry.isRoomBackpressured(roomId)) {
    const activeQ = pendingQueues.get(roomId);
    const inFlightRemainingCount = inFlightUpdatesByRoom.get(roomId) ?? 0;
    const inFlightRemainingBytes = inFlightBytesByRoom.get(roomId) ?? 0;
    const reservedRemainingCount = reservedUpdatesByRoom.get(roomId) ?? 0;
    const reservedRemainingBytes = reservedBytesByRoom.get(roomId) ?? 0;
    const remainingCount =
      (activeQ?.updates.length ?? 0) + inFlightRemainingCount + reservedRemainingCount;
    const remainingBytes =
      (activeQ?.totalBytes ?? 0) + inFlightRemainingBytes + reservedRemainingBytes;
    if (
      remainingCount <= MAX_PENDING_UPDATES_PER_ROOM * RECOVERY_THRESHOLD_RATIO &&
      remainingBytes <= MAX_PENDING_BYTES_PER_ROOM * RECOVERY_THRESHOLD_RATIO
    ) {
      syncRegistry.setRoomBackpressure(roomId, false);
    }
  }
}

/**
 * Releases an admission reservation for non-mutating messages or failed/aborted frames.
 */
export function releaseAdmissionReservation(roomId: string, socketId: string): void {
  transferAdmissionReservation(roomId, socketId);
  checkAndReleaseBackpressure(roomId);
}

/**
 * Clears all admission reservations for a socket, room, or globally on reset.
 */
export function clearAdmissionReservations(socketId?: string, roomId?: string): void {
  if (socketId) {
    const list = activeReservationsBySocket.get(socketId);
    if (list) {
      for (const res of list) {
        const curResCount = reservedUpdatesByRoom.get(res.roomId) ?? 0;
        reservedUpdatesByRoom.set(res.roomId, Math.max(0, curResCount - 1));
        const curResBytes = reservedBytesByRoom.get(res.roomId) ?? 0;
        reservedBytesByRoom.set(res.roomId, Math.max(0, curResBytes - res.bytes));
      }
      activeReservationsBySocket.delete(socketId);
    }
  } else if (roomId) {
    reservedUpdatesByRoom.delete(roomId);
    reservedBytesByRoom.delete(roomId);
    for (const [sock, list] of activeReservationsBySocket.entries()) {
      const filtered = list.filter((r) => r.roomId !== roomId);
      if (filtered.length === 0) {
        activeReservationsBySocket.delete(sock);
      } else {
        activeReservationsBySocket.set(sock, filtered);
      }
    }
    checkAndReleaseBackpressure(roomId);
  } else {
    reservedUpdatesByRoom.clear();
    reservedBytesByRoom.clear();
    activeReservationsBySocket.clear();
  }
}

/**
 * Returns reserved admission count and bytes for observability and testing.
 */
export function getReservedAdmissionStats(roomId?: string): {
  count: number;
  bytes: number;
} {
  if (roomId) {
    return {
      count: reservedUpdatesByRoom.get(roomId) ?? 0,
      bytes: reservedBytesByRoom.get(roomId) ?? 0,
    };
  }
  let count = 0;
  let bytes = 0;
  for (const c of reservedUpdatesByRoom.values()) count += c;
  for (const b of reservedBytesByRoom.values()) bytes += b;
  return { count, bytes };
}

// Synchronous document mutation tracking for exact snapshot consistency
const roomAppliedUpdates = new Map<string, number>();
const roomPersistedUpdates = new Map<string, number>();
const trackedDocs = new WeakSet<Y.Doc>();

export const snapshotTestingHooks = {
  beforeCaptureBarrier: null as (() => Promise<void> | void) | null,
  afterCaptureBarrier: null as (() => Promise<void> | void) | null,
};

let flushesCompleted = 0;
let flushFailures = 0;
let snapshotsSaved = 0;
let snapshotFailures = 0;
let inFlightUpdatesCount = 0;
const inFlightFlushes = new Set<Promise<void>>();
const inFlightSnapshots = new Set<Promise<void>>();

export function registerLoadedDocument(roomId: string, document: Y.Doc): void {
  activeLoadedDocuments.set(roomId, document);
  if (!trackedDocs.has(document)) {
    trackedDocs.add(document);
    document.on("update", () => {
      const count = roomAppliedUpdates.get(roomId) || 0;
      roomAppliedUpdates.set(roomId, count + 1);
    });
  }
}

export function unregisterLoadedDocument(roomId: string): void {
  activeLoadedDocuments.delete(roomId);
}

export type DocumentFinalizeHook = (
  roomId: string,
  document: Y.Doc
) => Promise<void> | void;
let documentFinalizeHook: DocumentFinalizeHook | null = null;

export function setDocumentFinalizeHook(hook: DocumentFinalizeHook | null): void {
  documentFinalizeHook = hook;
}

export function isRoomPersistencePending(roomId: string): boolean {
  const queue = pendingQueues.get(roomId);
  const pendingCount = queue?.updates.length ?? 0;
  const inFlightCount = inFlightUpdatesByRoom.get(roomId) ?? 0;
  const hasRetry = queue?.retryTimeout !== undefined;
  return (
    pendingCount > 0 ||
    inFlightCount > 0 ||
    hasRetry ||
    Boolean(queue?.requiresFinalSnapshot)
  );
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
  targetDoc: Y.Doc,
  options?: { readOnly?: boolean }
): Promise<{ lastSeq: number; loadedUpdatesCount: number; hasSnapshot: boolean }> {
  if (mongoose.connection.readyState !== 1) {
    throw new Error(
      `Database unavailable: cannot load document for room ${roomId} while MongoDB is disconnected`
    );
  }

  return roomMutex.runExclusive(roomId, async () => {
    return loadDocumentLocked(roomId, targetDoc, options);
  });
}

async function loadDocumentLocked(
  roomId: string,
  targetDoc: Y.Doc,
  options?: { readOnly?: boolean }
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

  // 3. Migrate legacy document fields if document contains "monaco" but lacks canonical "code"
  let migrationUpdate: Uint8Array | null = null;
  const captureMigration = (update: Uint8Array) => {
    migrationUpdate = update;
  };
  targetDoc.on("update", captureMigration);
  const { migrated } = migrateLegacyDocFields(targetDoc);
  targetDoc.off("update", captureMigration);

  trackedDocs.add(targetDoc);
  activeLoadedDocuments.set(roomId, targetDoc);
  targetDoc.on("update", () => {
    const count = roomAppliedUpdates.get(roomId) || 0;
    roomAppliedUpdates.set(roomId, count + 1);
  });
  roomAppliedUpdates.set(roomId, 0);
  roomPersistedUpdates.set(roomId, 0);

  // Queue migration update into persistence pipeline unless client is read-only
  if (migrated && migrationUpdate && !options?.readOnly) {
    queueUpdate(roomId, "system:migration", migrationUpdate, targetDoc);
  }

  return {
    lastSeq,
    loadedUpdatesCount: updates.length,
    hasSnapshot,
  };
}

/**
 * Enqueues an inbound update for deferred persistence in arrival order.
 * Enforces per-room update count and byte budget backpressure.
 * When socketId is provided, transfers any pre-mutation admission reservation
 * into queued persistence accounting without double-counting.
 */
export function queueUpdate(
  roomId: string,
  authorId: string,
  update: Uint8Array,
  document: Y.Doc,
  socketId?: string
): void {
  if (socketId) {
    transferAdmissionReservation(roomId, socketId);
  }
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

  // Ensure roomAppliedUpdates reflects at least all queued + in-flight edits
  const inFlightCount = inFlightUpdatesByRoom.get(roomId) ?? 0;
  const inFlightBytes = inFlightBytesByRoom.get(roomId) ?? 0;
  const currentApplied = roomAppliedUpdates.get(roomId) || 0;
  const minRequiredApplied =
    (roomPersistedUpdates.get(roomId) || 0) + inFlightCount + queue.updates.length;
  if (currentApplied < minRequiredApplied) {
    roomAppliedUpdates.set(roomId, minRequiredApplied);
  }

  // Combined pending + in-flight + reserved capacity check
  const reservedCount = reservedUpdatesByRoom.get(roomId) ?? 0;
  const reservedBytes = reservedBytesByRoom.get(roomId) ?? 0;
  const totalCount = queue.updates.length + inFlightCount + reservedCount;
  const totalBytes = queue.totalBytes + inFlightBytes + reservedBytes;

  if (
    totalCount >= MAX_PENDING_UPDATES_PER_ROOM ||
    totalBytes >= MAX_PENDING_BYTES_PER_ROOM
  ) {
    syncRegistry.setRoomBackpressure(roomId, true);
    rootLogger.warn(
      {
        roomId,
        count: totalCount,
        bytes: totalBytes,
        capCount: MAX_PENDING_UPDATES_PER_ROOM,
        capBytes: MAX_PENDING_BYTES_PER_ROOM,
      },
      "Room reached combined pending and in-flight persistence capacity; write backpressure engaged"
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
  document?: Y.Doc,
  requiresFinalSnapshot = false
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
      requiresFinalSnapshot,
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
    if (requiresFinalSnapshot) {
      queue.requiresFinalSnapshot = true;
    }
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
    MIN_RETRY_BACKOFF_MS *
      Math.pow(RETRY_BACKOFF_FACTOR, Math.min(10, queue.failureCount - 1))
  );
  const jitter = Math.floor(Math.random() * 50);
  const retryDelay = Math.min(MAX_RETRY_BACKOFF_MS, backoffBase + jitter);

  queue.retryTimeout = setTimeout(() => {
    const q = pendingQueues.get(roomId);
    const needSnapshot = Boolean(q?.requiresFinalSnapshot);
    flushRoom(roomId, needSnapshot)
      .then(async () => {
        if (needSnapshot && syncRegistry.getActiveConnectionCount(roomId) === 0) {
          const docToFinalize = activeLoadedDocuments.get(roomId) ?? q?.document;
          unregisterLoadedDocument(roomId);
          if (documentFinalizeHook && docToFinalize) {
            await documentFinalizeHook(roomId, docToFinalize);
          }
        }
      })
      .catch((err) => {
        rootLogger.error({ err, roomId }, "Error in backoff retry flush");
      });
  }, retryDelay);
}

/**
 * Flushes pending updates for a room under the room mutex.
 */
export async function flushRoom(roomId: string, forceSnapshot = false): Promise<void> {
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
async function flushRoomLocked(roomId: string, forceSnapshot = false): Promise<void> {
  const queue = pendingQueues.get(roomId);
  const doc = queue?.document ?? activeLoadedDocuments.get(roomId);
  const shouldSnapshot = forceSnapshot || Boolean(queue?.requiresFinalSnapshot);

  if (!queue || queue.updates.length === 0) {
    checkAndReleaseBackpressure(roomId);
    if (shouldSnapshot && doc) {
      await takeSnapshotLocked(roomId, doc, true);
      if (queue) queue.requiresFinalSnapshot = false;
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
  const batchBytes = batch.reduce((acc, u) => acc + u.update.byteLength, 0);

  // Transition batch from pending queue to in-flight tracking
  inFlightUpdatesCount += batch.length;
  inFlightUpdatesByRoom.set(
    roomId,
    (inFlightUpdatesByRoom.get(roomId) ?? 0) + batch.length
  );
  inFlightBytesByRoom.set(roomId, (inFlightBytesByRoom.get(roomId) ?? 0) + batchBytes);

  pendingQueues.set(roomId, {
    roomId,
    document,
    updates: [],
    firstUnflushedAt: 0,
    failureCount: queue.failureCount,
    totalBytes: 0,
    requiresFinalSnapshot: shouldSnapshot,
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
          match.authorId === item.authorId && Buffer.compare(match.update, itemBuf) === 0;

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
        try {
          await DocUpdateModel.create({
            roomId,
            seq: item.seq,
            authorId: item.authorId,
            update: item.update,
            size: item.size,
            ts: item.ts,
          });
        } catch (createErr: unknown) {
          const isDupKey =
            typeof createErr === "object" &&
            createErr !== null &&
            "code" in createErr &&
            (createErr as { code?: number }).code === 11000;

          if (isDupKey) {
            const existingRec = await DocUpdateModel.findOne({
              roomId,
              seq: item.seq,
            }).exec();
            if (existingRec) {
              const itemBuf = Buffer.from(item.update);
              const isMatch =
                existingRec.authorId === item.authorId &&
                Buffer.compare(existingRec.update, itemBuf) === 0;
              if (!isMatch) {
                throw new Error(
                  `Consistency failure: conflicting record in roomId=${roomId} at seq=${item.seq}`
                );
              }
              // Matching duplicate: reconciled successfully
              continue;
            }
          }
          throw createErr;
        }
      }
    }

    // Success path: release in-flight and track persisted updates
    inFlightUpdatesCount -= batch.length;
    inFlightUpdatesByRoom.set(
      roomId,
      Math.max(0, (inFlightUpdatesByRoom.get(roomId) ?? 0) - batch.length)
    );
    inFlightBytesByRoom.set(
      roomId,
      Math.max(0, (inFlightBytesByRoom.get(roomId) ?? 0) - batchBytes)
    );
    flushesCompleted++;
    roomPersistedUpdates.set(
      roomId,
      (roomPersistedUpdates.get(roomId) || 0) + batch.length
    );

    // Reset failure counter ONLY upon complete logical flush confirmation
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

    // Release backpressure if queue fell below recovery threshold (accounting for in-flight and reservations)
    checkAndReleaseBackpressure(roomId);

    if (shouldSnapshot && docToEncode) {
      await takeSnapshotLocked(roomId, docToEncode, true);
      if (queue) queue.requiresFinalSnapshot = false;
      const curQ = pendingQueues.get(roomId);
      if (curQ) curQ.requiresFinalSnapshot = false;
    }

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
    inFlightUpdatesByRoom.set(
      roomId,
      Math.max(0, (inFlightUpdatesByRoom.get(roomId) ?? 0) - batch.length)
    );
    inFlightBytesByRoom.set(
      roomId,
      Math.max(0, (inFlightBytesByRoom.get(roomId) ?? 0) - batchBytes)
    );
    flushFailures++;
    rootLogger.error({ err, roomId }, "Failed to flush updates to MongoDB");
    requeueUpdates(roomId, batch, originalFirstUnflushedAt, document, shouldSnapshot);
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
  let currentSeq = 0;
  let fullDocState: Uint8Array;

  while (true) {
    // 1. Flush any queued updates first
    while ((pendingQueues.get(roomId)?.updates.length ?? 0) > 0) {
      await flushRoomLocked(roomId, false);
    }

    // 2. If updates were applied to document whose onChange microtask has not queued yet,
    // yield to allow microtasks and setImmediate to process
    const applied = roomAppliedUpdates.get(roomId) || 0;
    const persisted = roomPersistedUpdates.get(roomId) || 0;
    if (applied > persisted) {
      await new Promise((r) => setImmediate(r));
      if ((pendingQueues.get(roomId)?.updates.length ?? 0) > 0) {
        continue;
      }
    }

    // 3. Testing barrier before capture
    if (snapshotTestingHooks.beforeCaptureBarrier) {
      await snapshotTestingHooks.beforeCaptureBarrier();
      if (
        (pendingQueues.get(roomId)?.updates.length ?? 0) > 0 ||
        (roomAppliedUpdates.get(roomId) || 0) > (roomPersistedUpdates.get(roomId) || 0)
      ) {
        continue;
      }
    }

    // 4. Fetch the latest sequence in MongoDB
    const lastDoc = await DocUpdateModel.findOne({ roomId })
      .sort({ seq: -1, ts: -1, _id: -1 })
      .exec();
    currentSeq = lastDoc?.seq ?? 0;

    // 5. If new updates arrived while awaiting findOne, loop back
    if (
      (pendingQueues.get(roomId)?.updates.length ?? 0) > 0 ||
      (roomAppliedUpdates.get(roomId) || 0) > (roomPersistedUpdates.get(roomId) || 0)
    ) {
      continue;
    }

    // 6. ZERO ASYNC GAP: Synchronously encode document state at this exact sequence watermark
    fullDocState = Y.encodeStateAsUpdate(document);

    // 7. Verify immediately that no new update arrived
    if (
      (pendingQueues.get(roomId)?.updates.length ?? 0) > 0 ||
      (roomAppliedUpdates.get(roomId) || 0) > (roomPersistedUpdates.get(roomId) || 0)
    ) {
      continue;
    }

    if (snapshotTestingHooks.afterCaptureBarrier) {
      await snapshotTestingHooks.afterCaptureBarrier();
    }

    break;
  }

  // Deduplicate: skip if an equal or newer snapshot is already saved
  const lastSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
  if (!force && lastSnapshot && lastSnapshot.seq >= currentSeq) {
    return;
  }
  if (force && lastSnapshot && lastSnapshot.seq === currentSeq) {
    return;
  }

  await saveSnapshot(roomId, currentSeq, fullDocState, document);
}

/**
 * Extracts canonical document text for snapshots.
 * If canonical "code" is present in document.share, its text is returned
 * (even if intentionally empty "").
 * Only if "code" is completely absent from document.share does it fall back to legacy "monaco".
 */
export function extractCanonicalDocText(document: Y.Doc): string {
  if (document.share.has("code")) {
    return document.getText("code").toString();
  }
  if (document.share.has("monaco")) {
    return document.getText("monaco").toString();
  }
  return "";
}

/**
 * Migrates a legacy document that contains "monaco" but lacks canonical "code".
 * If canonical "code" is already present in document.share (even if empty), canonical "code"
 * takes precedence and no migration is performed.
 * If "monaco" exists in document.share and "code" does not exist in document.share,
 * the contents of "monaco" are copied into a newly initialized "code" field.
 */
export function migrateLegacyDocFields(document: Y.Doc): { migrated: boolean } {
  if (document.share.has("code")) {
    return { migrated: false };
  }
  if (document.share.has("monaco")) {
    const legacyText = document.getText("monaco").toString();
    const canonicalText = document.getText("code");
    if (legacyText.length > 0) {
      document.transact(() => {
        canonicalText.insert(0, legacyText);
      });
    }
    return { migrated: true };
  }
  return { migrated: false };
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
  const text = extractCanonicalDocText(document);

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

  const oldestPendingAgeMs = oldestTimestamp > 0 ? Math.max(0, now - oldestTimestamp) : 0;

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
  const allRoomIds = Array.from(
    new Set<string>([...pendingQueues.keys(), ...activeLoadedDocuments.keys()])
  );

  const failedRooms = new Set<string>();
  const roomDrainErrors = new Map<string, unknown>();

  // 5. Drain pending updates for all rooms independently (isolated failure)
  await Promise.allSettled(
    allRoomIds.map(async (roomId) => {
      try {
        await flushRoom(roomId, false);
      } catch (err) {
        failedRooms.add(roomId);
        roomDrainErrors.set(roomId, err);
      }
    })
  );

  // 6. Take final snapshots ONLY for rooms whose flush succeeded
  if (takeFinalSnapshots) {
    await Promise.allSettled(
      allRoomIds
        .filter((roomId) => !failedRooms.has(roomId))
        .map(async (roomId) => {
          const doc =
            activeLoadedDocuments.get(roomId) ?? pendingQueues.get(roomId)?.document;
          if (doc) {
            try {
              await takeSnapshot(roomId, doc, true);
            } catch (err) {
              failedRooms.add(roomId);
              roomDrainErrors.set(roomId, err);
            }
          }
        })
    );
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

  // 8. Verify no unconfirmed updates and surface errors honestly
  const stats = getPendingPersistenceStats();
  const totalErrors = [...inFlightErrors, ...Array.from(roomDrainErrors.values())];
  if (totalErrors.length > 0) {
    const primaryError =
      totalErrors[0] instanceof Error ? totalErrors[0].message : String(totalErrors[0]);
    const aggregate = new Error(
      `Persistence drain encountered failures in ${failedRooms.size} room(s): ${Array.from(failedRooms).join(", ")}. Primary error: ${primaryError}`
    );
    (
      aggregate as unknown as {
        roomErrors: Map<string, unknown>;
        failedRooms: string[];
      }
    ).roomErrors = roomDrainErrors;
    (
      aggregate as unknown as {
        roomErrors: Map<string, unknown>;
        failedRooms: string[];
      }
    ).failedRooms = Array.from(failedRooms);
    throw aggregate;
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
  clearAdmissionReservations();
  stopAllSnapshotIntervals();
  flushesCompleted = 0;
  flushFailures = 0;
  snapshotsSaved = 0;
  snapshotFailures = 0;
  inFlightUpdatesCount = 0;
  inFlightFlushes.clear();
  inFlightSnapshots.clear();
  inFlightUpdatesByRoom.clear();
  inFlightBytesByRoom.clear();
  roomAppliedUpdates.clear();
  roomPersistedUpdates.clear();
  snapshotTestingHooks.beforeCaptureBarrier = null;
  snapshotTestingHooks.afterCaptureBarrier = null;
  documentFinalizeHook = null;
}
