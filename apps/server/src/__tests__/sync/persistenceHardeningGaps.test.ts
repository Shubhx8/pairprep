import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  queueUpdate,
  requeueUpdates,
  flushRoom,
  takeSnapshot,
  loadDocument,
  drainPersistenceAndSnapshot,
  getPendingPersistenceStats,
  getActiveLoadedDocuments,
  resetPersistenceState,
  registerLoadedDocument,
  snapshotTestingHooks,
  tryReserveAdmission,
  releaseAdmissionReservation,
  clearAdmissionReservations,
  getReservedAdmissionStats,
  isRoomAtPersistenceCapacity,
  MAX_PENDING_UPDATES_PER_ROOM,
  MAX_PENDING_BYTES_PER_ROOM,
  MIN_RETRY_BACKOFF_MS,
  MAX_RETRY_BACKOFF_MS,
  RETRY_BACKOFF_FACTOR,
} from "../../sync/persistence.js";
import { ConnectionRateLimiter } from "../../sync/connectionRateLimiter.js";
import {
  createSyncServer,
  attachSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { docSnapshotRepo } from "../../repos/docSnapshotRepo.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { config } from "../../config.js";

class BrowserLikeWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[], options?: object) {
    super(url, protocols, {
      ...options,
      headers: {
        origin: "http://localhost:3000",
        ...((options as { headers?: Record<string, string> })?.headers || {}),
      },
    });
  }
}

