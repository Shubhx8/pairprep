import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { docUpdateRepo } from "../../repos/docUpdateRepo.js";

describe("DocUpdate Model & Repository (PRD PER-1, RP-1, CONC-2 & T03)", () => {
  beforeAll(async () => {
    await setupTestDb("doc_updates");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("doc_updates: repository exposes no update or delete methods and prevents modifying existing updates", () => {
    // Explicit assertion requested by user: proving absence of update and single delete methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((docUpdateRepo as any).updateOne).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((docUpdateRepo as any).deleteOne).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((docUpdateRepo as any).updateMany).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((docUpdateRepo as any).findByIdAndUpdate).toBeUndefined();
  });

  it("doc_updates: rejects duplicate (roomId, seq) updates", async () => {
    const roomId = "room-yjs-updates";
    await docUpdateRepo.appendUpdate({
      roomId,
      seq: 1,
      authorId: "user-1",
      update: Buffer.from("first-update-bytes"),
    });

    // Attempting to append a second update with the same (roomId, seq) must fail
    await expect(
      docUpdateRepo.appendUpdate({
        roomId,
        seq: 1,
        authorId: "user-2",
        update: Buffer.from("duplicate-seq-bytes"),
      })
    ).rejects.toThrow(/E11000 duplicate key error/);
  });

  it("doc_updates: appends updates and retrieves updates since given seq", async () => {
    const roomId = "room-yjs-retrieval";

    await docUpdateRepo.appendUpdate({
      roomId,
      seq: 1,
      authorId: "user-1",
      update: Buffer.from("update-1"),
    });
    await docUpdateRepo.appendUpdate({
      roomId,
      seq: 2,
      authorId: "user-2",
      update: Buffer.from("update-2"),
    });
    await docUpdateRepo.appendUpdate({
      roomId,
      seq: 3,
      authorId: "user-1",
      update: Buffer.from("update-3"),
    });

    const updatesSince1 = await docUpdateRepo.getUpdatesSince(roomId, 1);
    expect(updatesSince1.length).toBe(2);
    expect(updatesSince1[0]?.seq).toBe(2);
    expect(updatesSince1[1]?.seq).toBe(3);
  });
});
