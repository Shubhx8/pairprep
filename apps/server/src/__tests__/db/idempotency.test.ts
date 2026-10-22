import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { idempotencyRepo } from "../../repos/idempotencyRepo.js";
import { IdempotencyKeyModel } from "../../models/idempotency_keys.js";

describe("IdempotencyKey Model & Repository (PRD CONC-3 & AD-3)", () => {
  beforeAll(async () => {
    await setupTestDb("idempotency");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("idempotency: rejects duplicate (key, actorId, route) write within 24-hour window", async () => {
    const key = "idem-key-12345";
    const actorId = "user-actor-1";
    const route = "/api/v1/rooms";

    await idempotencyRepo.setKey({
      key,
      actorId,
      route,
      requestHash: "hash-payload-1",
      response: { status: 201, roomId: "room-abc" },
    });

    // Directly attempting to insert a second record with identical key, actorId, and route must fail
    const duplicateDoc = new IdempotencyKeyModel({
      key,
      actorId,
      route,
      requestHash: "hash-payload-2",
      response: { status: 200 },
    });

    await expect(duplicateDoc.save()).rejects.toThrow(/E11000 duplicate key error/);
  });

  it("idempotency: allows same key for different route or actor", async () => {
    const key = "shared-uuid-key";

    // Same key, different routes: allowed
    const r1 = await idempotencyRepo.setKey({
      key,
      actorId: "actor-1",
      route: "/api/v1/rooms",
      requestHash: "h1",
    });

    const r2 = await idempotencyRepo.setKey({
      key,
      actorId: "actor-1",
      route: "/api/v1/rooms/slug/submit",
      requestHash: "h2",
    });

    // Same key, different actors: allowed
    const r3 = await idempotencyRepo.setKey({
      key,
      actorId: "actor-2",
      route: "/api/v1/rooms",
      requestHash: "h3",
    });

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();
  });
});
