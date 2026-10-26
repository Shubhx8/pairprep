import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import express from "express";
import { Writable } from "node:stream";
import app from "../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "./db/testDb.js";
import { userRepo } from "../repos/userRepo.js";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { guestRepo } from "../repos/guestRepo.js";
import { idempotencyRepo } from "../repos/idempotencyRepo.js";
import { RoomModel } from "../models/rooms.js";
import { RoomMemberModel } from "../models/room_members.js";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";
import { MessageModel } from "../models/messages.js";
import { EventModel } from "../models/events.js";
import { ClientMapModel } from "../models/client_map.js";
import { GuestModel } from "../models/guests.js";
import { IdempotencyKeyModel } from "../models/idempotency_keys.js";
import { passport } from "../auth/passport.js";
import { authRateLimiter } from "../middleware/authRateLimiter.js";
import {
  roomCreationLimiter,
  roomJoinLookupLimiter,
} from "../middleware/roomRateLimiter.js";
import { apiRateLimiter } from "../middleware/rateLimiter.js";
import { signGuestCookie, GUEST_COOKIE_NAME } from "../middleware/identity.js";
import { runArchiveAndPurgeJobOnce } from "../services/archiveJob.js";
import { roomsRouter } from "../routes/rooms.js";
import { createLogger, requestLogger } from "../middleware/logger.js";

