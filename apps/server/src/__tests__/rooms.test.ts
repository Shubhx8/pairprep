import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import app from "../index.js";
import { roomService } from "../services/roomService.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "./db/testDb.js";
import { userRepo } from "../repos/userRepo.js";
import { passport } from "../auth/passport.js";
import { authRateLimiter } from "../middleware/authRateLimiter.js";

describe("Room API Endpoints (PRD 6.1, 6.2, 13.1)", () => {
  beforeAll(async () => {
    await setupTestDb("api_rooms");
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
    roomService.reset();
  });

  async function getAuthenticatedAgent(profileData?: {
    displayName?: string;
    email?: string;
    avatarUrl?: string;
    provider?: "google" | "github";
  }) {
    authRateLimiter.resetKey("127.0.0.1");
    authRateLimiter.resetKey("::ffff:127.0.0.1");
    authRateLimiter.resetKey("::1");

    const user = await userRepo.upsertUser({
      provider: profileData?.provider || "google",
      providerId: `sub_${Date.now()}_${Math.random()}`,
      displayName: profileData?.displayName || "Test User",
      email: profileData?.email || `user_${Date.now()}_${Math.random()}@example.com`,
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

  describe("POST /api/v1/rooms (ROOM-1, CONC-3)", () => {
    it("creates a room with an unguessable 128-bit slug and owner member", async () => {
      const ownerAgent = await getAuthenticatedAgent({ displayName: "Meera" });
      const res = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "System Design Mock",
          type: "practice",
          language: "python",
          ownerName: "Meera",
        });

      expect(res.status).toBe(201);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.title).toBe("System Design Mock");
      expect(res.body.room.slug).toMatch(/^[a-f0-9]{32}$/); // 16 bytes = 32 hex chars (128 bits)
      expect(res.body.room.members).toHaveLength(1);
      expect(res.body.room.members[0].role).toBe("owner");
      expect(res.body.room.members[0].displayName).toBe("Meera");
      expect(res.body.currentMember.role).toBe("owner");
    });

    it("rejects invalid room creation payloads (Zod validation)", async () => {
      const ownerAgent = await getAuthenticatedAgent();
      const res = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "", // empty title forbidden
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });

    it("supports idempotent creation with x-idempotency-key (CONC-3)", async () => {
      const ownerAgent = await getAuthenticatedAgent();
      const payload = {
        title: "Idempotency Test",
        type: "practice",
        language: "javascript",
      };

      const res1 = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .set("x-idempotency-key", "idem-key-12345")
        .send(payload);

      const res2 = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .set("x-idempotency-key", "idem-key-12345")
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.room.id).toBe(res2.body.room.id);
      expect(res1.body.room.slug).toBe(res2.body.room.slug);
    });
  });

  describe("GET /api/v1/rooms/:slug (ROOM-2)", () => {
    it("fetches an existing room by slug", async () => {
      const ownerAgent = await getAuthenticatedAgent();
      const created = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "Graph Algorithms",
          language: "cpp",
        });

      const slug = created.body.room.slug;

      const res = await ownerAgent.get(`/api/v1/rooms/${slug}`);
      expect(res.status).toBe(200);
      expect(res.body.room.slug).toBe(slug);
      expect(res.body.room.title).toBe("Graph Algorithms");
    });

    it("returns 404 for non-existent room slug", async () => {
      const ownerAgent = await getAuthenticatedAgent();
      const res = await ownerAgent.get("/api/v1/rooms/non-existent-slug-xyz");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("ROOM_NOT_FOUND");
    });
  });

  describe("POST /api/v1/rooms/:slug/join (AUTH-3, ROOM-2, ROOM-4)", () => {
    // T05 (AUTH-3)
    it.skip("allows a guest to join a room with a display name and unique color", async () => {
      const created = await request(app)
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "Two Sum Practice",
        });
      const slug = created.body.room.slug;

      const joinRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Aarav Candidate" });

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.room.members).toHaveLength(2);
      expect(joinRes.body.currentMember.displayName).toBe("Aarav Candidate");
      expect(joinRes.body.currentMember.role).toBe("editor");
      expect(joinRes.body.currentMember.color).toBeDefined();
      expect(joinRes.body.currentMember.color).not.toBe(
        joinRes.body.room.members[0].color
      );
    });

    it("enforces PRD ROOM-4 max 6 participants limit", async () => {
      const ownerAgent = await getAuthenticatedAgent({ displayName: "Owner User" });
      const created = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "Six Participant Cap Room",
        });
      const slug = created.body.room.slug;

      // Owner is 1st participant. Add 5 more authenticated participants (total 6):
      for (let i = 1; i <= 5; i++) {
        const participantAgent = await getAuthenticatedAgent({
          displayName: `User ${i}`,
        });
        const res = await participantAgent
          .post(`/api/v1/rooms/${slug}/join`)
          .set("X-Requested-With", "pairprep")
          .send({ displayName: `User ${i}` });

        expect(res.status).toBe(200);
      }

      // 7th participant attempt must be rejected with 409 ROOM_FULL
      const overflowAgent = await getAuthenticatedAgent({
        displayName: "User 7 (Overflow)",
      });
      const overflowRes = await overflowAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "User 7 (Overflow)" });

      expect(overflowRes.status).toBe(409);
      expect(overflowRes.body.error).toBe("ROOM_FULL");
      expect(overflowRes.body.message).toContain("maximum of 6 participants");
    });
  });

  describe("Role Management & Lifecycle (ROOM-3, ROOM-6)", () => {
    it("allows owner to update participant roles", async () => {
      const ownerAgent = await getAuthenticatedAgent({ displayName: "Owner User" });
      const created = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Role Management Room" });

      const slug = created.body.room.slug;

      // Candidate joins
      const candidateAgent = await getAuthenticatedAgent({ displayName: "Student A" });
      const joined = await candidateAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Student A" });

      const memberId = joined.body.currentMember.id;

      // Owner promotes candidate to interviewer
      const updateRes = await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${memberId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "interviewer" });

      expect(updateRes.status).toBe(200);
      const updatedMember = updateRes.body.room.members.find(
        (m: { id: string }) => m.id === memberId
      );
      expect(updatedMember.role).toBe("interviewer");
    });

    it("rejects non-owner attempts to change roles with 403 Forbidden", async () => {
      const ownerAgent = await getAuthenticatedAgent({ displayName: "Owner User" });
      const created = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Security Room" });

      const slug = created.body.room.slug;

      // Intruder joins
      const intruderAgent = await getAuthenticatedAgent({ displayName: "Intruder" });
      const joined = await intruderAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Intruder" });

      const memberId = joined.body.currentMember.id;

      // Intruder attempts to promote themselves to owner
      const badRes = await intruderAgent
        .patch(`/api/v1/rooms/${slug}/members/${memberId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "owner" });

      expect(badRes.status).toBe(403);
      expect(badRes.body.error).toBe("FORBIDDEN");
    });

    it("allows owner to end a room (ROOM-6)", async () => {
      const ownerAgent = await getAuthenticatedAgent({ displayName: "Owner User" });
      const created = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Session Ending Room" });

      const slug = created.body.room.slug;

      const endRes = await ownerAgent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("X-Requested-With", "pairprep");

      expect(endRes.status).toBe(200);
      expect(endRes.body.room.status).toBe("ended");

      // Joining an ended room is rejected
      const lateAgent = await getAuthenticatedAgent({ displayName: "Late User" });
      const joinEnded = await lateAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Late User" });

      expect(joinEnded.status).toBe(403);
      expect(joinEnded.body.error).toBe("ROOM_CLOSED");
    });
  });

  describe("Unauthenticated Access Rejection (AUTH-4 / SEC-1)", () => {
    it("POST /api/v1/rooms with CSRF header returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Unauthenticated Room" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/v1/rooms/:slug returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app).get("/api/v1/rooms/nonexistent-slug");

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/rooms/:slug/join with CSRF header returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/v1/rooms/any-slug/join")
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Anon" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("PATCH /api/v1/rooms/:slug/members/:id with CSRF header returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app)
        .patch("/api/v1/rooms/any-slug/members/any-member")
        .set("X-Requested-With", "pairprep")
        .send({ role: "editor" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("DELETE /api/v1/rooms/:slug/members/:id with CSRF header returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app)
        .delete("/api/v1/rooms/any-slug/members/any-member")
        .set("X-Requested-With", "pairprep");

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/v1/rooms/:slug/end with CSRF header returns 401 UNAUTHORIZED when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/v1/rooms/any-slug/end")
        .set("X-Requested-With", "pairprep");

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });
  });
});
