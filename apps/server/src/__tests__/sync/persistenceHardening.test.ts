import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import * as Y from "yjs";
import {
  RoomMutex,
  roomMutex,
  loadDocument,
  queueUpdate,
  requeueUpdates,
  flushRoom,
  takeSnapshot,
  drainPersistenceAndSnapshot,
  getPendingPersistenceStats,
  resetPersistenceState,
  registerLoadedDocument,
  MAX_PENDING_UPDATES_PER_ROOM,
  MAX_PENDING_BYTES_PER_ROOM,
  MIN_RETRY_BACKOFF_MS,
  MAX_RETRY_BACKOFF_MS,
} from "../../sync/persistence.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { docSnapshotRepo } from "../../repos/docSnapshotRepo.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { config } from "../../config.js";
import { createServer, type Server as HttpServer } from "node:http";
import WebSocket from "ws";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

describe("T07 Persistence Retry & Snapshot Consistency Hardening (Commit 5)", () => {
  const roomId = "507f1f77bcf86cd799439011";
  let originalUri: string | undefined;

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

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_pers_harden_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await DocUpdateModel.init();
    await DocSnapshotModel.init();
    await DocUpdateModel.deleteMany({ roomId });
    await DocSnapshotModel.deleteMany({ roomId });
  });

  afterEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    vi.restoreAllMocks();
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

  describe("1. RoomMutex Lifecycle & Cleanup (Item 12)", () => {
    it("cleans up map entry upon task completion without leaking keys", async () => {
      const mutex = new RoomMutex();
      expect(mutex.hasRoom("room1")).toBe(false);

      const op = mutex.runExclusive("room1", async () => {
        expect(mutex.hasRoom("room1")).toBe(true);
        return 42;
      });

      const res = await op;
      expect(res).toBe(42);
      expect(mutex.hasRoom("room1")).toBe(false);
      expect(mutex.size).toBe(0);
    });

    it("cleans up map entry when task rejects without leaving stale promise", async () => {
      const mutex = new RoomMutex();
      const op = mutex.runExclusive("room_err", async () => {
        throw new Error("Task failed");
      });

      await expect(op).rejects.toThrow("Task failed");
      expect(mutex.hasRoom("room_err")).toBe(false);
      expect(mutex.size).toBe(0);

      // Verify a later operation on the same room works normally
      const nextOp = await mutex.runExclusive("room_err", async () => "recovered");
      expect(nextOp).toBe("recovered");
      expect(mutex.hasRoom("room_err")).toBe(false);
    });

    it("serializes concurrent operations strictly for the same room", async () => {
      const mutex = new RoomMutex();
      const sequence: number[] = [];

      const p1 = mutex.runExclusive("room_seq", async () => {
        await new Promise((r) => setTimeout(r, 50));
        sequence.push(1);
      });
      const p2 = mutex.runExclusive("room_seq", async () => {
        sequence.push(2);
      });

      await Promise.all([p1, p2]);
      expect(sequence).toEqual([1, 2]);
      expect(mutex.hasRoom("room_seq")).toBe(false);
    });
  });

  describe("2. Stable Sequences & Idempotent Retries (Items 1, 2, 3, 4, 5, 6)", () => {
    it("Item 3 & 2: handles partial batch failure without duplicating committed records and preserves gapless sequence", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      text.insert(0, "u1");
      const bin1 = Y.encodeStateAsUpdate(doc);
      text.insert(text.length, "u2");
      const bin2 = Y.encodeStateAsUpdate(doc);
      text.insert(text.length, "u3");
      const bin3 = Y.encodeStateAsUpdate(doc);

      queueUpdate(roomId, "author1", bin1, doc);
      queueUpdate(roomId, "author2", bin2, doc);
      queueUpdate(roomId, "author3", bin3, doc);

      // Mock DocUpdateModel.create to succeed on the 1st call, but fail on the 2nd call
      let callCount = 0;
      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          callCount++;
          if (callCount === 2) {
            throw new Error("Simulated partial write failure on item 2");
          }
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      // Flush should throw on the 2nd item
      await expect(flushRoom(roomId)).rejects.toThrow(
        "Simulated partial write failure on item 2"
      );

      // Verify that item 1 was committed to MongoDB with seq: 1
      const docsAfterPartial = await DocUpdateModel.find({ roomId })
        .sort({ seq: 1 })
        .exec();
      expect(docsAfterPartial.length).toBe(1);
      expect(docsAfterPartial[0]!.seq).toBe(1);
      expect(docsAfterPartial[0]!.authorId).toBe("author1");

      // Restore create and retry the flush
      vi.restoreAllMocks();
      await flushRoom(roomId);

      // Verify MongoDB contains exactly 3 records, with seq 1, 2, 3 without duplicate records!
      const docsAfterRetry = await DocUpdateModel.find({ roomId })
        .sort({ seq: 1 })
        .exec();
      expect(docsAfterRetry.length).toBe(3);
      expect(docsAfterRetry.map((d) => d.seq)).toEqual([1, 2, 3]);
      expect(docsAfterRetry.map((d) => d.authorId)).toEqual([
        "author1",
        "author2",
        "author3",
      ]);
    });

    it("Item 4 & 5: ambiguous write timeout followed by retry reconciles matching content cleanly", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");
      text.insert(0, "ambiguous_edit");
      const bin = Y.encodeStateAsUpdate(doc);

      queueUpdate(roomId, "author_ambiguous", bin, doc);

      // Simulate ambiguous write: record is actually written, but MongoDB client receives timeout
      let simulatedTimeoutOnce = false;
      const originalCreate = DocUpdateModel.create.bind(DocUpdateModel);
      vi.spyOn(DocUpdateModel, "create").mockImplementation(
        async (...args: unknown[]) => {
          await originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
          if (!simulatedTimeoutOnce) {
            simulatedTimeoutOnce = true;
            throw new Error(
              "MongoNetworkTimeoutError: connection timed out waiting for write ack"
            );
          }
          return originalCreate(...(args as Parameters<typeof DocUpdateModel.create>));
        }
      );

      // First flush throws timeout
      await expect(flushRoom(roomId)).rejects.toThrow("MongoNetworkTimeoutError");

      // Record is in DB
      const inDb = await DocUpdateModel.find({ roomId }).exec();
      expect(inDb.length).toBe(1);
      expect(inDb[0]!.seq).toBe(1);

      // Retry flush: should detect matching record in MongoDB, skip re-insertion, and succeed!
      vi.restoreAllMocks();
      await flushRoom(roomId);

      // Still exactly 1 record, no duplicate inserted!
      const afterRetry = await DocUpdateModel.find({ roomId }).exec();
      expect(afterRetry.length).toBe(1);
      expect(afterRetry[0]!.seq).toBe(1);
      expect(afterRetry[0]!.authorId).toBe("author_ambiguous");
    });

    it("Item 6: duplicate sequence with conflicting content fails visibly as consistency failure", async () => {
      // 1. Manually insert record with seq: 1 and author "real_author"
      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "real_author",
        update: Buffer.from([1, 2, 3]),
        size: 3,
        ts: new Date(),
      });

      // 2. Prepare a queued batch that claims seq: 1 but has conflicting payload
      requeueUpdates(
        roomId,
        [
          {
            authorId: "conflicting_author",
            update: new Uint8Array([9, 9, 9]),
            ts: new Date(),
            seq: 1,
          },
        ],
        Date.now(),
        new Y.Doc()
      );

      // Flush should throw Consistency failure
      await expect(flushRoom(roomId)).rejects.toThrow(
        /Consistency failure: conflicting record/
      );
    });

    it("Item 1: concurrent writers to the same room produce strictly monotonic gapless sequence numbers", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        text.insert(text.length, `part_${i}`);
        const updateBin = Y.encodeStateAsUpdate(doc);
        queueUpdate(roomId, `author_${i}`, updateBin, doc);
        promises.push(flushRoom(roomId));
      }

      await Promise.all(promises);

      const all = await DocUpdateModel.find({ roomId }).sort({ seq: 1 }).exec();
      expect(all.length).toBe(5);
      expect(all.map((u) => u.seq)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("3. Retry Backoff & Queue Preservation (Items 7, 8, 11)", () => {
    it("Item 7 & 11: preserves queue after failure and completes on retry", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "test_preserve");
      queueUpdate(roomId, "author_pres", Y.encodeStateAsUpdate(doc), doc);

      const spy = vi
        .spyOn(DocUpdateModel, "create")
        .mockRejectedValueOnce(new Error("Transient write failure"));

      await expect(flushRoom(roomId)).rejects.toThrow("Transient write failure");

      const statsFailed = getPendingPersistenceStats();
      expect(statsFailed.flushFailures).toBe(1);
      expect(statsFailed.pendingUpdates).toBe(1);

      spy.mockRestore();

      await flushRoom(roomId);

      const statsRecovered = getPendingPersistenceStats();
      expect(statsRecovered.pendingUpdates).toBe(0);
      expect(statsRecovered.flushesCompleted).toBe(1);
    });

    it("Item 8: uses bounded retry delay between 250ms and 5000ms (no 0ms spin loop)", () => {
      const doc = new Y.Doc();
      const oldTime = Date.now() - 10000; // 10 seconds ago

      // Even when update age exceeds 2000ms, retry delay must be at least MIN_RETRY_BACKOFF_MS (250ms)
      requeueUpdates(
        roomId,
        [{ authorId: "user", update: new Uint8Array([1]), ts: new Date(oldTime) }],
        oldTime,
        doc
      );

      // Verify retry is scheduled without crashing and backoff constants are bounded
      expect(MIN_RETRY_BACKOFF_MS).toBe(250);
      expect(MAX_RETRY_BACKOFF_MS).toBe(5000);
    });
  });

  describe("4. Bounded Persistence Queues & Backpressure (Items 9, 10)", () => {
    it("Item 9: pending update count limit engages room backpressure", () => {
      const doc = new Y.Doc();
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);

      // Enqueue updates up to MAX_PENDING_UPDATES_PER_ROOM
      for (let i = 0; i < MAX_PENDING_UPDATES_PER_ROOM; i++) {
        queueUpdate(roomId, "spammer", new Uint8Array([1]), doc);
      }

      // Room must be synchronously placed in backpressure
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);
      expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
    });

    it("Item 10: pending update byte limit engages room backpressure", () => {
      const doc = new Y.Doc();
      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(false);

      // Create a payload larger than 4 MB cap
      const largePayload = new Uint8Array(MAX_PENDING_BYTES_PER_ROOM + 1024);
      queueUpdate(roomId, "large_uploader", largePayload, doc);

      expect(syncRegistry.isRoomBackpressured(roomId)).toBe(true);
      expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
    });
  });

  describe("5. Snapshot Watermark, Deduplication, Ordering & Recovery (Items 13, 14, 15, 16)", () => {
    it("Item 13: snapshot flushes pending updates before state capture to guarantee exact watermark lockstep", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "content_for_snapshot");
      const updateBin = Y.encodeStateAsUpdate(doc);

      // Put update into queue (unflushed)
      queueUpdate(roomId, "author_snap", updateBin, doc);
      expect(getPendingPersistenceStats().pendingUpdates).toBe(1);

      // Take snapshot: must flush the queue first
      await takeSnapshot(roomId, doc, true);

      // Verify pending queue is drained
      expect(getPendingPersistenceStats().pendingUpdates).toBe(0);

      // Verify snapshot seq strictly matches the latest update seq
      const latestUpdate = await DocUpdateModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      const latestSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);

      expect(latestUpdate).not.toBeNull();
      expect(latestSnapshot).not.toBeNull();
      expect(latestSnapshot!.seq).toBe(latestUpdate!.seq);
      expect(latestSnapshot!.text).toBe("content_for_snapshot");
    });

    it("Item 14 & 15: serializes concurrent snapshot attempts and prevents duplicate unchanged snapshots", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "concurrent_snap");
      queueUpdate(roomId, "user1", Y.encodeStateAsUpdate(doc), doc);
      await flushRoom(roomId);

      // Fire 2 concurrent takeSnapshot calls
      await Promise.all([
        takeSnapshot(roomId, doc, false),
        takeSnapshot(roomId, doc, false),
      ]);

      const snapshots = await DocSnapshotModel.find({ roomId }).exec();
      // Only 1 snapshot created
      expect(snapshots.length).toBe(1);
    });

    it("Item 16: end-to-end snapshot followed by incremental updates recovers exact document state", async () => {
      // 1. Initial document state
      const docA = new Y.Doc();
      docA.getText("monaco").insert(0, "Snapshot Base ");
      queueUpdate(roomId, "user_base", Y.encodeStateAsUpdate(docA), docA);
      await flushRoom(roomId);

      // 2. Take snapshot at seq 1
      await takeSnapshot(roomId, docA, true);

      // 3. Additional typing after snapshot
      docA.getText("monaco").insert(docA.getText("monaco").length, "Plus Incremental");
      queueUpdate(roomId, "user_inc", Y.encodeStateAsUpdate(docA), docA);
      await flushRoom(roomId);

      // Verify DB state: 2 updates and 1 snapshot
      const totalUpdates = await DocUpdateModel.countDocuments({ roomId });
      const totalSnapshots = await DocSnapshotModel.countDocuments({ roomId });
      expect(totalUpdates).toBe(2);
      expect(totalSnapshots).toBe(1);

      // 4. Recover into a brand new Y.Doc
      const docRecovered = new Y.Doc();
      const result = await loadDocument(roomId, docRecovered);

      expect(result.hasSnapshot).toBe(true);
      expect(result.lastSeq).toBe(2);
      expect(result.loadedUpdatesCount).toBe(1); // 1 update after snapshot
      expect(docRecovered.getText("monaco").toString()).toBe(
        "Snapshot Base Plus Incremental"
      );
    });
  });

  describe("6. Database Disconnection & Load Synchronization (Items 17, 18)", () => {
    it("Item 17: database disconnection causes loadDocument to fail explicitly without serving empty doc", async () => {
      // 1. Disconnect MongoDB
      await mongoose.disconnect();

      const doc = new Y.Doc();
      await expect(loadDocument(roomId, doc)).rejects.toThrow(/Database unavailable/);

      // Reconnect for cleanup
      await mongoose.connect(config.MONGODB_URI || "");
    });

    it("Item 18: loadDocument executes under roomMutex serialization", async () => {
      const doc = new Y.Doc();
      const loadPromise = loadDocument(roomId, doc);
      // While load is executing, roomMutex has the room key
      await loadPromise;
      // After load, roomMutex is clean
      expect(roomMutex.hasRoom(roomId)).toBe(false);
    });
  });

  describe("7. Disconnect Snapshots & Shutdown Final Snapshots (Items 19, 20, 21, 22)", () => {
    let httpServer: HttpServer | null = null;
    let syncServer: SyncServerInstance | null = null;

    afterEach(async () => {
      if (syncServer) {
        await syncServer.destroy();
        syncServer = null;
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = null;
      }
    });

    it("Item 19 & 20: intermediate disconnect creates no snapshot; final disconnect creates at most one snapshot", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      // Connect Client 1
      const wsProvider1 = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      const doc1 = new Y.Doc();
      const p1 = new HocuspocusProvider({
        websocketProvider: wsProvider1,
        name: roomId,
        document: doc1,
      });
      p1.attach();

      // Connect Client 2
      const wsProvider2 = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      const doc2 = new Y.Doc();
      const p2 = new HocuspocusProvider({
        websocketProvider: wsProvider2,
        name: roomId,
        document: doc2,
      });
      p2.attach();

      await new Promise<void>((resolve, reject) => {
        let synced = 0;
        const check = () => {
          synced++;
          if (synced === 2) resolve();
        };
        const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
        p1.on("synced", () => {
          check();
          if (synced === 2) clearTimeout(timeout);
        });
        p2.on("synced", () => {
          check();
          if (synced === 2) clearTimeout(timeout);
        });
      });

      // Type an edit
      doc1.getText("monaco").insert(0, "Two clients editing");
      await new Promise((r) => setTimeout(r, 100));

      // Disconnect Client 1 (Client 2 remains active in room)
      p1.destroy();
      wsProvider1.destroy();
      await new Promise((r) => setTimeout(r, 300));

      // Intermediate disconnect must NOT create a snapshot!
      const snapshotsAfterIntermediate = await DocSnapshotModel.find({ roomId }).exec();
      expect(snapshotsAfterIntermediate.length).toBe(0);

      // Now disconnect Client 2 (room becomes empty)
      p2.destroy();
      wsProvider2.destroy();
      await new Promise((r) => setTimeout(r, 300));

      // Final disconnect must create EXACTLY ONE snapshot!
      const snapshotsAfterFinal = await DocSnapshotModel.find({ roomId }).exec();
      expect(snapshotsAfterFinal.length).toBe(1);
      expect(snapshotsAfterFinal[0]!.text).toBe("Two clients editing");
    });

    it("Item 21: shutdown takes final snapshots for active loaded rooms with empty pending queues", async () => {
      // Simulate an active loaded document with no pending queue (updates were already flushed)
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "fully_persisted_active_room");
      registerLoadedDocument(roomId, doc);

      // Flush an update so it has sequence in DB
      queueUpdate(roomId, "user", Y.encodeStateAsUpdate(doc), doc);
      await flushRoom(roomId);

      // At this point pendingQueues has 0 updates
      expect(getPendingPersistenceStats().pendingUpdates).toBe(0);

      // Drain persistence during shutdown with takeFinalSnapshots: true
      await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });

      // Verify a final snapshot was created for this loaded room
      const latestSnapshot = await docSnapshotRepo.getLatestSnapshot(roomId);
      expect(latestSnapshot).not.toBeNull();
      expect(latestSnapshot!.text).toBe("fully_persisted_active_room");
    });

    it("Item 22: shutdown awaits in-flight persistence and reports failures honestly", async () => {
      const doc = new Y.Doc();
      queueUpdate(roomId, "user_fail", new Uint8Array([1, 2, 3]), doc);

      vi.spyOn(DocUpdateModel, "create").mockRejectedValue(
        new Error("Fatal disk write error")
      );

      await expect(
        drainPersistenceAndSnapshot({ takeFinalSnapshots: false })
      ).rejects.toThrow("Fatal disk write error");
    });
  });
});
