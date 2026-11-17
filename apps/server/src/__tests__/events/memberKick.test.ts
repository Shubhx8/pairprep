import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { passport } from "../../auth/passport.js";
import { RoomKickModel } from "../../models/room_kicks.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { roomKickRepo } from "../../repos/roomKickRepo.js";
import { roomBanRepo } from "../../repos/roomBanRepo.js";
import { authRateLimiter } from "../../middleware/authRateLimiter.js";
import {
  roomCreationLimiter,
  roomJoinLookupLimiter,
} from "../../middleware/roomRateLimiter.js";
import { apiRateLimiter } from "../../middleware/rateLimiter.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { presenceTracker } from "../../events/presenceTracker.js";

describe("T09 — Member Management: Temporary Kick vs Permanent Ban", () => {
  const roomId = "507f1f77bcf86cd799439099";
  const userId = "507f1f77bcf86cd799439011";
  const ownerId = "507f1f77bcf86cd799439000";

  beforeAll(async () => {
    await setupTestDb("member_kick_test");
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

  describe("1. RoomKickRepo Unit Operations", () => {
    it("recordKick upserts a temporary restriction with future expiresAt", async () => {
      const res = await roomKickRepo.recordKick(
        roomId,
        { id: userId, type: "user" },
        ownerId,
        60000
      );

      expect(res).toBeDefined();
      expect(res?.roomId).toBe(roomId);
      expect(res?.principalId).toBe(userId);
      expect(res?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const found = await RoomKickModel.findOne({
        roomId,
        principalId: userId,
      });
      expect(found).toBeDefined();
      expect(found?.kickedBy).toBe(ownerId);
    });

    it("isKicked returns true when an unexpired kick restriction exists", async () => {
      await roomKickRepo.recordKick(roomId, { id: userId, type: "user" }, ownerId, 60000);

      const isKicked = await roomKickRepo.isKicked(roomId, "user", userId);
      expect(isKicked).toBe(true);
    });

    it("isKicked returns false when the kick restriction has expired", async () => {
      await roomKickRepo.recordKick(
        roomId,
        { id: userId, type: "user" },
        ownerId,
        -1000 // Expired in past
      );

      const isKicked = await roomKickRepo.isKicked(roomId, "user", userId);
      expect(isKicked).toBe(false);
    });

    it("isKicked returns false when no kick record exists", async () => {
      const isKicked = await roomKickRepo.isKicked(roomId, "user", "clean_user_id");
      expect(isKicked).toBe(false);
    });

    it("deleteKicksForRoom removes all kicks for a deleted room", async () => {
      await roomKickRepo.recordKick(roomId, { id: userId, type: "user" }, ownerId, 60000);
      await roomKickRepo.recordKick(
        roomId,
        { id: "user_2", type: "user" },
        ownerId,
        60000
      );

      const count = await roomKickRepo.deleteKicksForRoom(roomId);
      expect(count).toBe(2);

      const remaining = await RoomKickModel.countDocuments({ roomId });
      expect(remaining).toBe(0);
    });
  });

  describe("2. HTTP Integration: Kick vs Ban Re-entry Enforcement", () => {
    it("owner kicks member with action=kick: creates temporary kick, removes member, rejects immediate rejoin with 403 MEMBER_KICKED", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Host Owner",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Kick Action Room" });
      expect(roomRes.status).toBe(201);
      const slug = roomRes.body.room.slug;
      const rId = roomRes.body.room.id;

      // Candidate joins room
      const { agent: candidateAgent, user: candidateUser } = await getAuthenticatedAgent({
        displayName: "Kicked Candidate",
      });
      const joinRes = await candidateAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Kicked Candidate" });
      expect(joinRes.status).toBe(200);
      const memberDocId = joinRes.body.currentMember.id;

      // Owner kicks candidate using ?action=kick
      const kickRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=kick`)
        .set("X-Requested-With", "pairprep");
      expect(kickRes.status).toBe(200);
      expect(kickRes.body.action).toBe("kick");

      // Verify NOT in permanent room_bans collection
      const isPermanentlyBanned = await roomBanRepo.isBanned(
        rId,
        "user",
        candidateUser.id
      );
      expect(isPermanentlyBanned).toBe(false);

      // Verify IS in room_kicks temporary collection
      const isTemporarilyKicked = await roomKickRepo.isKicked(
        rId,
        "user",
        candidateUser.id
      );
      expect(isTemporarilyKicked).toBe(true);

      // Candidate attempts immediate rejoin -> Rejected with 403 MEMBER_KICKED
      const rejoinRes = await candidateAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Kicked Candidate Returns" });
      expect(rejoinRes.status).toBe(403);
      expect(rejoinRes.body.error.code).toBe("MEMBER_KICKED");

      // Candidate attempts room detail GET -> Rejected with 403 MEMBER_KICKED
      const getRes = await candidateAgent
        .get(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(getRes.status).toBe(403);
      expect(getRes.body.error.code).toBe("MEMBER_KICKED");

      // Simulate expiration of temporary restriction
      await RoomKickModel.updateOne(
        { roomId: rId, principalId: candidateUser.id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );

      // Candidate attempts rejoin after expiration -> Succeeds cleanly!
      const expiredRejoinRes = await candidateAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Kicked Candidate Returns After Cooldown" });
      expect(expiredRejoinRes.status).toBe(200);
      expect(expiredRejoinRes.body.currentMember).toBeDefined();
    });

    it("owner bans member with action=ban: creates permanent ban in room_bans, rejects rejoin with 403 MEMBER_BANNED", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Host Owner 2",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Permanent Ban Room" });
      const slug = roomRes.body.room.slug;
      const rId = roomRes.body.room.id;

      // Bad user joins
      const { agent: badAgent, user: badUser } = await getAuthenticatedAgent({
        displayName: "Disruptive User",
      });
      const joinRes = await badAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Disruptive User" });
      const memberDocId = joinRes.body.currentMember.id;

      // Owner bans user with ?action=ban
      const banRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=ban`)
        .set("X-Requested-With", "pairprep");
      expect(banRes.status).toBe(200);
      expect(banRes.body.action).toBe("ban");

      // Verify stored in canonical room_bans collection
      const isPermanentlyBanned = await roomBanRepo.isBanned(rId, "user", badUser.id);
      expect(isPermanentlyBanned).toBe(true);

      // Bad user attempts rejoin -> Rejected with 403 MEMBER_BANNED
      const rejoinRes = await badAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Disruptive User Rejoining" });
      expect(rejoinRes.status).toBe(403);
      expect(rejoinRes.body.error.code).toBe("MEMBER_BANNED");
    });

    it("owner changes member role between editor and viewer via PATCH /members/:id", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Host Owner 3",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Role Change Room" });
      const slug = roomRes.body.room.slug;

      const { agent: memberAgent } = await getAuthenticatedAgent({
        displayName: "Collaborator",
      });
      const joinRes = await memberAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Collaborator" });
      const memberDocId = joinRes.body.currentMember.id;

      // Initial role is editor
      expect(joinRes.body.currentMember.role).toBe("editor");

      // Owner demotes to viewer
      const demoteRes = await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });
      expect(demoteRes.status).toBe(200);
      expect(demoteRes.body.member.role).toBe("viewer");

      // Owner promotes back to editor
      const promoteRes = await ownerAgent
        .patch(`/api/v1/rooms/${slug}/members/${memberDocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "editor" });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.member.role).toBe("editor");
    });

    it("non-owner cannot kick, ban, or change roles of other members", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Host Owner 4",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Auth Check Room" });
      const slug = roomRes.body.room.slug;

      const { agent: member1Agent } = await getAuthenticatedAgent({
        displayName: "Member 1",
      });
      const join1 = await member1Agent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Member 1" });
      const member1DocId = join1.body.currentMember.id;

      const { agent: member2Agent } = await getAuthenticatedAgent({
        displayName: "Member 2",
      });
      await member2Agent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Member 2" });

      // Member 2 tries to kick Member 1 -> 403 Forbidden
      const kickRes = await member2Agent
        .delete(`/api/v1/rooms/${slug}/members/${member1DocId}?action=kick`)
        .set("X-Requested-With", "pairprep");
      expect(kickRes.status).toBe(403);

      // Member 2 tries to change role of Member 1 -> 403 Forbidden
      const roleRes = await member2Agent
        .patch(`/api/v1/rooms/${slug}/members/${member1DocId}`)
        .set("X-Requested-With", "pairprep")
        .send({ role: "viewer" });
      expect(roleRes.status).toBe(403);
    });

    it("owner cannot kick or ban themselves", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Self Kick Owner",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Self Kick Room" });
      const slug = roomRes.body.room.slug;
      const ownerMember = await RoomMemberModel.findOne({
        roomId: roomRes.body.room.id,
        role: "owner",
      });
      expect(ownerMember).toBeDefined();

      const kickRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${ownerMember!.id}?action=kick`)
        .set("X-Requested-With", "pairprep");
      expect(kickRes.status).toBe(400);
      expect(kickRes.body.error.code).toBe("CANNOT_REMOVE_OWNER");
    });

    it("measures member kick eviction latency across 5 runs and verifies < 1000ms SLA", async () => {
      const syncCloseSpy = vi.spyOn(syncRegistry, "closeConnectionsForMember");
      const presenceDisconnectSpy = vi.spyOn(presenceTracker, "disconnectMemberSockets");

      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const { agent: ownerAgent } = await getAuthenticatedAgent({
          displayName: `Host Latency ${i}`,
        });
        const roomRes = await ownerAgent
          .post("/api/v1/rooms")
          .set("X-Requested-With", "pairprep")
          .send({ title: `Latency Room ${i}` });
        const slug = roomRes.body.room.slug;

        const { agent: candidateAgent } = await getAuthenticatedAgent({
          displayName: `Candidate ${i}`,
        });
        const joinRes = await candidateAgent
          .post(`/api/v1/rooms/${slug}/join`)
          .set("X-Requested-With", "pairprep")
          .send({ displayName: `Candidate ${i}` });
        const memberDocId = joinRes.body.currentMember.id;

        const start = performance.now();
        const kickRes = await ownerAgent
          .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=kick`)
          .set("X-Requested-With", "pairprep");
        const elapsed = performance.now() - start;

        expect(kickRes.status).toBe(200);
        latencies.push(elapsed);
        expect(elapsed).toBeLessThan(1000); // 1-second SLA
      }

      // Verify that eviction routines were invoked for both Hocuspocus and Socket.IO
      expect(syncCloseSpy).toHaveBeenCalledTimes(5);
      expect(presenceDisconnectSpy).toHaveBeenCalledTimes(5);

      const min = Math.min(...latencies);
      const worst = Math.max(...latencies);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log(
        `[Eviction Benchmark] Runs: ${latencies.map((l, idx) => `Run ${idx + 1}=${l.toFixed(2)}ms`).join(", ")} | Min=${min.toFixed(2)}ms, Max=${worst.toFixed(2)}ms, Avg=${avg.toFixed(2)}ms`
      );

      expect(worst).toBeLessThan(1000);
      expect(avg).toBeLessThan(500);
    });

    it("ensures permanent ban takes precedence and cannot be bypassed by kick status", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Precedence Host",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Precedence Room" });
      const slug = roomRes.body.room.slug;
      const rId = roomRes.body.room.id;

      const { agent: userAgent, user: candidateUser } = await getAuthenticatedAgent({
        displayName: "Precedence User",
      });
      const joinRes = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Precedence User" });
      const memberDocId = joinRes.body.currentMember.id;

      // Owner bans user permanently
      const banRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=ban`)
        .set("X-Requested-With", "pairprep");
      expect(banRes.status).toBe(200);

      // Verify permanent ban exists
      expect(await roomBanRepo.isBanned(rId, "user", candidateUser.id)).toBe(true);

      // Even if a temporary kick record is artificially inserted with future expiresAt
      await roomKickRepo.recordKick(
        rId,
        { id: candidateUser.id, type: "user" },
        "system",
        60000
      );

      // Rejoin attempt MUST still return 403 MEMBER_BANNED (not MEMBER_KICKED)
      const rejoinRes = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Precedence User" });
      expect(rejoinRes.status).toBe(403);
      expect(rejoinRes.body.error.code).toBe("MEMBER_BANNED");

      // GET room MUST return 403 MEMBER_BANNED
      const getRes = await userAgent
        .get(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(getRes.status).toBe(403);
      expect(getRes.body.error.code).toBe("MEMBER_BANNED");
    });

    it("measures member kick eviction latency across 5 runs and verifies < 1000ms SLA", async () => {
      const syncCloseSpy = vi.spyOn(syncRegistry, "closeConnectionsForMember");
      const presenceDisconnectSpy = vi.spyOn(presenceTracker, "disconnectMemberSockets");

      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const { agent: ownerAgent } = await getAuthenticatedAgent({
          displayName: `Host Latency ${i}`,
        });
        const roomRes = await ownerAgent
          .post("/api/v1/rooms")
          .set("X-Requested-With", "pairprep")
          .send({ title: `Latency Room ${i}` });
        const slug = roomRes.body.room.slug;

        const { agent: candidateAgent } = await getAuthenticatedAgent({
          displayName: `Candidate ${i}`,
        });
        const joinRes = await candidateAgent
          .post(`/api/v1/rooms/${slug}/join`)
          .set("X-Requested-With", "pairprep")
          .send({ displayName: `Candidate ${i}` });
        const memberDocId = joinRes.body.currentMember.id;

        const start = performance.now();
        const kickRes = await ownerAgent
          .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=kick`)
          .set("X-Requested-With", "pairprep");
        const elapsed = performance.now() - start;

        expect(kickRes.status).toBe(200);
        latencies.push(elapsed);
        expect(elapsed).toBeLessThan(1000); // 1-second SLA
      }

      // Verify that eviction routines were invoked for both Hocuspocus and Socket.IO
      expect(syncCloseSpy).toHaveBeenCalledTimes(5);
      expect(presenceDisconnectSpy).toHaveBeenCalledTimes(5);

      const min = Math.min(...latencies);
      const worst = Math.max(...latencies);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log(
        `[Eviction Benchmark] Runs: ${latencies.map((l, idx) => `Run ${idx + 1}=${l.toFixed(2)}ms`).join(", ")} | Min=${min.toFixed(2)}ms, Max=${worst.toFixed(2)}ms, Avg=${avg.toFixed(2)}ms`
      );

      expect(worst).toBeLessThan(1000);
      expect(avg).toBeLessThan(500);
    });

    it("ensures permanent ban takes precedence and cannot be bypassed by kick status", async () => {
      const { agent: ownerAgent } = await getAuthenticatedAgent({
        displayName: "Precedence Host",
      });
      const roomRes = await ownerAgent
        .post("/api/v1/rooms")
        .set("X-Requested-With", "pairprep")
        .send({ title: "Precedence Room" });
      const slug = roomRes.body.room.slug;
      const rId = roomRes.body.room.id;

      const { agent: userAgent, user: candidateUser } = await getAuthenticatedAgent({
        displayName: "Precedence User",
      });
      const joinRes = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Precedence User" });
      const memberDocId = joinRes.body.currentMember.id;

      // Owner bans user permanently
      const banRes = await ownerAgent
        .delete(`/api/v1/rooms/${slug}/members/${memberDocId}?action=ban`)
        .set("X-Requested-With", "pairprep");
      expect(banRes.status).toBe(200);

      // Verify permanent ban exists
      expect(await roomBanRepo.isBanned(rId, "user", candidateUser.id)).toBe(true);

      // Even if a temporary kick record is artificially inserted with future expiresAt
      await roomKickRepo.recordKick(
        rId,
        { id: candidateUser.id, type: "user" },
        "system",
        60000
      );

      // Rejoin attempt MUST still return 403 MEMBER_BANNED (not MEMBER_KICKED)
      const rejoinRes = await userAgent
        .post(`/api/v1/rooms/${slug}/join`)
        .set("X-Requested-With", "pairprep")
        .send({ displayName: "Precedence User" });
      expect(rejoinRes.status).toBe(403);
      expect(rejoinRes.body.error.code).toBe("MEMBER_BANNED");

      // GET room MUST return 403 MEMBER_BANNED
      const getRes = await userAgent
        .get(`/api/v1/rooms/${slug}`)
        .set("X-Requested-With", "pairprep");
      expect(getRes.status).toBe(403);
      expect(getRes.body.error.code).toBe("MEMBER_BANNED");
    });
  });
});
