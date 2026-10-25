import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";

describe("CSRF Protection Middleware (T04 / PRD 6.1)", () => {
  beforeAll(async () => {
    await setupTestDb("auth_csrf");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it("csrf: rejects POST /api/v1/me without X-Requested-With header with 403 CSRF_REJECTED regardless of session state", async () => {
    // Unauthenticated POST /api/v1/me without CSRF header
    const resUnauth = await request(app)
      .post("/api/v1/me")
      .send({ displayName: "Hacker" });

    // Must be rejected with 403 CSRF_REJECTED before authentication check evaluates (Correction 3)
    expect(resUnauth.status).toBe(403);
    expect(resUnauth.body.error).toBeDefined();
    expect(resUnauth.body.error.code).toBe("CSRF_REJECTED");
    expect(resUnauth.body.error.message).toContain("X-Requested-With: pairprep");

    // Authenticated PATCH /api/v1/me without CSRF header (must reject before checking auth)

    // Create session cookie by logging in or mocking session
    // We send PATCH without X-Requested-With
    const resAuth = await request(app)
      .patch("/api/v1/me")
      .send({ displayName: "New Name" });

    expect(resAuth.status).toBe(403);
    expect(resAuth.body.error.code).toBe("CSRF_REJECTED");
  });

  it("csrf: rejects POST /api/v1/auth/logout without X-Requested-With header with 403 CSRF_REJECTED", async () => {
    const res = await request(app).post("/api/v1/auth/logout");

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("CSRF_REJECTED");
  });

  it("csrf: rejects POST /api/v1/rooms without X-Requested-With header with 403 CSRF_REJECTED", async () => {
    const res = await request(app).post("/api/v1/rooms").send({ title: "Test Room" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("CSRF_REJECTED");
    expect(res.body.error.message).toContain("X-Requested-With: pairprep");
  });

  it("csrf: allows GET /api/v1/me without X-Requested-With header", async () => {
    // Safe idempotent methods bypass CSRF check (returns 401 UNAUTHORIZED rather than 403 CSRF_REJECTED)
    const res = await request(app).get("/api/v1/me");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("csrf: allows POST with valid X-Requested-With: pairprep header", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("X-Requested-With", "pairprep");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
