import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import * as Y from "yjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCanonicalDocText,
  migrateLegacyDocFields,
  loadDocument,
  flushRoom,
  resetPersistenceState,
} from "../../sync/persistence.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { config } from "../../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("T08 Yjs Canonical Field Migration ('code' vs legacy 'monaco')", () => {
  describe("extractCanonicalDocText (Pure Unit Tests)", () => {
    it("returns 'code' field text when canonical 'code' field exists", () => {
      const doc = new Y.Doc();
      doc.getText("code").insert(0, "canonical python code");
      expect(extractCanonicalDocText(doc)).toBe("canonical python code");
    });

    it("Case 2: returns empty string when canonical 'code' field exists but is intentionally empty, ignoring legacy 'monaco'", () => {
      const doc = new Y.Doc();
      // Initialize both: monaco has text, code is intentionally empty
      doc.getText("monaco").insert(0, "legacy monaco text");
      doc.getText("code"); // creates "code" in doc.share with length 0

      expect(doc.share.has("code")).toBe(true);
      expect(doc.share.has("monaco")).toBe(true);

      // Must NOT fall back to "monaco" via truthiness
      expect(extractCanonicalDocText(doc)).toBe("");
    });

    it("Case 3: both fields exist with content, code wins over monaco", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "legacy monaco text");
      doc.getText("code").insert(0, "canonical code text");

      expect(doc.share.has("code")).toBe(true);
      expect(doc.share.has("monaco")).toBe(true);

      expect(extractCanonicalDocText(doc)).toBe("canonical code text");
    });

    it("falls back to legacy 'monaco' text only when 'code' is completely absent from doc.share", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "legacy text only");

      expect(doc.share.has("code")).toBe(false);
      expect(doc.share.has("monaco")).toBe(true);
      expect(extractCanonicalDocText(doc)).toBe("legacy text only");
    });

    it("returns empty string when neither field exists", () => {
      const doc = new Y.Doc();
      expect(extractCanonicalDocText(doc)).toBe("");
    });
  });

  describe("migrateLegacyDocFields (Pure Unit Tests)", () => {
    it("migrates legacy 'monaco' text into 'code' when 'code' is absent", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "const x = 42;");

      expect(doc.share.has("code")).toBe(false);
      const result = migrateLegacyDocFields(doc);

      expect(result.migrated).toBe(true);
      expect(doc.share.has("code")).toBe(true);
      expect(doc.getText("code").toString()).toBe("const x = 42;");
    });

    it("Case 2 unit: does not migrate or overwrite when canonical 'code' is already present and empty", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "stale legacy content");
      doc.getText("code"); // initialized as empty

      expect(doc.share.has("code")).toBe(true);
      const result = migrateLegacyDocFields(doc);

      expect(result.migrated).toBe(false);
      expect(doc.getText("code").toString()).toBe("");
    });

    it("Case 3 unit: does not migrate when both fields exist, canonical code wins", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "stale legacy content");
      doc.getText("code").insert(0, "active canonical code");

      const result = migrateLegacyDocFields(doc);
      expect(result.migrated).toBe(false);
      expect(doc.getText("code").toString()).toBe("active canonical code");
    });

    it("Case 4 unit: repeated recovery idempotency across sequential runs", () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "hello world");

      const res1 = migrateLegacyDocFields(doc);
      expect(res1.migrated).toBe(true);
      expect(doc.getText("code").toString()).toBe("hello world");

      const res2 = migrateLegacyDocFields(doc);
      expect(res2.migrated).toBe(false);
      expect(doc.getText("code").toString()).toBe("hello world");
    });
  });

  describe("Database Persistence & Lifecycle Gaps Integration", () => {
    const roomId = "507f1f77bcf86cd799439099";
    let originalUri: string | undefined;
    let testUri: string;

    beforeAll(async () => {
      originalUri = config.MONGODB_URI;
      const testDb = `pairprep_migr_test_${Date.now()}`;
      testUri = `mongodb://127.0.0.1:27017/${testDb}`;
      (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.disconnect();
        }
        await mongoose.connect(testUri, { serverSelectionTimeoutMS: 1000 });
      } catch {
        // If MongoDB is unavailable in test environment, DB-dependent tests skip cleanly
      }
    });

    afterAll(async () => {
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

    beforeEach(async () => {
      resetPersistenceState();
      syncRegistry.resetAll();
      if (mongoose.connection.readyState === 1) {
        await DocUpdateModel.deleteMany({ roomId });
        await DocSnapshotModel.deleteMany({ roomId });
      }
    });

    // Case A (Case 1): legacy-only document survives restart without forced snapshot (multi-process & in-process)
    it("Case A (Case 1): legacy-only document survives cold server restart without forced snapshot", async (ctx) => {
      if (mongoose.connection.readyState !== 1) {
        ctx.skip();
        return;
      }
      // 1. Seed legacy update in DB (only 'monaco' field, no snapshot)
      const legacyDoc = new Y.Doc();
      legacyDoc.getText("monaco").insert(0, "function solve() { return 42; }");
      const legacyUpdate = Y.encodeStateAsUpdate(legacyDoc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "legacy_user",
        update: Buffer.from(legacyUpdate),
        ts: new Date(),
        size: legacyUpdate.byteLength,
      });

      // 2. Load document through standard persistence pipeline
      const doc1 = new Y.Doc();
      const loadRes = await loadDocument(roomId, doc1);
      expect(loadRes.lastSeq).toBe(1);
      expect(doc1.getText("code").toString()).toBe("function solve() { return 42; }");

      // Flush persistence pipeline (normal debounce or graceful shutdown WITHOUT taking snapshot)
      await flushRoom(roomId, false);

      // Verify no snapshot was forced into DB
      const snapshotCount = await DocSnapshotModel.countDocuments({ roomId });
      expect(snapshotCount).toBe(0);

      // Verify migration update was durably written to DocUpdateModel
      const updateDocs = await DocUpdateModel.find({ roomId }).sort({ seq: 1 }).exec();
      expect(updateDocs.length).toBe(2);
      expect(updateDocs[1]!.seq).toBe(2);
      expect(updateDocs[1]!.authorId).toBe("system:migration");

      // 3. Real multi-process restart verification: spawn a fresh, isolated Node process running loadDocument
      // Proves cold restart durability across process boundaries with clean memory and modules.
      const childScript = `
        import mongoose from "mongoose";
        import * as Y from "yjs";
        import { loadDocument, extractCanonicalDocText } from "./src/sync/persistence.js";
        import { config } from "./src/config.js";

        config.MONGODB_URI = ${JSON.stringify(testUri)};
        await mongoose.connect(${JSON.stringify(testUri)}, { serverSelectionTimeoutMS: 2000 });

        const doc = new Y.Doc();
        const res = await loadDocument(${JSON.stringify(roomId)}, doc);
        await mongoose.disconnect();

        const codeText = doc.getText("code").toString();
        const canonical = extractCanonicalDocText(doc);
        console.log(JSON.stringify({ lastSeq: res.lastSeq, codeText, canonical, hasCode: doc.share.has("code") }));
      `;

      const serverDir = path.resolve(__dirname, "../../..");
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childScript],
        {
          cwd: serverDir,
          encoding: "utf-8",
          timeout: 10000,
        }
      );

      expect(child.status).toBe(0);
      const childResult = JSON.parse(child.stdout.trim().split("\n").pop()!);
      expect(childResult.lastSeq).toBe(2);
      expect(childResult.hasCode).toBe(true);
      expect(childResult.codeText).toBe("function solve() { return 42; }");
      expect(childResult.canonical).toBe("function solve() { return 42; }");

      // 4. In-process cold restart verification: clear memory queues, caches, and document handles
      resetPersistenceState();
      syncRegistry.resetAll();

      // 5. New server instance boots up and loads document from database
      const doc2 = new Y.Doc();
      const reloadRes = await loadDocument(roomId, doc2);
      expect(reloadRes.lastSeq).toBe(2);
      expect(doc2.share.has("code")).toBe(true);
      expect(doc2.getText("code").toString()).toBe("function solve() { return 42; }");
      expect(extractCanonicalDocText(doc2)).toBe("function solve() { return 42; }");

      // Verify still no snapshot was needed to preserve canonical code
      const finalSnapshotCount = await DocSnapshotModel.countDocuments({ roomId });
      expect(finalSnapshotCount).toBe(0);
    });

    // Case B (Case 2): intentionally empty canonical field wins from DB
    it("Case B (Case 2): intentionally empty canonical field loaded from DB wins over legacy content", async (ctx) => {
      if (mongoose.connection.readyState !== 1) {
        ctx.skip();
        return;
      }
      const initialDoc = new Y.Doc();
      initialDoc.getText("monaco").insert(0, "stale content");
      // Intentionally empty canonical field: insert and delete creates Yjs CRDT item with length 0
      initialDoc.getText("code").insert(0, "init");
      initialDoc.getText("code").delete(0, 4);
      const initialUpdate = Y.encodeStateAsUpdate(initialDoc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "user_a",
        update: Buffer.from(initialUpdate),
        ts: new Date(),
        size: initialUpdate.byteLength,
      });

      const loadedDoc = new Y.Doc();
      await loadDocument(roomId, loadedDoc);
      await flushRoom(roomId, false);

      expect(loadedDoc.getText("code").toString()).toBe("");
      expect(extractCanonicalDocText(loadedDoc)).toBe("");

      // Verify no migration update was written
      const updateCount = await DocUpdateModel.countDocuments({ roomId });
      expect(updateCount).toBe(1);
    });

    // Case C (Case 3): both fields exist in DB, canonical code text wins
    it("Case C (Case 3): both fields exist in DB, canonical code text wins", async (ctx) => {
      if (mongoose.connection.readyState !== 1) {
        ctx.skip();
        return;
      }
      const initialDoc = new Y.Doc();
      initialDoc.getText("monaco").insert(0, "legacy code");
      initialDoc.getText("code").insert(0, "authoritative code");
      const initialUpdate = Y.encodeStateAsUpdate(initialDoc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "user_a",
        update: Buffer.from(initialUpdate),
        ts: new Date(),
        size: initialUpdate.byteLength,
      });

      const loadedDoc = new Y.Doc();
      await loadDocument(roomId, loadedDoc);
      await flushRoom(roomId, false);

      expect(loadedDoc.getText("code").toString()).toBe("authoritative code");
      expect(extractCanonicalDocText(loadedDoc)).toBe("authoritative code");

      const updateCount = await DocUpdateModel.countDocuments({ roomId });
      expect(updateCount).toBe(1);
    });

    // Case D (Case 4): repeated recovery idempotency across reloads
    it("Case D (Case 4): repeated recovery idempotency does not accumulate updates or mutate doc", async (ctx) => {
      if (mongoose.connection.readyState !== 1) {
        ctx.skip();
        return;
      }
      const legacyDoc = new Y.Doc();
      legacyDoc.getText("monaco").insert(0, "idempotent test");
      const legacyUpdate = Y.encodeStateAsUpdate(legacyDoc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "user_a",
        update: Buffer.from(legacyUpdate),
        ts: new Date(),
        size: legacyUpdate.byteLength,
      });

      // Pass 1
      const doc1 = new Y.Doc();
      await loadDocument(roomId, doc1);
      await flushRoom(roomId, false);
      expect(await DocUpdateModel.countDocuments({ roomId })).toBe(2);

      // Pass 2 (cold restart)
      resetPersistenceState();
      const doc2 = new Y.Doc();
      await loadDocument(roomId, doc2);
      await flushRoom(roomId, false);
      expect(await DocUpdateModel.countDocuments({ roomId })).toBe(2);
      expect(doc2.getText("code").toString()).toBe("idempotent test");

      // Pass 3 (cold restart again)
      resetPersistenceState();
      const doc3 = new Y.Doc();
      await loadDocument(roomId, doc3);
      await flushRoom(roomId, false);
      expect(await DocUpdateModel.countDocuments({ roomId })).toBe(2);
      expect(doc3.getText("code").toString()).toBe("idempotent test");
    });

    // Case E (Case 5): read-only viewer cannot trigger migration write
    it("Case E (Case 5): read-only viewer loading legacy document cannot trigger migration write", async (ctx) => {
      if (mongoose.connection.readyState !== 1) {
        ctx.skip();
        return;
      }
      const legacyDoc = new Y.Doc();
      legacyDoc.getText("monaco").insert(0, "read only legacy code");
      const legacyUpdate = Y.encodeStateAsUpdate(legacyDoc);

      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "user_a",
        update: Buffer.from(legacyUpdate),
        ts: new Date(),
        size: legacyUpdate.byteLength,
      });

      // Viewer loads document with readOnly: true
      const viewerDoc = new Y.Doc();
      await loadDocument(roomId, viewerDoc, { readOnly: true });

      // In-memory doc can render migrated code for viewer preview
      expect(viewerDoc.getText("code").toString()).toBe("read only legacy code");

      // Flush persistence pipeline
      await flushRoom(roomId, false);

      // Assert ZERO new updates or snapshots written to DB
      const updateCount = await DocUpdateModel.countDocuments({ roomId });
      expect(updateCount).toBe(1);

      const snapshotCount = await DocSnapshotModel.countDocuments({ roomId });
      expect(snapshotCount).toBe(0);

      const seq2 = await DocUpdateModel.findOne({ roomId, seq: 2 }).exec();
      expect(seq2).toBeNull();
    });
  });
});
