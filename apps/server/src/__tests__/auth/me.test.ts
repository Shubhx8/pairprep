import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { passport } from "../../auth/passport.js";

import { authRateLimiter } from "../../middleware/authRateLimiter.js";

describe("User Profile Endpoints (T04 / PRD 6.1 AUTH-5 / 13.1)", () => {
  beforeAll(async () => {
    await setupTestDb("auth_me");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.restoreAllMocks();
    authRateLimiter.resetKey("127.0.0.1");
    authRateLimiter.resetKey("::ffff:127.0.0.1");
    authRateLimiter.resetKey("::1");
  });

  async function getAuthenticatedAgent(profileData?: {
    displayName?: string;
    email?: string;
    avatarUrl?: string;
    provider?: "google" | "github";
  }) {
    const user = await userRepo.upsertUser({
      provider: profileData?.provider || "google",
      providerId: `sub_${Date.now()}_${Math.random()}`,
      displayName: profileData?.displayName || "Initial Name",
      email: profileData?.email || "user@example.com",
      avatarUrl: profileData?.avatarUrl,
    });

    vi.spyOn(passport, "authenticate").mockImplementation(
      (_strategy: unknown, optionsOrCallback?: unknown, callback?: unknown) => {
        const cb =
          typeof optionsOrCallback === "function"
            ? (optionsOrCallback as (err: unknown, user?: unknown) => void)
            : (callback as ((err: unknown, user?: unknown) => void) | undefined);
        return ((_req: Request, res: Response) => {
          if (cb) {
            cb(null, user);
          } else {
            res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?state=mock_state`);
          }
        }) as unknown as ReturnType<typeof passport.authenticate>;
      }
    );

    const agent = request.agent(app);
    await agent.get("/api/v1/auth/google");
    await agent.get(`/api/v1/auth/callback/google?code=mock_code&state=mock_state`);
    return agent;
  }

  it("me: GET /me returns 401 UNAUTHORIZED when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.body.error.message).toBe("Authentication required");
  });

  it("me: GET /me returns exact key set of UserPrivateDto without leaking internal fields", async () => {
    // 1. Without avatarUrl (avatarUrl must be absent)
    const agentNoAvatar = await getAuthenticatedAgent({
      displayName: "Rohan Sharma",
      email: "rohan@pairprep.test",
    });

    const resNoAvatar = await agentNoAvatar.get("/api/v1/me");

    expect(resNoAvatar.status).toBe(200);
    expect(resNoAvatar.headers["cache-control"]).toContain("no-store");
    expect(resNoAvatar.body.displayName).toBe("Rohan Sharma");
    expect(resNoAvatar.body.email).toBe("rohan@pairprep.test");
    expect(resNoAvatar.body.id).toBeDefined();
    expect(resNoAvatar.body.provider).toBe("google");
    expect(resNoAvatar.body.role).toBe("user");
    expect(resNoAvatar.body.createdAt).toBeDefined();

    // Exact key set assertion when avatarUrl is absent
    expect(Object.keys(resNoAvatar.body).sort()).toEqual([
      "createdAt",
      "displayName",
      "email",
      "id",
      "provider",
      "role",
    ]);

    // Ensure internal & sensitive fields are strictly not present
    expect("avatarUrl" in resNoAvatar.body).toBe(false);
    expect("providerId" in resNoAvatar.body).toBe(false);
    expect("disabled" in resNoAvatar.body).toBe(false);
    expect("lastLoginAt" in resNoAvatar.body).toBe(false);
    expect("_id" in resNoAvatar.body).toBe(false);
    expect("__v" in resNoAvatar.body).toBe(false);

    // 2. With avatarUrl
    const agentWithAvatar = await getAuthenticatedAgent({
      displayName: "Rohan Sharma",
      email: "rohan_avatar@pairprep.test",
      avatarUrl: "https://example.com/avatar.jpg",
    });

    const resWithAvatar = await agentWithAvatar.get("/api/v1/me");
    expect(resWithAvatar.status).toBe(200);
    expect(Object.keys(resWithAvatar.body).sort()).toEqual([
      "avatarUrl",
      "createdAt",
      "displayName",
      "email",
      "id",
      "provider",
      "role",
    ]);
    expect(resWithAvatar.body.avatarUrl).toBe("https://example.com/avatar.jpg");
    expect("providerId" in resWithAvatar.body).toBe(false);
    expect("disabled" in resWithAvatar.body).toBe(false);
    expect("lastLoginAt" in resWithAvatar.body).toBe(false);
    expect("_id" in resWithAvatar.body).toBe(false);
    expect("__v" in resWithAvatar.body).toBe(false);
  });

  it("me: PATCH /me successfully updates displayName within 1-40 characters", async () => {
    const agent = await getAuthenticatedAgent({
      displayName: "Original Name",
    });

    const res = await agent
      .patch("/api/v1/me")
      .set("X-Requested-With", "pairprep")
      .send({ displayName: "  Updated Name  " });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Updated Name");

    // Fetch GET /me to confirm persistence in database
    const verifyRes = await agent.get("/api/v1/me");
    expect(verifyRes.body.displayName).toBe("Updated Name");
  });

  it("me: PATCH /me strips control characters and rejects empty displayName", async () => {
    const agent = await getAuthenticatedAgent({
      displayName: "Valid User",
    });

    // 1. Name with null bytes and control/format characters: stripped via \p{Cc}\p{Cf}
    const resStripped = await agent
      .patch("/api/v1/me")
      .set("X-Requested-With", "pairprep")
      .send({ displayName: "Clean\u0000\u001FName\u200C" });

    expect(resStripped.status).toBe(200);
    expect(resStripped.body.displayName).toBe("CleanName");

    // 2. Pure whitespace or control characters only -> results in empty string after sanitization -> rejected 400
    const resEmpty = await agent
      .patch("/api/v1/me")
      .set("X-Requested-With", "pairprep")
      .send({ displayName: "   \u0000\u001F   " });

    expect(resEmpty.status).toBe(400);
    expect(resEmpty.body.error).toBeDefined();
    expect(resEmpty.body.error.code).toBe("VALIDATION_ERROR");

    // 3. Name exceeding 40 characters -> rejected 400
    const resTooLong = await agent
      .patch("/api/v1/me")
      .set("X-Requested-With", "pairprep")
      .send({ displayName: "A".repeat(41) });

    expect(resTooLong.status).toBe(400);
    expect(resTooLong.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("me: PATCH /me rejects unrecognized extraneous fields under strict Zod validation", async () => {
    const agent = await getAuthenticatedAgent({
      displayName: "Strict User",
    });

    const res = await agent.patch("/api/v1/me").set("X-Requested-With", "pairprep").send({
      displayName: "New Display Name",
      role: "owner-admin", // Malicious field injection attempt
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("me: PATCH /me rejects avatarUrl with 400 (display name only, AUTH-5)", async () => {
    const agent = await getAuthenticatedAgent({
      displayName: "Avatar User",
    });

    const res = await agent.patch("/api/v1/me").set("X-Requested-With", "pairprep").send({
      displayName: "Valid Name",
      avatarUrl: "https://example.com/custom-avatar.jpg",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
