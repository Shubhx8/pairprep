import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb } from "./testDb.js";
import {
  UserModel,
  GuestModel,
  RoomModel,
  RoomMemberModel,
  DocUpdateModel,
  DocSnapshotModel,
  MessageModel,
  ClientMapModel,
  EventModel,
  IdempotencyKeyModel,
} from "../../models/index.js";

describe("Database Models & Indexes (PRD Section 12 & T03)", () => {
  beforeAll(async () => {
    await setupTestDb("models");
  }, 15000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("indexes: verifies all 10 collections have expected compound and unique indexes in mongodb", async () => {
    const userIndexes = await UserModel.collection.indexes();
    expect(
      userIndexes.some(
        (idx) =>
          idx.key["provider"] === 1 && idx.key["providerId"] === 1 && idx.unique === true
      )
    ).toBe(true);

    const roomIndexes = await RoomModel.collection.indexes();
    expect(roomIndexes.some((idx) => idx.key["slug"] === 1 && idx.unique === true)).toBe(
      true
    );
    expect(
      roomIndexes.some((idx) => idx.key["ownerId"] === 1 && idx.key["createdAt"] === -1)
    ).toBe(true);

    const memberIndexes = await RoomMemberModel.collection.indexes();
    expect(
      memberIndexes.some(
        (idx) =>
          idx.key["roomId"] === 1 && idx.key["memberId"] === 1 && idx.unique === true
      )
    ).toBe(true);

    const docUpdateIndexes = await DocUpdateModel.collection.indexes();
    expect(
      docUpdateIndexes.some(
        (idx) => idx.key["roomId"] === 1 && idx.key["seq"] === 1 && idx.unique === true
      )
    ).toBe(true);

    const docSnapshotIndexes = await DocSnapshotModel.collection.indexes();
    expect(
      docSnapshotIndexes.some((idx) => idx.key["roomId"] === 1 && idx.key["seq"] === -1)
    ).toBe(true);

    const messageIndexes = await MessageModel.collection.indexes();
    expect(
      messageIndexes.some((idx) => idx.key["roomId"] === 1 && idx.key["ts"] === 1)
    ).toBe(true);

    const clientMapIndexes = await ClientMapModel.collection.indexes();
    expect(
      clientMapIndexes.some((idx) => idx.key["roomId"] === 1 && idx.key["clientId"] === 1)
    ).toBe(true);

    const eventIndexes = await EventModel.collection.indexes();
    expect(
      eventIndexes.some((idx) => idx.key["roomId"] === 1 && idx.key["ts"] === 1)
    ).toBe(true);

    const idempotencyIndexes = await IdempotencyKeyModel.collection.indexes();
    expect(
      idempotencyIndexes.some(
        (idx) =>
          idx.key["key"] === 1 &&
          idx.key["actorId"] === 1 &&
          idx.key["route"] === 1 &&
          idx.unique === true
      )
    ).toBe(true);
  });

  it("ttl: verifies guests collection has 7-day TTL index on expiresAt and idempotency_keys has 24h TTL index on createdAt", async () => {
    const guestIndexes = await GuestModel.collection.indexes();
    const guestTtlIndex = guestIndexes.find((idx) => idx.key["expiresAt"] === 1);
    expect(guestTtlIndex).toBeDefined();
    expect(guestTtlIndex?.expireAfterSeconds).toBe(0);

    const idempotencyIndexes = await IdempotencyKeyModel.collection.indexes();
    const idempotencyTtlIndex = idempotencyIndexes.find(
      (idx) => idx.key["createdAt"] === 1
    );
    expect(idempotencyTtlIndex).toBeDefined();
    expect(idempotencyTtlIndex?.expireAfterSeconds).toBe(86400); // 24 hours
  });
});
