import { describe, it, expect, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import * as Y from "yjs";
import {
  loadDocument,
  queueUpdate,
  flushRoom,
  saveSnapshot,
  resetPersistenceState,
  MAX_DOC_SIZE_BYTES,
  MAX_SNAPSHOTS_TO_KEEP,
} from "../../sync/persistence.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { config } from "../../config.js";

describe("T07 Persistence & Durability (PER-1)", () => {
  const roomId = "507f1f77bcf86cd799439011";
  let originalUri: string | undefined;

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_pers_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await DocUpdateModel.deleteMany({ roomId });
    await DocSnapshotModel.deleteMany({ roomId });
  });

  afterEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
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

  describe("loadDocument (Read-Only Safety)", () => {
    it("writes nothing to doc_updates or doc_snapshots during document load", async () => {
      // 1. Seed some updates
      const doc = new Y.Doc();
      const text = doc.getText("monaco");
      text.insert(0, "initial seed");
      const updateBin = Y.encodeStateAsUpdate(doc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "author_seed",
        update: Buffer.from(updateBin),
        size: updateBin.byteLength,
        ts: new Date(),
      });

      const updatesBefore = await DocUpdateModel.countDocuments({ roomId });
      const snapshotsBefore = await DocSnapshotModel.countDocuments({ roomId });

      // 2. Load document
      const loadedDoc = new Y.Doc();
      const result = await loadDocument(roomId, loadedDoc);

      const updatesAfter = await DocUpdateModel.countDocuments({ roomId });
      const snapshotsAfter = await DocSnapshotModel.countDocuments({ roomId });

      expect(updatesAfter).toBe(updatesBefore);
      expect(snapshotsAfter).toBe(snapshotsBefore);
      expect(result.loadedUpdatesCount).toBe(1);
      expect(result.lastSeq).toBe(1);
      expect(loadedDoc.getText("monaco").toString()).toBe("initial seed");
    });

    it("reconstructs document from snapshot plus subsequent updates", async () => {
      // 1. Base document in snapshot
      const baseDoc = new Y.Doc();
      baseDoc.getText("monaco").insert(0, "base text ");
      const snapshotBin = Y.encodeStateAsUpdate(baseDoc);

      await DocSnapshotModel.create({
        roomId,
        seq: 5,
        state: Buffer.from(snapshotBin),
        text: "base text ",
        ts: new Date(Date.now() - 10_000),
      });

      // 2. Additional update at seq 6
      const patchDoc = new Y.Doc();
      Y.applyUpdate(patchDoc, snapshotBin);
      patchDoc.getText("monaco").insert(patchDoc.getText("monaco").length, "added text");
      // Compute update from patchDoc diff
      const stateVector = Y.encodeStateVector(baseDoc);
      const diffUpdate = Y.encodeStateAsUpdate(patchDoc, stateVector);

      await DocUpdateModel.create({
        roomId,
        seq: 6,
        authorId: "author_patch",
        update: Buffer.from(diffUpdate),
        size: diffUpdate.byteLength,
        ts: new Date(),
      });

      // 3. Load
      const loadedDoc = new Y.Doc();
      const result = await loadDocument(roomId, loadedDoc);

      expect(result.hasSnapshot).toBe(true);
      expect(result.lastSeq).toBe(6);
      expect(result.loadedUpdatesCount).toBe(1);
      expect(loadedDoc.getText("monaco").toString()).toBe("base text added text");
    });
  });

  describe("Coalescence, Debounce & Strictly Increasing Sequences", () => {
    it("coalesces updates per author using Y.mergeUpdates and strictly increases seq under concurrent flushes", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      // Author A inserts 3 chars
      text.insert(0, "A1");
      const uA1 = Y.encodeStateAsUpdate(doc);
      text.insert(text.length, "A2");
      const uA2 = Y.encodeStateAsUpdate(doc);

      // Author B inserts 2 chars
      text.insert(text.length, "B1");
      const uB1 = Y.encodeStateAsUpdate(doc);

      queueUpdate(roomId, "author_A", uA1, doc);
      queueUpdate(roomId, "author_A", uA2, doc);
      queueUpdate(roomId, "author_B", uB1, doc);

      // Flush
      await flushRoom(roomId);

      const savedUpdates = await DocUpdateModel.find({ roomId }).sort({ seq: 1 }).exec();
      // Expect 2 coalesced updates: 1 for author_A (merged uA1+uA2), 1 for author_B
      expect(savedUpdates.length).toBe(2);
      expect(savedUpdates[0]!.seq).toBe(1);
      expect(savedUpdates[1]!.seq).toBe(2);
      expect(savedUpdates[0]!.authorId).toBe("author_A");
      expect(savedUpdates[1]!.authorId).toBe("author_B");

      // Concurrent flushes maintain strictly increasing sequence without gaps
      const concurrentPromises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        const dummyDoc = new Y.Doc();
        dummyDoc.getText("monaco").insert(0, `edit_${i}`);
        const bin = Y.encodeStateAsUpdate(dummyDoc);
        queueUpdate(roomId, `author_${i}`, bin, dummyDoc);
        concurrentPromises.push(flushRoom(roomId));
      }

      await Promise.all(concurrentPromises);

      const allUpdates = await DocUpdateModel.find({ roomId }).sort({ seq: 1 }).exec();
      const seqs = allUpdates.map((u) => u.seq);
      for (let i = 0; i < seqs.length; i++) {
        expect(seqs[i]).toBe(i + 1);
      }
    });
  });

  describe("Snapshot Pruning & 2 MB Document Cap", () => {
    it("keeps only the 3 latest snapshots and prunes older ones", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "snapshot test");
      const stateUpdate = Y.encodeStateAsUpdate(doc);

      // Save 5 snapshots
      for (let seq = 1; seq <= 5; seq++) {
        await saveSnapshot(roomId, seq, stateUpdate, doc);
      }

      const snapshots = await DocSnapshotModel.find({ roomId }).sort({ seq: 1 }).exec();
      expect(snapshots.length).toBe(MAX_SNAPSHOTS_TO_KEEP);
      const remainingSeqs = snapshots.map((s) => s.seq);
      expect(remainingSeqs).toEqual([3, 4, 5]); // Only 3 latest kept
    });

    it("enforces 2 MB document cap and sets room to read-only when exceeded", async () => {
      const doc = new Y.Doc();
      const text = doc.getText("monaco");

      // Insert large text to exceed 2 MB
      const largeChunk = "X".repeat(500_000);
      for (let i = 0; i < 5; i++) {
        text.insert(text.length, largeChunk);
      }

      const fullState = Y.encodeStateAsUpdate(doc);
      expect(fullState.byteLength).toBeGreaterThan(MAX_DOC_SIZE_BYTES);

      queueUpdate(roomId, "author_large", fullState, doc);

      expect(syncRegistry.isRoomReadOnly(roomId)).toBe(false);
      await flushRoom(roomId);

      // Room is now automatically set to read-only
      expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
    });
  });
});