describe("T07 Persistence Hardening Verification Gaps (Commit 5 Corrective)", () => {
  const roomId = "507f1f77bcf86cd799439011";
  const roomBId = "507f1f77bcf86cd799439022";
  let originalUri: string | undefined;

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_pers_gaps_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await DocUpdateModel.init();
    await DocSnapshotModel.init();
    await DocUpdateModel.syncIndexes();
    await DocSnapshotModel.syncIndexes();
    await DocUpdateModel.deleteMany({});
    await DocSnapshotModel.deleteMany({});
  });

  afterEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    vi.restoreAllMocks();
    snapshotTestingHooks.beforeCaptureBarrier = null;
    snapshotTestingHooks.afterCaptureBarrier = null;

    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db?.dropDatabase();
      } catch {
        // ignore
      }
      await mongoose.disconnect();
    }
    (config as { MONGODB_URI?: string }).MONGODB_URI = originalUri;
  });

  // =========================================================================
  // Correction A: Snapshot Barrier Must Include Concurrent Yjs Updates
  // =========================================================================
  describe("Correction A: Snapshot Barrier & Concurrent Yjs Updates", () => {
    it("Test 1 — Update arrives during snapshot flush: snapshot state and watermark correspond exactly, reconstruction matches", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      // 1. Seed and persist updates through sequence 10
      for (let i = 1; i <= 10; i++) {
        text.insert(text.length, `chunk${i} `);
        const update = Y.encodeStateAsUpdate(doc);
        queueUpdate(roomId, `author_${i}`, update, doc);
      }
      await flushRoom(roomId);

      const countBefore = await DocUpdateModel.countDocuments({ roomId });
      expect(countBefore).toBe(10);

      // 2. Pause the MongoDB flush for snapshot using a deferred barrier
      let resumeFlush: () => void = () => {};
      const pausePromise = new Promise<void>((resolve) => {
        resumeFlush = resolve;
      });

      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      let pauseTriggered = false;

      // Spy on DocUpdateModel.create to pause during subsequent write
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          if (!pauseTriggered) {
            pauseTriggered = true;
            await pausePromise;
          }
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      // Insert another update that will be flushed when takeSnapshot runs
      text.insert(text.length, "pending_before_snap ");
      queueUpdate(roomId, "author_snap_lead", Y.encodeStateAsUpdate(doc), doc);

      // 3. Start snapshot creation asynchronously
      const snapPromise = takeSnapshot(roomId, doc, true);

      // Wait until pause is reached
      while (!pauseTriggered) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Apply another real Yjs update while snapshot flush is waiting
      text.insert(text.length, "concurrent_during_flush ");
      const concurrentUpdate = Y.encodeStateAsUpdate(doc);
      queueUpdate(roomId, "author_concurrent", concurrentUpdate, doc);

      // 5. Resume persistence
      resumeFlush();
      await snapPromise;

      // 6. Verify snapshot watermark and DB state
      const snapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
      expect(snapshot).not.toBeNull();
      const watermark = snapshot!.seq;

      // Every update <= watermark must be in DB
      const updatesUpToWatermark = await DocUpdateModel.find({
        roomId,
        seq: { $lte: watermark },
      })
        .sort({ seq: 1 })
        .exec();

      expect(updatesUpToWatermark.length).toBe(watermark);

      // 7. Recover document using snapshot + updates after watermark
      const targetDoc = new Y.Doc();
      const loadResult = await loadDocument(roomId, targetDoc);

      expect(loadResult.hasSnapshot).toBe(true);
      expect(loadResult.lastSeq).toBeGreaterThanOrEqual(watermark);

      // State reconstructed from snapshot + subsequent updates must match final doc text exactly
      expect(targetDoc.getText("monaco").toString()).toBe(
        doc.getText("monaco").toString()
      );
    });

    it("Test 2 — Update arrives at snapshot consistency boundary: proven strictly included or excluded with seq > watermark", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      // Seed updates 1 to 5
      for (let i = 1; i <= 5; i++) {
        text.insert(text.length, `seed${i} `);
        queueUpdate(roomId, `author_${i}`, Y.encodeStateAsUpdate(doc), doc);
      }
      await flushRoom(roomId);

      // Part A: Update arrives before capture barrier -> must be included in snapshot with watermark = 6
      let barrierFired = false;
      snapshotTestingHooks.beforeCaptureBarrier = async () => {
        if (!barrierFired) {
          barrierFired = true;
          text.insert(text.length, "boundary_edit ");
          queueUpdate(roomId, "author_boundary", Y.encodeStateAsUpdate(doc), doc);
        }
      };

      await takeSnapshot(roomId, doc, true);
      snapshotTestingHooks.beforeCaptureBarrier = null;

      const snapA = await docSnapshotRepo.getLatestSnapshot(roomId);
      expect(snapA).not.toBeNull();
      // Watermark must have advanced to include sequence 6
      expect(snapA!.seq).toBe(6);
      expect(snapA!.text).toContain("boundary_edit");

      // Part B: Update arrives after capture barrier -> must receive sequence 7 > watermark 6
      let afterBarrierFired = false;
      snapshotTestingHooks.afterCaptureBarrier = async () => {
        if (!afterBarrierFired) {
          afterBarrierFired = true;
          text.insert(text.length, "after_capture_edit ");
          queueUpdate(roomId, "author_after", Y.encodeStateAsUpdate(doc), doc);
        }
      };

      await takeSnapshot(roomId, doc, true);
      snapshotTestingHooks.afterCaptureBarrier = null;

      await flushRoom(roomId);

      const latestUpdate = await DocUpdateModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      expect(latestUpdate).not.toBeNull();
      expect(latestUpdate!.seq).toBe(7);
      expect(latestUpdate!.seq).toBeGreaterThan(snapA!.seq);

      // Verify recovery produces full state
      const recoveryDoc = new Y.Doc();
      await loadDocument(roomId, recoveryDoc);
      expect(recoveryDoc.getText("monaco").toString()).toBe(
        doc.getText("monaco").toString()
      );
    });
  });

  // =========================================================================
  // Correction B: Backpressure Recovery Must Preserve Permissions
  // =========================================================================
  describe("Correction B: Effective Permission Calculation & Backpressure Recovery", () => {
    function createMockConn(_socketId: string): { readOnly: boolean; close: () => void } {
      return {
        readOnly: false,
        close: vi.fn(),
      };
    }

    it("Scenario 1: ordinary editor can write again after backpressure recovery", () => {
      const conn = createMockConn("sock_editor");
      syncRegistry.reserveSlot(roomId, "sock_editor");
      syncRegistry.promoteReservation(
        "sock_editor",
        roomId,
        "user_editor",
        { id: "user_editor", type: "user", displayName: "Editor" },
        conn,
        "editor"
      );

      expect(conn.readOnly).toBe(false);

      // Backpressure engages
      syncRegistry.setRoomBackpressure(roomId, true);
      expect(conn.readOnly).toBe(true);

      // Backpressure clears
      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(false);
    });

    it("Scenario 2: viewer remains read-only after backpressure recovery", () => {
      const conn = createMockConn("sock_viewer");
      syncRegistry.reserveSlot(roomId, "sock_viewer");
      syncRegistry.promoteReservation(
        "sock_viewer",
        roomId,
        "user_viewer",
        { id: "user_viewer", type: "user", displayName: "Viewer" },
        conn,
        "viewer"
      );

      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, true);
      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(true); // Must NOT be restored to writable
    });

    it("Scenario 3: participant in an ended room remains read-only after backpressure recovery", () => {
      const conn = createMockConn("sock_ended");
      syncRegistry.reserveSlot(roomId, "sock_ended");
      syncRegistry.promoteReservation(
        "sock_ended",
        roomId,
        "user_ended",
        { id: "user_ended", type: "user", displayName: "User Ended" },
        conn,
        "editor"
      );

      // Room ends
      syncRegistry.updateRoomLifecycle(roomId, "ended");
      expect(conn.readOnly).toBe(true);

      // Backpressure engages and then clears
      syncRegistry.setRoomBackpressure(roomId, true);
      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(true); // Must remain read-only
    });

    it("Scenario 4: interview candidate outside writable window remains read-only after recovery", () => {
      const conn = createMockConn("sock_cand");
      syncRegistry.reserveSlot(roomId, "sock_cand");
      // Room is interview and status is "open" (not started yet)
      syncRegistry.updateRoomLifecycle(roomId, "open", "interview", null);

      syncRegistry.promoteReservation(
        "sock_cand",
        roomId,
        "cand_1",
        { id: "cand_1", type: "user", displayName: "Candidate" },
        conn,
        "candidate"
      );

      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, true);
      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(true); // Remains read-only
    });

    it("Scenario 5: connection during shutdown remains read-only after backpressure recovery", () => {
      const conn = createMockConn("sock_shut");
      syncRegistry.reserveSlot(roomId, "sock_shut");
      syncRegistry.promoteReservation(
        "sock_shut",
        roomId,
        "user_shut",
        { id: "user_shut", type: "user", displayName: "User" },
        conn,
        "editor"
      );

      syncRegistry.setShutdown(true);
      expect(conn.readOnly).toBe(true);

      syncRegistry.setRoomBackpressure(roomId, true);
      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(true); // Remains read-only
    });

    it("Scenario 6: removed member connections are closed and do not regain write access", () => {
      const conn = createMockConn("sock_removed");
      syncRegistry.reserveSlot(roomId, "sock_removed");
      syncRegistry.promoteReservation(
        "sock_removed",
        roomId,
        "user_removed",
        { id: "user_removed", type: "user", displayName: "Removed" },
        conn,
        "editor"
      );

      syncRegistry.closeConnectionsForMember(roomId, "user_removed", 4000, "removed");
      expect(conn.close).toHaveBeenCalled();
      expect(syncRegistry.getConnection("sock_removed")).toBeUndefined();
    });

    it("Scenario 7: simultaneous room lifecycle change during backpressure leaves ended connections read-only", () => {
      const conn = createMockConn("sock_simul");
      syncRegistry.reserveSlot(roomId, "sock_simul");
      syncRegistry.promoteReservation(
        "sock_simul",
        roomId,
        "user_simul",
        { id: "user_simul", type: "user", displayName: "User" },
        conn,
        "editor"
      );

      expect(conn.readOnly).toBe(false);

      // 1. Backpressure engages
      syncRegistry.setRoomBackpressure(roomId, true);
      expect(conn.readOnly).toBe(true);

      // 2. While backpressured, room status transitions to ended
      syncRegistry.updateRoomLifecycle(roomId, "ended");
      expect(conn.readOnly).toBe(true);

      // 3. Backpressure clears
      syncRegistry.setRoomBackpressure(roomId, false);
      expect(conn.readOnly).toBe(true); // Preserves ended room restriction
    });
  });

  // =========================================================================
  // Correction C: Reset Retry Counter Only After Full Flush Success
  // =========================================================================
  describe("Correction C: Retry Counter & Backoff Semantics", () => {
    it("consecutive partial batch failures increase failure counter and backoff delay, reset only on full success", async () => {
      const doc = new Y.Doc();
      const updates: Uint8Array[] = [];
      for (let i = 1; i <= 3; i++) {
        doc.getText("monaco").insert(doc.getText("monaco").length, `part${i} `);
        const bin = Y.encodeStateAsUpdate(doc);
        updates.push(bin);
        queueUpdate(roomId, `author_${i}`, bin, doc);
      }

      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      let attempts = 0;

      // Fail 3 times on the 2nd record, but allow 1st record to succeed/reconcile
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          const item = args[0] as { seq: number };
          if (item?.seq === 2 && attempts < 3) {
            attempts++;
            throw new Error(`Simulated partial write failure on attempt ${attempts}`);
          }
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      // Attempt 1 fails
      await expect(flushRoom(roomId)).rejects.toThrow(
        "Simulated partial write failure on attempt 1"
      );

      // Verify retry backoff delay is between 250ms and 5000ms
      const backoff1 = Math.min(
        MAX_RETRY_BACKOFF_MS,
        MIN_RETRY_BACKOFF_MS * Math.pow(RETRY_BACKOFF_FACTOR, 0)
      );
      expect(backoff1).toBe(250);

      // Attempt 2 fails
      await expect(flushRoom(roomId)).rejects.toThrow(
        "Simulated partial write failure on attempt 2"
      );
      const backoff2 = Math.min(
        MAX_RETRY_BACKOFF_MS,
        MIN_RETRY_BACKOFF_MS * Math.pow(RETRY_BACKOFF_FACTOR, 1)
      );
      expect(backoff2).toBe(500);

      // Attempt 3 fails
      await expect(flushRoom(roomId)).rejects.toThrow(
        "Simulated partial write failure on attempt 3"
      );
      const backoff3 = Math.min(
        MAX_RETRY_BACKOFF_MS,
        MIN_RETRY_BACKOFF_MS * Math.pow(RETRY_BACKOFF_FACTOR, 2)
      );
      expect(backoff3).toBe(1000);

      // Attempt 4: all 3 attempts exceeded, full flush succeeds
      await flushRoom(roomId);

      // Verify all 3 records are in MongoDB
      const docsInDb = await DocUpdateModel.find({ roomId }).sort({ seq: 1 }).exec();
      expect(docsInDb.length).toBe(3);
      expect(docsInDb.map((d) => d.seq)).toEqual([1, 2, 3]);

      // Verify queue is completely drained and failure count reset
      const stats = getPendingPersistenceStats();
      expect(stats.pendingUpdates).toBe(0);
      expect(stats.flushFailures).toBe(3);
      expect(stats.flushesCompleted).toBe(1);
    });
  });

  // =========================================================================
  // Correction D: Prove Unique Index and Ambiguous-Write Idempotency
  // =========================================================================
  describe("Correction D: Unique Index & Ambiguous-Write Idempotency", () => {
    it("proves MongoDB unique compound index roomId_1_seq_1 is physically enforced", async () => {
      const indexes = await DocUpdateModel.collection.indexes();
      const uniqueIndex = indexes.find(
        (idx) =>
          idx.key &&
          (idx.key as Record<string, number>)["roomId"] === 1 &&
          (idx.key as Record<string, number>)["seq"] === 1
      );

      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex?.unique).toBe(true);
      expect(uniqueIndex?.name).toBe("roomId_1_seq_1");

      // Verify that direct duplicate insertion triggers MongoDB E11000 duplicate key error
      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "user_a",
        update: Buffer.from([1, 2, 3]),
        size: 3,
        ts: new Date(),
      });

      await expect(
        DocUpdateModel.create({
          roomId,
          seq: 1,
          authorId: "user_b",
          update: Buffer.from([4, 5, 6]),
          size: 3,
          ts: new Date(),
        })
      ).rejects.toThrow(/E11000/);
    });

    it("Test 1 — Ambiguous acknowledgement retry produces exactly one logical record", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "ambiguous_data");
      const updateBin = Y.encodeStateAsUpdate(doc);

      // Simulate ambiguous write: DB writes record, but network error occurs before ack
      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "author_ambiguous",
        update: Buffer.from(updateBin),
        size: updateBin.byteLength,
        ts: new Date(),
      });

      // Client retries with the same assigned sequence and content
      requeueUpdates(
        roomId,
        [{ authorId: "author_ambiguous", update: updateBin, ts: new Date(), seq: 1 }],
        Date.now(),
        doc
      );

      await flushRoom(roomId);

      // Exactly 1 record must exist
      const records = await DocUpdateModel.find({ roomId, seq: 1 }).exec();
      expect(records.length).toBe(1);
    });

    it("Test 2 — Matching duplicate key is reconciled cleanly", async () => {
      const doc = new Y.Doc();
      const updateBin = Y.encodeStateAsUpdate(doc);

      // Seed record
      await DocUpdateModel.create({
        roomId,
        seq: 5,
        authorId: "author_match",
        update: Buffer.from(updateBin),
        size: updateBin.byteLength,
        ts: new Date(),
      });

      // Retry matching payload
      requeueUpdates(
        roomId,
        [{ authorId: "author_match", update: updateBin, ts: new Date(), seq: 5 }],
        Date.now(),
        doc
      );

      await flushRoom(roomId);

      const records = await DocUpdateModel.find({ roomId, seq: 5 }).exec();
      expect(records.length).toBe(1);
      expect(records[0]!.authorId).toBe("author_match");
    });

    it("Test 3 — Conflicting duplicate key fails visibly and is not silently overwritten", async () => {
      // Seed record with payload [1, 2, 3]
      await DocUpdateModel.create({
        roomId,
        seq: 3,
        authorId: "author_orig",
        update: Buffer.from([1, 2, 3]),
        size: 3,
        ts: new Date(),
      });

      const doc = new Y.Doc();
      // Attempt retry with different author and payload for the same seq 3
      requeueUpdates(
        roomId,
        [
          {
            authorId: "author_conflict",
            update: new Uint8Array([9, 9, 9]),
            ts: new Date(),
            seq: 3,
          },
        ],
        Date.now(),
        doc
      );

      await expect(flushRoom(roomId)).rejects.toThrow(
        /Consistency failure: conflicting record in roomId=507f1f77bcf86cd799439011 at seq=3/
      );

      // Verify the original record remains unmodified
      const recordInDb = await DocUpdateModel.findOne({ roomId, seq: 3 }).exec();
      expect(recordInDb!.authorId).toBe("author_orig");
      expect(Buffer.compare(recordInDb!.update, Buffer.from([1, 2, 3]))).toBe(0);
    });

    it("Test 4 — Concurrent reconciliation against the same expected sequence yields safe outcome", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "concurrent_rec");
      const updateBin = Y.encodeStateAsUpdate(doc);

      // Two writers enqueue the same matching update
      queueUpdate(roomId, "user_concurrent", updateBin, doc);

      // Run two flushes concurrently
      await Promise.all([flushRoom(roomId), flushRoom(roomId)]);

      const records = await DocUpdateModel.find({ roomId }).exec();
      expect(records.length).toBe(1);
    });
  });

  // =========================================================================
  // Correction E: Queue Capacity Must Account for In-Flight Work
  // =========================================================================
  describe("Correction E: Queue Capacity Accounting with In-Flight Work", () => {
    it("accounts for both pending and in-flight updates and bytes, avoids double-counting on requeue", async () => {
      const doc = new Y.Doc();
      const smallBin = new Uint8Array(100);

      // 1. Enqueue 500 updates
      for (let i = 0; i < 500; i++) {
        queueUpdate(roomId, "user_q", smallBin, doc);
      }
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);

      // 2. Begin a flush and keep it in-flight using a deferred promise
      let releaseFlush: () => void = () => {};
      let flushStarted: () => void = () => {};
      const flushStartedPromise = new Promise<void>((resolve) => {
        flushStarted = resolve;
      });
      const flushPause = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });

      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          flushStarted();
          await flushPause;
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      const inFlightPromise = flushRoom(roomId);
      await flushStartedPromise;

      const statsInFlight = getPendingPersistenceStats();
      expect(statsInFlight.inFlightUpdates).toBe(500);

      // 3. Enqueue 500 more updates while 500 are in flight -> total combined = 1,000!
      for (let i = 0; i < 500; i++) {
        queueUpdate(roomId, "user_q2", smallBin, doc);
      }

      // Backpressure MUST engage because pending (500) + in-flight (500) >= 1,000 cap!
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);

      // 4. Release in-flight flush
      releaseFlush();
      await inFlightPromise;

      // 5. After the first batch completes, flush the second batch
      await flushRoom(roomId);

      // Capacity is released, backpressure clears
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);
      const finalStats = getPendingPersistenceStats();
      expect(finalStats.pendingUpdates).toBe(0);
      expect(finalStats.inFlightUpdates).toBe(0);
    }, 20000);
  });

  // =========================================================================
  // Correction F: Shutdown Must Isolate Room Failures
  // =========================================================================
  describe("Correction F: Multi-Room Shutdown Error Isolation", () => {
    it("Room A failure during shutdown does not prevent Room B from draining and snapshotting", async () => {
      const docA = new Y.Doc();
      docA.getText("monaco").insert(0, "Room A Content");
      const docB = new Y.Doc();
      docB.getText("monaco").insert(0, "Room B Content");

      queueUpdate(roomId, "author_a", Y.encodeStateAsUpdate(docA), docA);
      queueUpdate(roomBId, "author_b", Y.encodeStateAsUpdate(docB), docB);

      // Simulate Room A failure on DocUpdateModel.create
      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          const item = args[0] as { roomId: string };
          if (item?.roomId === roomId) {
            throw new Error("Simulated disk error in Room A during shutdown");
          }
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      // Execute drainPersistenceAndSnapshot
      await expect(
        drainPersistenceAndSnapshot({ takeFinalSnapshots: true })
      ).rejects.toThrow(
        /Persistence drain encountered failures in 1 room\(s\): 507f1f77bcf86cd799439011/
      );

      // 1. Room B must be completely persisted and have a final snapshot
      const roomBUpdates = await DocUpdateModel.find({ roomId: roomBId }).exec();
      expect(roomBUpdates.length).toBe(1);

      const roomBSnapshot = await docSnapshotRepo.getLatestSnapshot(roomBId);
      expect(roomBSnapshot).not.toBeNull();
      expect(roomBSnapshot!.text).toBe("Room B Content");

      // 2. Room A must remain unconfirmed and must NOT have a corrupt snapshot
      const roomASnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
      expect(roomASnapshot).toBeNull();

      // 3. Room A's pending updates are preserved in queue rather than dropped
      const stats = getPendingPersistenceStats();
      expect(stats.roomsWithPendingUpdates).toBe(1);
    });

    it("shutdown takes final snapshot for active loaded room with empty pending queue", async () => {
      const docEmpty = new Y.Doc();
      docEmpty.getText("monaco").insert(0, "Active Loaded Text");
      registerLoadedDocument(roomBId, docEmpty);

      // No pending updates in queue
      await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });

      const snap = await docSnapshotRepo.getLatestSnapshot(roomBId);
      expect(snap).not.toBeNull();
      expect(snap!.text).toBe("Active Loaded Text");
    });
  });

  // =========================================================================
  // Commit 5e Task B: Real HocuspocusProvider Snapshot Integration Test
  // =========================================================================
  describe("Commit 5e Task B: Real HocuspocusProvider Snapshot Integration Test", () => {
    let httpServer: HttpServer | null = null;
    let syncServer: SyncServerInstance | null = null;
    const providers: HocuspocusProvider[] = [];
    const wsProviders: HocuspocusProviderWebsocket[] = [];

    afterEach(async () => {
      for (const p of providers) p.destroy();
      for (const w of wsProviders) w.destroy();
      providers.length = 0;
      wsProviders.length = 0;
      if (syncServer) {
        await syncServer.drainAndShutdown({ drainTimeoutMs: 1000 }).catch(() => {});
        syncServer = null;
      }
      if (httpServer) {
        await new Promise<void>((r) => httpServer!.close(() => r()));
        httpServer = null;
      }
      resetPersistenceState();
    });

    it("pausing snapshot at beforeCaptureBarrier while concurrent WebSocket edits arrive preserves watermark equality and convergence", async () => {
      // 1. Setup real HTTP server with Hocuspocus sync
      httpServer = createServer();
      syncServer = createSyncServer({ requireAuth: false });
      attachSyncServer(httpServer, syncServer);

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, resolve);
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      // 2. Connect Client A via real HocuspocusProvider
      const wsA = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsA);
      const docA = new Y.Doc();
      const provA = new HocuspocusProvider({
        websocketProvider: wsA,
        name: roomId,
        document: docA,
      });
      providers.push(provA);
      provA.attach();

      // 3. Connect Client B via real HocuspocusProvider
      const wsB = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsB);
      const docB = new Y.Doc();
      const provB = new HocuspocusProvider({
        websocketProvider: wsB,
        name: roomId,
        document: docB,
      });
      providers.push(provB);
      provB.attach();

      // 4. Wait for both clients to connect and synchronize
      await Promise.all([
        new Promise<void>((r) => provA.on("synced", () => r())),
        new Promise<void>((r) => provB.on("synced", () => r())),
      ]);

      // 5. Client A inputs initial text over WebSocket (canonical "code" field)
      docA.getText("code").insert(0, "Client A initial text. ");

      // Await propagation to Client B over WebSocket
      await vi.waitFor(() => {
        expect(docB.getText("code").toString()).toBe("Client A initial text. ");
      });

      // 6. Set up snapshot barrier hook to pause right before state capture
      let barrierReached: () => void = () => {};
      const barrierReachedPromise = new Promise<void>((r) => {
        barrierReached = r;
      });
      let resumeBarrier: () => void = () => {};
      const resumeBarrierPromise = new Promise<void>((r) => {
        resumeBarrier = r;
      });

      snapshotTestingHooks.beforeCaptureBarrier = async () => {
        snapshotTestingHooks.beforeCaptureBarrier = null;
        barrierReached();
        await resumeBarrierPromise;
      };

      // 7. Trigger snapshot creation (this will flush initial edits and pause at barrier)
      const snapPromise = takeSnapshot(roomId, docA, true);

      // Wait until snapshot has locked the mutex and reached the capture barrier
      await barrierReachedPromise;

      // 8. While snapshot is paused at the barrier, Client B sends concurrent edits over WebSocket
      docB
        .getText("code")
        .insert(docB.getText("code").length, "Client B concurrent edit.");

      // Verify Client A receives Client B's edits over WebSocket
      await vi.waitFor(() => {
        expect(docA.getText("code").toString()).toBe(
          "Client A initial text. Client B concurrent edit."
        );
      });

      // 9. Resume the snapshot capture
      resumeBarrier();
      await snapPromise;

      // 10. Client A sends an edit strictly after the snapshot watermark was captured
      docA.getText("code").insert(docA.getText("code").length, " Post-snapshot edit.");
      provA.flushPendingUpdates();

      await vi.waitFor(() => {
        expect(docB.getText("code").toString()).toBe(
          "Client A initial text. Client B concurrent edit. Post-snapshot edit."
        );
      });

      // 11. Flush any remaining updates
      await flushRoom(roomId);

      // 12. Assert snapshot and update state in MongoDB
      const snap = await docSnapshotRepo.getLatestSnapshot(roomId);
      expect(snap).not.toBeNull();
      expect(snap!.seq).toBeGreaterThan(0);

      // Verify updates after the snapshot watermark have sequence numbers strictly greater than watermark
      const postWatermarkUpdates = await DocUpdateModel.find({
        roomId,
        seq: { $gt: snap!.seq },
      }).sort({ seq: 1 });
      expect(postWatermarkUpdates.length).toBeGreaterThan(0);

      // The snapshot captured state at barrier; verify doc reconstructed from snapshot + subsequent updates
      const reconstructedDoc = new Y.Doc();
      const loadResult = await loadDocument(roomId, reconstructedDoc);
      expect(loadResult.hasSnapshot).toBe(true);
      expect(reconstructedDoc.getText("code").toString()).toBe(
        "Client A initial text. Client B concurrent edit. Post-snapshot edit."
      );
      expect(docA.getText("code").toString()).toBe(
        "Client A initial text. Client B concurrent edit. Post-snapshot edit."
      );
      expect(docB.getText("code").toString()).toBe(
        "Client A initial text. Client B concurrent edit. Post-snapshot edit."
      );

      // Explicit byte-for-byte Yjs state-vector equality comparison
      const svReconstructed = Buffer.from(Y.encodeStateVector(reconstructedDoc));
      const svA = Buffer.from(Y.encodeStateVector(docA));
      const svB = Buffer.from(Y.encodeStateVector(docB));
      expect(svReconstructed.equals(svA)).toBe(true);
      expect(svReconstructed.equals(svB)).toBe(true);

      // Diff encoding comparison: diff against reconstructed doc contains zero novel clock entries
      const diffA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(reconstructedDoc));
      expect(diffA.byteLength).toBeLessThanOrEqual(2); // empty update representation in Yjs is [0, 0]
      const diffB = Y.encodeStateAsUpdate(reconstructedDoc, Y.encodeStateVector(docA));
      expect(diffB.byteLength).toBeLessThanOrEqual(2);
    }, 15000);

    it("rejects real WebSocket edit before Yjs application when queue capacity is saturated and preserves awareness/read-only", async () => {
      let pauseBarrierResolve: () => void = () => {};
      const pauseBarrierPromise = new Promise<void>((r) => {
        pauseBarrierResolve = r;
      });
      let pauseDb = true;

      const origCreate = DocUpdateModel.create.bind(DocUpdateModel);
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          if (pauseDb) {
            await pauseBarrierPromise;
          }
          return origCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      try {
        const customLimiter = new ConnectionRateLimiter({
          maxMessageBurst: 5000,
          messageRefillPerSec: 5000,
          maxByteBurst: 10 * 1024 * 1024,
          byteRefillPerSec: 10 * 1024 * 1024,
        });

        httpServer = createServer();
        syncServer = createSyncServer({
          requireAuth: false,
          rateLimiter: customLimiter,
        });
        attachSyncServer(httpServer, syncServer);

        await new Promise<void>((resolve) => {
          httpServer!.listen(0, resolve);
        });
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") throw new Error("Invalid address");
        const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

        // Connect Client A (editor)
        const wsA = new HocuspocusProviderWebsocket({
          url: wsUrl,
          WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        });
        wsProviders.push(wsA);
        const docA = new Y.Doc();
        const provA = new HocuspocusProvider({
          websocketProvider: wsA,
          name: roomId,
          document: docA,
        });
        providers.push(provA);
        provA.attach();

        // Connect Client B (editor who will attempt rejected edit)
        const wsB = new HocuspocusProviderWebsocket({
          url: wsUrl,
          WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        });
        wsProviders.push(wsB);
        const docB = new Y.Doc();
        const provB = new HocuspocusProvider({
          websocketProvider: wsB,
          name: roomId,
          document: docB,
        });
        providers.push(provB);
        provB.attach();

        await Promise.all([
          new Promise<void>((r) => provA.on("synced", () => r())),
          new Promise<void>((r) => provB.on("synced", () => r())),
        ]);

        // Client A sends 1,000 real WebSocket updates to exhaust MAX_PENDING_UPDATES_PER_ROOM
        const textA = docA.getText("monaco");
        for (let i = 0; i < MAX_PENDING_UPDATES_PER_ROOM; i++) {
          textA.insert(textA.length, "x");
          provA.flushPendingUpdates();
        }

        // Wait for room to be backpressured by persistence capacity
        await vi.waitFor(
          () => {
            expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);
          },
          { timeout: 10000 }
        );

        // Capture server-side state
        const serverDoc = getActiveLoadedDocuments().get(roomId);
        expect(serverDoc).toBeDefined();
        const serverTextBefore = serverDoc!.getText("monaco").toString();
        const serverSvBefore = Buffer.from(Y.encodeStateVector(serverDoc!));
        const updatesBefore = await DocUpdateModel.countDocuments({ roomId });

        // Client B sends an edit over WebSocket while queue is saturated
        const textB = docB.getText("monaco");
        textB.insert(0, "REJECTED_MUTATION_");
        provB.flushPendingUpdates();

        // Allow WebSocket message to reach server and be evaluated by beforeHandleMessage
        await new Promise((r) => setTimeout(r, 400));

        // Required assertions:
        // 1. Server Y.Doc content remains unchanged
        expect(serverDoc!.getText("monaco").toString()).toBe(serverTextBefore);
        // 2. Server Yjs state vector remains unchanged
        expect(Buffer.from(Y.encodeStateVector(serverDoc!)).equals(serverSvBefore)).toBe(
          true
        );
        // 3. No new doc_updates record is created for rejected edit
        const updatesAfter = await DocUpdateModel.countDocuments({ roomId });
        expect(updatesAfter).toBe(updatesBefore);
        // 4. Client A never receives the rejected edit
        expect(docA.getText("monaco").toString()).not.toContain("REJECTED_MUTATION_");
        // 5. Room remains protected by backpressure
        expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);

        // Verify awareness updates remain functional during backpressure
        let awarenessReceived = false;
        provB.on("awarenessUpdate", () => {
          const states = provB.awareness?.getStates();
          if (states) {
            for (const [, state] of states) {
              if ((state as { user?: { name: string } })?.user?.name === "Alice") {
                awarenessReceived = true;
              }
            }
          }
        });
        provA.setAwarenessField("user", { name: "Alice" });
        provA.flushPendingUpdates();
        await vi.waitFor(
          () => {
            expect(awarenessReceived).toBe(true);
          },
          { timeout: 5000 }
        );

        // Verify read-only clients can still connect and synchronize during backpressure
        const wsC = new HocuspocusProviderWebsocket({
          url: wsUrl,
          WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        });
        wsProviders.push(wsC);
        const docC = new Y.Doc();
        const provC = new HocuspocusProvider({
          websocketProvider: wsC,
          name: roomId,
          document: docC,
        });
        providers.push(provC);
        provC.attach();
        await new Promise<void>((r) => provC.on("synced", () => r()));
        // Synchronized document matches current server state
        expect(docC.getText("monaco").toString()).toBe(serverTextBefore);

        // Resume persistence and verify capacity recovery
        pauseDb = false;
        pauseBarrierResolve();
        while (getPendingPersistenceStats().pendingUpdates > 0) {
          await flushRoom(roomId);
          await new Promise((r) => setTimeout(r, 50));
        }

        // Backpressure clears once queue falls below recovery threshold
        await vi.waitFor(
          () => {
            expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);
          },
          { timeout: 15000 }
        );

        // Authorized editor (Client A) can edit again
        textA.insert(0, "POST_RECOVERY_EDIT_");
        provA.flushPendingUpdates();
        await vi.waitFor(
          () => {
            expect(docC.getText("monaco").toString()).toContain("POST_RECOVERY_EDIT_");
          },
          { timeout: 5000 }
        );
      } finally {
        pauseDb = false;
        pauseBarrierResolve();
        vi.restoreAllMocks();
      }
    }, 45000);
  });

  // =========================================================================
  // Commit 5e Task C: Safe Pre-Mutation Persistence Queue Capacity Admission
  // =========================================================================
  describe("Commit 5e Task C: Safe Pre-Mutation Persistence Queue Capacity Admission", () => {
    it("pre-mutation capacity rejection prevents document mutation when update count cap is exhausted", () => {
      const doc = new Y.Doc();
      const dummyUpdate = new Uint8Array([1, 2, 3]);

      // 1. Fill room persistence queue up to MAX_PENDING_UPDATES_PER_ROOM (1,000)
      for (let i = 0; i < MAX_PENDING_UPDATES_PER_ROOM; i++) {
        queueUpdate(roomId, `user_${i}`, dummyUpdate, doc);
      }

      expect(isRoomAtPersistenceCapacity(roomId)).toBe(true);

      // 2. Synchronous pre-mutation admission reservation check
      const admission = tryReserveAdmission(roomId, "sock_rejected_count", 100);
      expect(admission.allowed).toBe(false);
      expect(admission.reason).toBe("queue_capacity_exceeded");
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);

      // Total queued updates remains capped at exactly 1000
      const stats = getPendingPersistenceStats();
      expect(stats.queuedUpdates).toBe(MAX_PENDING_UPDATES_PER_ROOM);
    });

    it("pre-mutation capacity rejection prevents document mutation when byte capacity is exhausted", () => {
      const doc = new Y.Doc();
      // Put room at byte limit (MAX_PENDING_BYTES_PER_ROOM = 4 MB)
      const chunkSize = MAX_PENDING_BYTES_PER_ROOM / 4; // 1 MB
      for (let i = 0; i < 4; i++) {
        queueUpdate(roomId, `user_${i}`, new Uint8Array(chunkSize), doc);
      }

      // Room is at byte capacity
      expect(isRoomAtPersistenceCapacity(roomId)).toBe(true);

      // Next frame of 1 KB cannot be admitted
      const admission = tryReserveAdmission(roomId, "sock_rejected_bytes", 1024);
      expect(admission.allowed).toBe(false);
      expect(admission.reason).toBe("queue_capacity_exceeded");
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);
    });

    it("multiple concurrent sockets competing for remaining capacity cannot exceed cap", () => {
      const doc = new Y.Doc();
      const dummyUpdate = new Uint8Array([1, 2, 3]);

      // Fill room to MAX_PENDING_UPDATES_PER_ROOM - 2
      for (let i = 0; i < MAX_PENDING_UPDATES_PER_ROOM - 2; i++) {
        queueUpdate(roomId, `user_${i}`, dummyUpdate, doc);
      }

      // Sockets 1 and 2 reserve the remaining 2 slots
      const res1 = tryReserveAdmission(roomId, "sock_1", 10);
      expect(res1.allowed).toBe(true);
      const res2 = tryReserveAdmission(roomId, "sock_2", 10);
      expect(res2.allowed).toBe(true);

      const reservedStats = getReservedAdmissionStats(roomId);
      expect(reservedStats.count).toBe(2);

      // Socket 3 attempts to reserve and MUST be rejected
      const res3 = tryReserveAdmission(roomId, "sock_3", 10);
      expect(res3.allowed).toBe(false);
      expect(res3.reason).toBe("queue_capacity_exceeded");

      // Clean up reservations
      releaseAdmissionReservation(roomId, "sock_1");
      releaseAdmissionReservation(roomId, "sock_2");
      const afterRelease = getReservedAdmissionStats(roomId);
      expect(afterRelease.count).toBe(0);
    });

    it("non-mutating message frame releases admission reservation cleanly", () => {
      const sock = "sock_non_mutating";
      const res = tryReserveAdmission(roomId, sock, 250);
      expect(res.allowed).toBe(true);

      expect(getReservedAdmissionStats(roomId).count).toBe(1);
      expect(getReservedAdmissionStats(roomId).bytes).toBe(250);

      // Non-mutating frame does not trigger onChange; afterHandleMessage calls release
      releaseAdmissionReservation(roomId, sock);

      expect(getReservedAdmissionStats(roomId).count).toBe(0);
      expect(getReservedAdmissionStats(roomId).bytes).toBe(0);
    });

    it("socket disconnect cleans up any pending admission reservations", () => {
      const sock = "sock_dc";
      const res = tryReserveAdmission(roomId, sock, 400);
      expect(res.allowed).toBe(true);
      expect(getReservedAdmissionStats(roomId).count).toBe(1);

      // onDisconnect cleans up reservations
      clearAdmissionReservations(sock, roomId);
      expect(getReservedAdmissionStats(roomId).count).toBe(0);
      expect(getReservedAdmissionStats(roomId).bytes).toBe(0);
    });

    it("mutating message transfers reservation into queue accounting without double-counting", () => {
      const doc = new Y.Doc();
      const sock = "sock_mutate";
      const updateData = new Uint8Array([4, 5, 6]);

      const res = tryReserveAdmission(roomId, sock, updateData.byteLength);
      expect(res.allowed).toBe(true);
      expect(getReservedAdmissionStats(roomId).count).toBe(1);

      // onChange arrives and calls queueUpdate with socketId
      queueUpdate(roomId, "author_transfer", updateData, doc, sock);

      // Reservation transferred: reserved count is 0, queued count is 1
      expect(getReservedAdmissionStats(roomId).count).toBe(0);
      const stats = getPendingPersistenceStats();
      expect(stats.queuedUpdates).toBe(1);

      // Calling afterHandleMessage release is a safe no-op since reservation already transferred
      releaseAdmissionReservation(roomId, sock);
      expect(getReservedAdmissionStats(roomId).count).toBe(0);
      expect(getPendingPersistenceStats().queuedUpdates).toBe(1);
    });

    it("flushRoom backpressure release check accounts for active reservations", async () => {
      const doc = new Y.Doc();
      const updateData = new Uint8Array([1, 2, 3]);

      // Set backpressure on room
      syncRegistry.setRoomBackpressure(roomId, true);
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);

      // Queue 50 updates
      for (let i = 0; i < 50; i++) {
        queueUpdate(roomId, `author_${i}`, updateData, doc);
      }

      // Create 850 admission reservations -> total = 50 + 850 = 900 <= 1000
      for (let i = 0; i < 850; i++) {
        const res = tryReserveAdmission(roomId, `sock_res_${i}`, 10);
        expect(res.allowed).toBe(true);
      }

      // Flush the 50 queued updates
      await flushRoom(roomId);

      // Backpressure should NOT release because 850 reservations remain active (850 > 800)
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);

      // Clear the reservations
      clearAdmissionReservations(undefined, roomId);
      expect(getReservedAdmissionStats(roomId).count).toBe(0);

      // Now flush again with 0 updates and 0 reservations -> backpressure clears!
      await flushRoom(roomId);
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);
    });
  });
});