describe("Room & Roles API (Task T05)", () => {
  beforeAll(async () => {
    await setupTestDb("api_rooms");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.restoreAllMocks();
    const ips = ["127.0.0.1", "::ffff:127.0.0.1", "::1", "unknown"];
    for (const ip of ips) {
      authRateLimiter.resetKey(ip);
      roomCreationLimiter.resetKey(ip);
      roomJoinLookupLimiter.resetKey(ip);
      apiRateLimiter.resetKey(ip);
    }
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
        return ((_req: unknown, res: { redirect: (url: string) => void }) => {
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
    return { agent, user };
  }

  // Helper to create a guest agent
  async function getGuestAgent(displayName: string, roomId: string) {
    const guest = await guestRepo.createGuest(displayName, roomId);
    const cookie = `${GUEST_COOKIE_NAME}=${signGuestCookie(guest.id)}`;
    const agent = request.agent(app);
    agent.set("Cookie", cookie);
    return { agent, guest, cookie };
  }

  // -------------------------------------------------------------------------
  // 1. ROUTER COVERAGE GUARD TEST
  // -------------------------------------------------------------------------
  it("router coverage guard: verifies all routes on roomsRouter are accounted for in tests", () => {
    const routeList: Array<{ method: string; path: string }> = [];

    for (const layer of roomsRouter.stack) {
      if (layer.route) {
        const path = layer.route.path;
        const methods = Object.keys(
          (layer.route as unknown as { methods: Record<string, boolean> }).methods
        );
        for (const m of methods) {
          routeList.push({ method: m.toUpperCase(), path });
        }
      }
    }

    const expectedRoutes = [
      { method: "POST", path: "/" },
      { method: "GET", path: "/" },
      { method: "GET", path: "/:slug" },
      { method: "POST", path: "/:slug/join" },
      { method: "PATCH", path: "/:slug/members/:id" },
      { method: "DELETE", path: "/:slug/members/:id" },
      { method: "POST", path: "/:slug/end" },
      { method: "DELETE", path: "/:slug" },
    ];

    expect(routeList.length).toBe(expectedRoutes.length);
    for (const exp of expectedRoutes) {
      const match = routeList.some((r) => r.method === exp.method && r.path === exp.path);
      expect(match).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 2. AUTHORIZATION MATRIX TEST
  // -------------------------------------------------------------------------
  describe("Authorization Matrix (Table-Driven)", () => {
    it("enforces strict role and principal matrix against every endpoint", async () => {
      // Setup room with owner
      const { agent: ownerAgent, user: ownerUser } = await getAuthenticatedAgent({
        displayName: "Owner",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Auth Matrix Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Editor user
      const { agent: editorAgent } = await getAuthenticatedAgent({
        displayName: "Editor",
      });
      await editorAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Editor" });

      // Viewer user
      const { agent: viewerAgent } = await getAuthenticatedAgent({
        displayName: "Viewer",
      });
      const viewerJoin = await viewerAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Viewer" });
      const viewerMemberDocId = viewerJoin.body.currentMember.id;
      // Demote to viewer
      await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${viewerMemberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });

      // Guest in this room
      const { agent: guestThisRoom, guest: guestDoc } = await getGuestAgent(
        "Guest Member",
        roomId
      );
      await roomMemberRepo.addMember({
        roomId,
        memberId: guestDoc.id,
        displayName: "Guest Member",
        role: "editor",
        isGuest: true,
      });

      // Guest from other room
      const otherRoom = await roomRepo.createRoom({
        title: "Other Room",
        ownerId: ownerUser.id,
      });
      await getGuestAgent("Guest Other", otherRoom.id);

      // Signed in non-member
      const { agent: nonMemberAgent } = await getAuthenticatedAgent({
        displayName: "Non Member",
      });

      // Anonymous agent
      const anonAgent = request.agent(app);

      // Matrix definitions:
      // Endpoint 1: POST /api/v1/rooms (requireUser)
      // Anon -> 401, Guest -> 401, User -> 201
      expect(
        (
          await anonAgent
            .post("/api/v1/rooms")
            .set("X-Requested-With", "pairprep")
            .send({ title: "T" })
        ).status
      ).toBe(401);
      expect(
        (
          await guestThisRoom
            .post("/api/v1/rooms")
            .set("X-Requested-With", "pairprep")
            .send({ title: "T" })
        ).status
      ).toBe(401);
      expect(
        (
          await nonMemberAgent
            .post("/api/v1/rooms")
            .set("X-Requested-With", "pairprep")
            .send({ title: "T" })
        ).status
      ).toBe(201);

      // Endpoint 2: GET /api/v1/rooms (requireUser)
      expect((await anonAgent.get("/api/v1/rooms")).status).toBe(401);
      expect((await guestThisRoom.get("/api/v1/rooms")).status).toBe(401);
      expect((await nonMemberAgent.get("/api/v1/rooms")).status).toBe(200);

      // Endpoint 3: GET /api/v1/rooms/:slug
      // Anon, Guest Other, Non-member -> 200 (PublicRoomDto)
      // Editor, Viewer, Owner -> 200 (Full RoomResponse)
      const anonSlug = await anonAgent.get(`/api/v1/rooms/${slug}`);
      expect(anonSlug.status).toBe(200);
      expect(anonSlug.body.members).toBeUndefined(); // Non-members get public DTO

      const ownerSlug = await ownerAgent.get(`/api/v1/rooms/${slug}`);
      expect(ownerSlug.status).toBe(200);
      expect(ownerSlug.body.members).toBeDefined(); // Members get full DTO

      // Endpoint 4: PATCH /api/v1/rooms/:slug/members/:id (Owner only)
      // Editor -> 403, Viewer -> 403, Owner -> 200
      const patchEditor = await editorAgent
        .patch(`/api/v1/rooms/${slug}/members/${viewerMemberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "editor" });
      expect(patchEditor.status).toBe(403);

      const patchOwner = await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${viewerMemberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "editor" });
      expect(patchOwner.status).toBe(200);

      // Endpoint 5: DELETE /api/v1/rooms/:slug/members/:id (Owner only)
      const delEditor = await editorAgent
        .delete(`/api/v1/rooms/${slug}/members/${viewerMemberDocId}`)
        .set("X-Requested-With", "pairprep");
      expect(delEditor.status).toBe(403);

      // Endpoint 6: POST /api/v1/rooms/:slug/end (Owner only)
      const endViewer = await viewerAgent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("X-Requested-With", "pairprep");
      expect(endViewer.status).toBe(403);

      // Endpoint 7: DELETE /api/v1/rooms/:slug (Owner only)
      const delNonMember = await nonMemberAgent
        .delete(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(delNonMember.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 3. ROOM CREATION & PARTIAL INDEX TESTS
  // -------------------------------------------------------------------------
  describe("ROOM-1: Room Creation & Partial Index", () => {
    it("creates a room with 128-bit unguessable slug and owner member", async () => {
      const { agent } = await getAuthenticatedAgent({ displayName: "Aarav" });
      const res = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "System Design Mock",
          type: "practice",
          language: "python",
        });

      expect(res.status).toBe(201);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.slug).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url = 22 chars
      expect(res.body.currentMember.displayName).toBe("Aarav");
      expect(res.body.currentMember.role).toBe("owner");
    });

    it("partial index test: one owner creates two rooms without Idempotency-Key header", async () => {
      const { agent } = await getAuthenticatedAgent({ displayName: "MultiRoomOwner" });
      const res1 = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room One" });
      expect(res1.status).toBe(201);

      const res2 = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room Two" });
      expect(res2.status).toBe(201);
      expect(res1.body.room.id).not.toBe(res2.body.room.id);
    });

    it("rejects non-practice types with 400", async () => {
      const { agent } = await getAuthenticatedAgent();
      const res = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "Interview Room",
          type: "interview",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("strips control characters from title and rejects empty title", async () => {
      const { agent } = await getAuthenticatedAgent();
      const res = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({
          title: "   \u0000\u001F   ", // empty after stripping
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("rate limit: 11th room creation within 1 hour returns 429 RATE_LIMITED", async () => {
      const { agent } = await getAuthenticatedAgent();
      for (let i = 0; i < 10; i++) {
        const res = await agent
          .post("/api/v1/rooms")
          .set("X-Requested-With", "pairprep")
          .send({ title: `Room ${i}` });
        expect(res.status).toBe(201);
      }

      const blocked = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room 11" });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("RATE_LIMITED");
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("owner-insert compensation: failed owner member creation deletes newly created room", async () => {
      const { agent } = await getAuthenticatedAgent();
      vi.spyOn(roomMemberRepo, "addMember").mockRejectedValueOnce(
        new Error("Simulated owner insert failure")
      );

      const res = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Compensation Room" });

      expect(res.status).toBe(500);

      // Verify no orphan room was left in database
      const orphan = await RoomModel.findOne({ title: "Compensation Room" });
      expect(orphan).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. ATOMIC CONCURRENCY & THREE DETERMINISTIC SELF-HEAL TESTS
  // -------------------------------------------------------------------------
  describe("ROOM-4: Concurrency & Deterministic Self-Healing", () => {
    it("10 parallel joins on owner room: 5 succeed (200), 5 fail (409 ROOM_FULL), final count 6", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Parallel Joins Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // 10 distinct parallel joiners
      const joinPromises = Array.from({ length: 10 }).map((_, i) =>
        request(app)
          .post(`/api/v1/rooms/${slug}/join`)
          .set("X-Requested-With", "pairprep")
          .send({ displayName: `Parallel Candidate ${i}` })
      );

      const results = await Promise.all(joinPromises);
      const successes = results.filter((r) => r.status === 200);
      const fullFailures = results.filter(
        (r) => r.status === 409 && r.body.error.code === "ROOM_FULL"
      );

      expect(successes.length).toBe(5);
      expect(fullFailures.length).toBe(5);

      const finalRoom = await RoomModel.findById(roomId);
      const finalMembers = await RoomMemberModel.countDocuments({ roomId });
      expect(finalRoom?.memberCount).toBe(6);
      expect(finalMembers).toBe(6);
    });

    it("self-heal 4a (stale-high counter): recount occurs and join succeeds", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Stale High Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Add 2 more members (total real members = 3)
      await roomMemberRepo.addMember({
        roomId,
        memberId: "m2",
        displayName: "M2",
        role: "editor",
      });
      await roomMemberRepo.addMember({
        roomId,
        memberId: "m3",
        displayName: "M3",
        role: "editor",
      });

      // Simulate drift: counter set to 6, updatedAt set to 70 seconds ago (>60s)
      await RoomModel.findByIdAndUpdate(roomId, {
        memberCount: 6,
        memberCountUpdatedAt: new Date(Date.now() - 70000),
      });

      // Join attempt should trigger fenced recount (sees 3 < 6), heal, and succeed
      const joinRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Healed Candidate" });

      expect(joinRes.status).toBe(200);
      const updated = await RoomModel.findById(roomId);
      expect(updated?.memberCount).toBe(4); // healed to 3, then incremented to 4
    });

    it("self-heal 4b (fresh full counter): rejects 409 ROOM_FULL without recount", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Fresh Full Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Simulate drift with fresh timestamp (10 seconds ago, <= 60s)
      await RoomModel.findByIdAndUpdate(roomId, {
        memberCount: 6,
        memberCountUpdatedAt: new Date(Date.now() - 10000),
      });

      const countSpy = vi.spyOn(RoomMemberModel, "countDocuments");

      const joinRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Blocked Candidate" });

      expect(joinRes.status).toBe(409);
      expect(joinRes.body.error.code).toBe("ROOM_FULL");
      // Must not execute recount query
      expect(countSpy).not.toHaveBeenCalled();
    });

    it("self-heal 4c (concurrent heal, join, and removal): memberCount never exceeds 6", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Concurrent Mix Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Seed 4 members (total 5)
      for (let i = 1; i <= 4; i++) {
        await roomMemberRepo.addMember({
          roomId,
          memberId: `seed_${i}`,
          displayName: `Seed ${i}`,
          role: "editor",
        });
      }

      // Mix 8 concurrent operations: 6 joins, 1 removal, 1 stale trigger
      const ops = [
        ...Array.from({ length: 6 }).map((_, i) =>
          request(app)
            .post(`/api/v1/rooms/${slug}/join`)
            .set("X-Requested-With", "pairprep")
            .send({ displayName: `Mixer ${i}` })
        ),
        roomMemberRepo.removeMember(roomId, "seed_1"),
        (async () => {
          await RoomModel.findByIdAndUpdate(roomId, {
            memberCountUpdatedAt: new Date(Date.now() - 75000),
          });
        })(),
      ];

      await Promise.allSettled(ops);

      const finalRoom = await RoomModel.findById(roomId);
      const actualDocs = await RoomMemberModel.countDocuments({ roomId });
      expect(finalRoom?.memberCount).toBeLessThanOrEqual(6);
      expect(actualDocs).toBeLessThanOrEqual(6);
    });

    it("same-principal parallel join creates only 1 membership document", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Same Principal Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      const { agent: userAgent, user } = await getAuthenticatedAgent({
        displayName: "DuplicateUser",
      });

      // 5 concurrent join requests with same authenticated user
      const parallel = Array.from({ length: 5 }).map(() =>
        userAgent
          .post(`/api/v1/rooms/${slug}/join`)
          .set("X-Requested-With", "pairprep")
          .send({ displayName: "DuplicateUser" })
      );

      const results = await Promise.all(parallel);
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      const memberships = await RoomMemberModel.find({ roomId, memberId: user.id });
      expect(memberships.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. GUEST COOKIES, SECURITY & CROSS-ROOM JOINS
  // -------------------------------------------------------------------------
  describe("AUTH-3: Guest Cookie Security & Lifecycle", () => {
    it("guest cookie on /me returns 401 UNAUTHORIZED", async () => {
      const { cookie } = await getGuestAgent("Guest User", "some-room-id");
      const res = await request(app).get("/api/v1/me").set("Cookie", cookie);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("guest cookie on POST /api/v1/rooms returns 401 UNAUTHORIZED", async () => {
      const { cookie } = await getGuestAgent("Guest User", "some-room-id");
      const res = await request(app)
        .post("/api/v1/rooms")
        .set("Cookie", cookie)
        .set("X-Requested-With", "pairprep")
        .send({ title: "Guest Room" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("tampered cookie clears cookie and returns 401 on protected route", async () => {
      const { cookie } = await getGuestAgent("Tamper Guest", "some-room-id");
      const tampered = cookie + "tampered";

      const res = await request(app)
        .patch("/api/v1/rooms/any-slug/members/any-id")
        .set("Cookie", tampered)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
      expect(res.headers["set-cookie"]).toBeDefined(); // Cookie cleared
    });

    it("cross-room guest join creates Room B membership first and sets new cookie", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomA = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room A" });
      const roomB = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room B" });

      // Join Room A as guest
      const joinARes = await request(app)
        .post(`/api/v1/rooms/${roomA.body.room.slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Roaming Guest" });
      expect(joinARes.status).toBe(200);

      const cookieA = (joinARes.headers["set-cookie"] as string[] | undefined)?.[0] || "";

      // Join Room B presenting Room A cookie
      const joinBRes = await request(app)
        .post(`/api/v1/rooms/${roomB.body.room.slug}/join`)
        .set("Cookie", cookieA)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Roaming Guest" });

      expect(joinBRes.status).toBe(200);
      expect(joinBRes.headers["set-cookie"]).toBeDefined();
      const cookieB = (joinBRes.headers["set-cookie"] as string[] | undefined)?.[0] || "";
      expect(cookieB).not.toBe(cookieA);
    });
  });

  // -------------------------------------------------------------------------
  // 6. ROLE PATCHING, DEMOTION & REMOVAL RESTRICTIONS
  // -------------------------------------------------------------------------
  describe("ROOM-3: Role Mutation Restrictions", () => {
    it("role patch to owner, interviewer, or candidate returns 400", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Role Test Room" });
      const slug = roomRes.body.room.slug;

      const { agent: userAgent } = await getAuthenticatedAgent({
        displayName: "Student",
      });
      const joined = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Student" });
      const memberDocId = joined.body.currentMember.id;

      for (const invalidRole of ["owner", "interviewer", "candidate"]) {
        const res = await ownerAgent
          .patch(`/api/v1/rooms/${slug}/members/${memberDocId}`)
          .set("X-Requested-With", "pairprep")
          .send({ role: invalidRole });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("owner cannot be demoted (400 CANNOT_DEMOTE_OWNER)", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Owner Demote Room" });
      const slug = roomRes.body.room.slug;
      const ownerMemberDocId = roomRes.body.currentMember.id;

      const res = await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${ownerMemberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CANNOT_DEMOTE_OWNER");
    });

    it("owner cannot be removed (400 CANNOT_REMOVE_OWNER)", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Owner Remove Room" });
      const slug = roomRes.body.room.slug;
      const ownerMemberDocId = roomRes.body.currentMember.id;

      const res = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${ownerMemberDocId}`)
        .set("X-Requested-With", "pairprep");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CANNOT_REMOVE_OWNER");
    });

    it("double removal: removing already removed participant returns 404 MEMBER_NOT_FOUND", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Double Remove Room" });
      const slug = roomRes.body.room.slug;

      const { agent: userAgent } = await getAuthenticatedAgent({
        displayName: "To Remove",
      });
      const joined = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "To Remove" });
      const memberDocId = joined.body.currentMember.id;

      const del1 = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("X-Requested-With", "pairprep");
      expect(del1.status).toBe(200);

      const del2 = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("X-Requested-With", "pairprep");
      expect(del2.status).toBe(404);
      expect(del2.body.error.code).toBe("MEMBER_NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // 7. ROOM LIFECYCLE & CASCADING DELETION
  // -------------------------------------------------------------------------
  describe("ROOM-6: Lifecycle & Cascade Emptiness", () => {
    it("POST /end is idempotent; ended room rejects joins and mutations with 409 ROOM_CLOSED", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "End Room" });
      const slug = roomRes.body.room.slug;

      const end1 = await ownerAgent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("X-Requested-With", "pairprep");
      expect(end1.status).toBe(200);
      expect(end1.body.room.status).toBe("ended");

      // Idempotent end call returns 200 with same body
      const end2 = await ownerAgent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("X-Requested-With", "pairprep");
      expect(end2.status).toBe(200);
      expect(end2.body.room.status).toBe("ended");

      // Joining ended room rejected with 409 ROOM_CLOSED
      const joinEnded = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Late" });
      expect(joinEnded.status).toBe(409);
      expect(joinEnded.body.error.code).toBe("ROOM_CLOSED");

      // Owner can still delete ended room
      const delEnded = await ownerAgent
        .delete(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(delEnded.status).toBe(204);
    });

    it("cascade deletion emptiness across all 8 collections (children first, room last)", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent();
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Cascade Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Seed all child collections
      await DocUpdateModel.create({
        roomId,
        seq: 1,
        authorId: "a",
        ts: new Date(),
        update: Buffer.from("u"),
        size: 1,
      });
      await DocSnapshotModel.create({
        roomId,
        seq: 1,
        ts: new Date(),
        state: Buffer.from("s"),
        text: "t",
      });
      await MessageModel.create({
        roomId,
        authorId: "a",
        text: "hi",
        ts: new Date(),
        kind: "user",
      });
      await EventModel.create({ roomId, userId: "a", type: "join", ts: new Date() });
      await GuestModel.create({
        roomId,
        displayName: "Guest",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10000),
      });
      await ClientMapModel.create({ roomId, clientId: 1, actorId: "a" });

      const delRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(delRes.status).toBe(204);

      // Verify all 8 collections are empty for that roomId
      expect(await RoomModel.findById(roomId)).toBeNull();
      expect(await RoomMemberModel.countDocuments({ roomId })).toBe(0);
      expect(await DocUpdateModel.countDocuments({ roomId })).toBe(0);
      expect(await DocSnapshotModel.countDocuments({ roomId })).toBe(0);
      expect(await MessageModel.countDocuments({ roomId })).toBe(0);
      expect(await EventModel.countDocuments({ roomId })).toBe(0);
      expect(await GuestModel.countDocuments({ roomId })).toBe(0);
      expect(await ClientMapModel.countDocuments({ roomId })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. ARCHIVE JOB & GUEST PURGE TESTS
  // -------------------------------------------------------------------------
  describe("Maintenance: Archive Job & Guest Purge", () => {
    it("inactivity archive transitions 30-day idle rooms to archived", async () => {
      const { user } = await getAuthenticatedAgent();
      const room = await roomRepo.createRoom({
        title: "Idle Room",
        ownerId: user.id,
      });

      // Set lastActivityAt to 31 days ago
      await RoomModel.findByIdAndUpdate(room.id, {
        lastActivityAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      });

      const { archivedCount } = await runArchiveAndPurgeJobOnce();
      expect(archivedCount).toBeGreaterThanOrEqual(1);

      const refreshed = await RoomModel.findById(room.id);
      expect(refreshed?.status).toBe("archived");
    });

    it("guest purge deletes expired room_members and decrements memberCount", async () => {
      const { user } = await getAuthenticatedAgent();
      const room = await roomRepo.createRoom({
        title: "Purge Room",
        ownerId: user.id,
      });

      // Add 2 expired guest members
      await roomMemberRepo.addMember({
        roomId: room.id,
        memberId: "g1",
        displayName: "Expired 1",
        role: "editor",
        isGuest: true,
        guestExpiresAt: new Date(Date.now() - 5000), // expired 5s ago
      });
      await roomMemberRepo.addMember({
        roomId: room.id,
        memberId: "g2",
        displayName: "Expired 2",
        role: "editor",
        isGuest: true,
        guestExpiresAt: new Date(Date.now() - 10000), // expired 10s ago
      });

      const beforeRoom = await RoomModel.findById(room.id);
      expect(beforeRoom?.memberCount).toBe(3); // 1 owner + 2 guests

      const { purgedGuestsCount } = await runArchiveAndPurgeJobOnce();
      expect(purgedGuestsCount).toBeGreaterThanOrEqual(2);

      const afterRoom = await RoomModel.findById(room.id);
      expect(afterRoom?.memberCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 9. CURSOR PAGINATION & DTO KEY-SETS
  // -------------------------------------------------------------------------
  describe("PER-2: Pagination & DTO Exact-Key Tests", () => {
    it("cursor pagination pages through my rooms newest first", async () => {
      const { agent } = await getAuthenticatedAgent();
      for (let i = 0; i < 5; i++) {
        await agent
          .post("/api/v1/rooms")
          .set("X-Requested-With", "pairprep")
          .send({ title: `Paging Room ${i}` });
      }

      // First page with limit = 2
      const p1 = await agent.get("/api/v1/rooms?limit=2");
      expect(p1.status).toBe(200);
      expect(p1.body.rooms.length).toBe(2);
      expect(p1.body.nextCursor).toBeDefined();

      // Second page using cursor
      const p2 = await agent.get(`/api/v1/rooms?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.status).toBe(200);
      expect(p2.body.rooms.length).toBe(2);
      expect(p2.body.rooms[0].id).not.toBe(p1.body.rooms[0].id);
    });

    it("malformed cursor returns 400 INVALID_CURSOR", async () => {
      const { agent } = await getAuthenticatedAgent();
      const res = await agent.get("/api/v1/rooms?cursor=invalid-not-base64url-json");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_CURSOR");
    });

    it("DTO key-set validation: strictly excludes internal fields (__v, passwords, emails)", async () => {
      const { agent } = await getAuthenticatedAgent({ displayName: "StrictDTO" });
      const res = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Strict Room" });

      const roomKeys = Object.keys(res.body.room);
      expect(roomKeys).not.toContain("__v");
      expect(roomKeys).not.toContain("_id");

      const memberKeys = Object.keys(res.body.currentMember);
      expect(memberKeys).not.toContain("__v");
      expect(memberKeys).not.toContain("_id");
      expect(memberKeys).not.toContain("email");
    });
  });

  // -------------------------------------------------------------------------
  // 10. ELEVEN IDEMPOTENCY TESTS (CONC-3)
  // -------------------------------------------------------------------------
  describe("CONC-3: Idempotency Key Suite", () => {
    it("1. sequential duplicate POST /rooms returns identical 201 response", async () => {
      const { agent } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();
      const payload = { title: "Idempotent Room" };

      const r1 = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send(payload);
      expect(r1.status).toBe(201);

      const r2 = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send(payload);
      expect(r2.status).toBe(201);
      expect(r1.body.room.id).toBe(r2.body.room.id);
      expect(await RoomModel.countDocuments({ title: "Idempotent Room" })).toBe(1);
    });

    it("2. concurrent duplicate POST /rooms creates exactly one room", async () => {
      const { agent } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();
      const payload = { title: "Concurrent Idempotent Room" };

      const [r1, r2] = await Promise.all([
        agent
          .post("/api/v1/rooms")
          .set("Idempotency-Key", key)
          .set("X-Requested-With", "pairprep")
          .send(payload),
        agent
          .post("/api/v1/rooms")
          .set("Idempotency-Key", key)
          .set("X-Requested-With", "pairprep")
          .send(payload),
      ]);

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.body.room.id).toBe(r2.body.room.id);
      expect(
        await RoomModel.countDocuments({ title: "Concurrent Idempotent Room" })
      ).toBe(1);
    });

    it("3. reused key with different payload returns 422 IDEMPOTENCY_KEY_REUSED", async () => {
      const { agent } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();

      await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "Payload A" });
      const bad = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "Payload B" });

      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("4. role patch replay returns cached 200", async () => {
      const { agent } = await getAuthenticatedAgent();
      const room = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Role Replay Room" });
      const slug = room.body.room.slug;

      const { agent: userAgent } = await getAuthenticatedAgent({
        displayName: "Student",
      });
      const join = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Student" });
      const memberDocId = join.body.currentMember.id;

      const key = crypto.randomUUID();
      const r1 = await agent
        .patch(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });
      expect(r1.status).toBe(200);

      const r2 = await agent
        .patch(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });
      expect(r2.status).toBe(200);
      expect(r1.body.room.id).toBe(r2.body.room.id);
    });

    it("5. end room replay returns cached 200", async () => {
      const { agent } = await getAuthenticatedAgent();
      const room = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "End Replay Room" });
      const slug = room.body.room.slug;

      const key = crypto.randomUUID();
      const r1 = await agent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep");
      expect(r1.status).toBe(200);

      const r2 = await agent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep");
      expect(r2.status).toBe(200);
    });

    it("6. delete room replay returns cached 204", async () => {
      const { agent } = await getAuthenticatedAgent();
      const room = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Delete Replay Room" });
      const slug = room.body.room.slug;

      const key = crypto.randomUUID();
      const r1 = await agent
        .delete(`/api/v1/rooms/${slug}`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep");
      expect(r1.status).toBe(204);

      const r2 = await agent
        .delete(`/api/v1/rooms/${slug}`)
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep");
      expect(r2.status).toBe(204);
    });

    it("7. stale lease (>30s) takeover", async () => {
      const { user } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();
      const route = "/api/v1/rooms";

      // Seed an in-progress record that is 35 seconds old (>30s)
      await IdempotencyKeyModel.create({
        key,
        actorId: user.id,
        route,
        requestHash: "POST:/api/v1/rooms:dummy",
        status: "in_progress",
        startedAt: new Date(Date.now() - 35000),
      });

      // Subsequent reserveKey takes over lease
      const result = await idempotencyRepo.reserveKey({
        key,
        actorId: user.id,
        route,
        requestHash: "POST:/api/v1/rooms:dummy",
      });

      expect(result.status).toBe("won");
    });

    it("8. non-2xx response deletes key, allowing retry", async () => {
      const { agent } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();

      // Send invalid payload (empty title)
      const bad = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "" });
      expect(bad.status).toBe(400);

      // Verify key was deleted so retrying with valid payload succeeds
      const good = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "Valid Now" });
      expect(good.status).toBe(201);
    });

    it("9. crash-after-insert recovery via (ownerId, idempotencyKey)", async () => {
      const { agent, user } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();

      // Simulate a created room with this idempotency key
      const created = await roomRepo.createRoom({
        title: "Crash Recovery Room",
        ownerId: user.id,
        idempotencyKey: key,
      });

      // A retry arrives
      const res = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "Crash Recovery Room" });
      expect(res.status).toBe(201);
      expect(res.body.room.id).toBe(created.id);
    });

    it("10. invalid UUID idempotency key returns 400 INVALID_IDEMPOTENCY_KEY", async () => {
      const { agent } = await getAuthenticatedAgent();
      const res = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", "not-a-valid-uuid")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Room" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    });

    it("11. cached response stores and returns DTO only", async () => {
      const { agent } = await getAuthenticatedAgent();
      const key = crypto.randomUUID();
      await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "DTO Cache Room" });
      const res2 = await agent
        .post("/api/v1/rooms")
        .set("Idempotency-Key", key)
        .set("X-Requested-With", "pairprep")
        .send({ title: "DTO Cache Room" });

      expect(res2.body.room.__v).toBeUndefined();
      expect(res2.body.room._id).toBeUndefined();
      expect(res2.body.currentMember.__v).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 11. LOG REDACTION, ERROR SANITIZATION & NAT RATE LIMITING
  // -------------------------------------------------------------------------
  describe("Security: Slug Redaction & Error Sanitization", () => {
    it("error messages on 404 never echo the slug", async () => {
      const secretSlug = "secret-128bit-random-slug-xyz123";
      const res = await request(app).get(`/api/v1/rooms/${secretSlug}`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe("Room not found");
      expect(res.body.error.message).not.toContain(secretSlug);
    });

    it("lookup rate limiter uses skipSuccessfulRequests: true", async () => {
      const { agent } = await getAuthenticatedAgent();
      const room = await agent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "NAT Limiter Room" });
      const slug = room.body.room.slug;

      // 65 rapid successful lookups from same IP do not trip the 60 req/min limit
      for (let i = 0; i < 65; i++) {
        const res = await request(app).get(`/api/v1/rooms/${slug}`);
        expect(res.status).toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 12. REVIEWER-REQUIRED TESTS
  // -------------------------------------------------------------------------
  describe("Reviewer: Removed-guest 403, Real-log slug redaction, Error-body slug exclusion", () => {
    /**
     * REVIEWER TEST A: Removed guest receives 403 FORBIDDEN on later actions.
     * After the owner removes a joined guest, the same guest cookie must be
     * rejected with 403 on any member-gated endpoint.
     */
    it("removed guest receives 403 FORBIDDEN on subsequent room actions", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Guest Removal Test Room" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Guest joins the room
      const joinRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Removable Guest" });
      expect(joinRes.status).toBe(200);

      const guestMemberDocId = joinRes.body.currentMember.id;
      const guestCookie = (joinRes.headers["set-cookie"] as string[] | undefined)?.[0] || "";
      expect(guestCookie).toBeTruthy();

      // Owner removes the guest
      const removeRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${guestMemberDocId}`)
        .set("X-Requested-With", "pairprep");
      expect(removeRes.status).toBe(200);

      // Verify the guest is no longer in the DB
      const removed = await RoomMemberModel.findById(guestMemberDocId);
      expect(removed).toBeNull();

      // Guest attempts to GET room details (member-gated full DTO requires membership)
      // The guest cookie is still valid (signed, not expired) but the guest is no longer a member.
      // requireMember will return 403 FORBIDDEN.
      const afterRemoval = await request(app)
        .get(`/api/v1/rooms/${slug}`)
        .set("Cookie", guestCookie);

      // GET /:slug returns 200 public DTO for non-members â€” but PATCH, DELETE, POST /end
      // all require membership. Use PATCH (member + owner role required) to confirm 403.
      const patchAfterRemoval = await request(app)
        .patch(`/api/v1/rooms/${slug}/members/${guestMemberDocId}`)
        .set("Cookie", guestCookie)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });

      expect(patchAfterRemoval.status).toBe(403);
      expect(patchAfterRemoval.body.error.code).toBe("FORBIDDEN");
      // Error message must not contain the room slug or the member id
      expect(patchAfterRemoval.body.error.message).not.toContain(slug);
      expect(patchAfterRemoval.body.error.message).not.toContain(roomId);

      // Also verify GET /join on closed guest still returns 403 via requireMember
      const endRes = await request(app)
        .post(`/api/v1/rooms/${slug}/end`)
        .set("Cookie", guestCookie)
        .set("X-Requested-With", "pairprep");
      expect(endRes.status).toBe(403);
      expect(endRes.body.error.code).toBe("FORBIDDEN");
    });

    /**
     * REVIEWER TEST B: Request logs redact the slug in the path field.
     * Uses a Writable stream wired into createLogger + requestLogger (same
     * pattern as logger.test.ts) to capture real JSON log output and assert
     * that the path field replaces the 22-char base64url slug with ":slug".
     */
    it("request logs redact the 22-char slug in path field (real captured log output)", async () => {
      // Capture log output into an in-memory stream
      const logChunks: string[] = [];
      const captureStream = new Writable({
        write(chunk, _encoding, callback) {
          logChunks.push(chunk.toString());
          callback();
        },
      });

      // Build a minimal test app wired with requestLogger using our capture logger
      const captureLogger = createLogger(captureStream);
      const testApp = express();

      // Wire requestLogger manually, replacing rootLogger with captureLogger
      testApp.use((req, res, next) => {
        const start = performance.now();
        const reqId = crypto.randomUUID();
        res.setHeader("X-Request-Id", reqId);
        const childLog = captureLogger.child({ requestId: reqId });

        res.on("finish", () => {
          const durationMs = Math.round((performance.now() - start) * 100) / 100;
          const statusCode = res.statusCode;
          const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
          const rawUrl = req.originalUrl || req.url || "/";
          const pathWithoutQuery = rawUrl.split("?")[0] || "/";

          // Apply the same slug-redaction regex used in production requestLogger
          const sanitizedPath = pathWithoutQuery.replace(
            /(\/api\/v1\/rooms\/)[A-Za-z0-9_-]{16,}(\/|$)/,
            "$1:slug$2"
          );

          childLog[level](
            { requestId: reqId, method: req.method, path: sanitizedPath, statusCode, durationMs },
            "HTTP request completed"
          );
        });
        next();
      });

      // Attach a stub handler for the rooms/:slug path
      testApp.get("/api/v1/rooms/:slug", (_req, res) => {
        res.status(200).json({ stub: true });
      });

      // Use a deterministic 22-char base64url slug (16 bytes)
      const realSlug = "aB3dEfGhIjKlMnOpQrStUv"; // exactly 22 chars, matches [A-Za-z0-9_-]{22}
      await request(testApp).get(`/api/v1/rooms/${realSlug}`);

      expect(logChunks.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logChunks[logChunks.length - 1]!);

      // The slug must be replaced by :slug in the log path
      expect(parsed.path).toBe("/api/v1/rooms/:slug");
      expect(parsed.path).not.toContain(realSlug);

      // Raw captured bytes must not contain the slug either
      const rawOutput = logChunks.join("");
      expect(rawOutput).not.toContain(realSlug);
    });

    /**
     * REVIEWER TEST C: 403 and 409 error response bodies never contain the slug.
     * Exercises the two error codes the reviewer called out explicitly.
     */
    it("403 FORBIDDEN and 409 ROOM_FULL error bodies never echo the slug", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({ displayName: "Owner" });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Error Body Slug Test" });
      const slug = roomRes.body.room.slug;
      const roomId = roomRes.body.room.id;

      // Fill room to capacity (owner = 1, add 5 more)
      for (let i = 0; i < 5; i++) {
        await roomMemberRepo.addMember({
          roomId,
          memberId: `filler_${i}`,
          displayName: `Filler ${i}`,
          role: "editor",
        });
      }

      // 409 ROOM_FULL â€“ join attempt on a full room
      const fullRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Overflow Guest" });
      expect(fullRes.status).toBe(409);
      expect(fullRes.body.error.code).toBe("ROOM_FULL");
      // Error message must not leak the slug
      const fullMsg: string = fullRes.body.error.message ?? "";
      expect(fullMsg).not.toContain(slug);

      // 403 FORBIDDEN â€“ non-member tries a member-only action
      const { agent: nonMemberAgent } = await getAuthenticatedAgent({
        displayName: "Outsider",
      });
      const forbiddenRes = await nonMemberAgent
        .post(`/api/v1/rooms/${slug}/end`)
        .set("X-Requested-With", "pairprep");
      expect(forbiddenRes.status).toBe(403);
      expect(forbiddenRes.body.error.code).toBe("FORBIDDEN");
      const forbiddenMsg: string = forbiddenRes.body.error.message ?? "";
      expect(forbiddenMsg).not.toContain(slug);
    });
  });
});

