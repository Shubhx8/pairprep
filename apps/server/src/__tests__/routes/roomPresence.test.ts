import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { passport } from "../../auth/passport.js";
import { authRateLimiter } from "../../middleware/authRateLimiter.js";
import {
  roomCreationLimiter,
  roomJoinLookupLimiter,
} from "../../middleware/roomRateLimiter.js";
import { apiRateLimiter } from "../../middleware/rateLimiter.js";
import type { SyncConnectionLike } from "../../sync/syncRegistry.js";

describe("ROOM-5 Live Presence Diagnosis & Online Status API", () => {
  beforeAll(async () => {
    await setupTestDb("api_room_presence");
  });

  afterAll(async () => {
    syncRegistry.resetAll();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    syncRegistry.resetAll();
    vi.restoreAllMocks();

    const ips = ["127.0.0.1", "::ffff:127.0.0.1", "::1", "unknown"];
    for (const ip of ips) {
      authRateLimiter.resetKey(ip);
      roomCreationLimiter.resetKey(ip);
      roomJoinLookupLimiter.resetKey(ip);
      apiRateLimiter.resetKey(ip);
    }
  });

  async function getAuthenticatedAgent(displayName = "Test User") {
    const user = await userRepo.upsertUser({
      provider: "google",
      providerId: `sub_${Date.now()}_${Math.random()}`,
      displayName,
      email: `user_${Date.now()}_${Math.random()}@example.com`,
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

  function mockConnection(socketId: string): SyncConnectionLike {
    return {
      readOnly: false,
      socketId,
      webSocket: { close: vi.fn() },
      close: vi.fn(),
    };
  }

  function registerActiveSyncConnection(
    roomId: string,
    socketId: string,
    memberId: string,
    displayName: string,
    role = "editor"
  ) {
    const reservation = syncRegistry.reserveSlot(roomId, socketId);
    if (!reservation.success) {
      throw new Error(`Failed to reserve slot: ${reservation.reason}`);
    }
    const token = reservation.token;
    syncRegistry.assignMemberToReservation(roomId, socketId, memberId, token);

    const principal = {
      type: "user",
      id: memberId,
      displayName,
      role: "user",
      user: {
        id: memberId,
        displayName,
        role: "user",
      } as unknown as import("../../models/users.js").IUser,
    };

    const promoResult = syncRegistry.promoteReservation(
      socketId,
      roomId,
      memberId,
      principal,
      mockConnection(socketId),
      role,
      token
    );

    if (!promoResult.success) {
      throw new Error(`Failed to promote reservation: ${promoResult.reason}`);
    }
  }

  it("1. Two members connected: both report online and onlineMemberCount is 2", async () => {
    const { agent: hostAgent, user: hostUser } =
      await getAuthenticatedAgent("Alice Host");
    const { agent: guestAgent, user: guestUser } =
      await getAuthenticatedAgent("Bob Guest");

    // Host creates room
    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Presence Test Room", language: "python" });
    expect(createRes.status).toBe(201);
    const room = createRes.body.room;

    // Guest joins room
    const joinRes = await guestAgent
      .post(`/api/v1/rooms/${room.slug}/join`)
      .set("X-Requested-With", "pairprep")
      .send();
    expect(joinRes.status).toBe(200);

    // Register active WebSocket connections in syncRegistry
    registerActiveSyncConnection(
      room.id,
      "sock_host_1",
      hostUser.id,
      "Alice Host",
      "owner"
    );
    registerActiveSyncConnection(
      room.id,
      "sock_guest_1",
      guestUser.id,
      "Bob Guest",
      "editor"
    );

    // Host fetches room details
    const res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.onlineMemberCount).toBe(2);
    expect(res.body.room.memberCount).toBe(2);

    const hostMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Alice Host"
    );
    const guestMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Bob Guest"
    );

    expect(hostMember).toBeDefined();
    expect(hostMember.isOnline).toBe(true);
    expect(guestMember).toBeDefined();
    expect(guestMember.isOnline).toBe(true);
  });

  it("2 & 7. Guest disconnects: guest becomes offline while persistent membership and room.memberCount remain", async () => {
    const { agent: hostAgent, user: hostUser } =
      await getAuthenticatedAgent("Alice Host");
    const { agent: guestAgent, user: guestUser } =
      await getAuthenticatedAgent("Bob Guest");

    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Disconnect Test Room", language: "python" });
    const room = createRes.body.room;

    await guestAgent
      .post(`/api/v1/rooms/${room.slug}/join`)
      .set("X-Requested-With", "pairprep")
      .send();

    registerActiveSyncConnection(
      room.id,
      "sock_host_1",
      hostUser.id,
      "Alice Host",
      "owner"
    );
    registerActiveSyncConnection(
      room.id,
      "sock_guest_1",
      guestUser.id,
      "Bob Guest",
      "editor"
    );

    // Guest closes WebSocket (disconnects)
    syncRegistry.unregisterConnection(room.id, "sock_guest_1");

    const res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.onlineMemberCount).toBe(1);
    // Persistent room.memberCount must NOT be decremented on disconnect
    expect(res.body.room.memberCount).toBe(2);

    const hostMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Alice Host"
    );
    const guestMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Bob Guest"
    );

    expect(hostMember.isOnline).toBe(true);
    expect(guestMember.isOnline).toBe(false);

    // Verify DB still holds both persistent members
    const dbMembers = await roomMemberRepo.listMembers(room.id);
    expect(dbMembers.length).toBe(2);
    const dbRoom = await roomRepo.findById(room.id);
    expect(dbRoom?.memberCount).toBe(2);
  });

  it("3. Guest reconnects: guest becomes online again and onlineMemberCount increments", async () => {
    const { agent: hostAgent, user: hostUser } =
      await getAuthenticatedAgent("Alice Host");
    const { agent: guestAgent, user: guestUser } =
      await getAuthenticatedAgent("Bob Guest");

    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Reconnect Test Room", language: "python" });
    const room = createRes.body.room;
    await guestAgent
      .post(`/api/v1/rooms/${room.slug}/join`)
      .set("X-Requested-With", "pairprep")
      .send();

    registerActiveSyncConnection(
      room.id,
      "sock_host_1",
      hostUser.id,
      "Alice Host",
      "owner"
    );

    // Guest disconnected initially
    let res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.body.onlineMemberCount).toBe(1);
    let guestMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Bob Guest"
    );
    expect(guestMember.isOnline).toBe(false);

    // Guest reconnects with new socket
    registerActiveSyncConnection(
      room.id,
      "sock_guest_2",
      guestUser.id,
      "Bob Guest",
      "editor"
    );

    res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.body.onlineMemberCount).toBe(2);
    guestMember = res.body.members.find(
      (m: { displayName: string }) => m.displayName === "Bob Guest"
    );
    expect(guestMember.isOnline).toBe(true);
  });

  it("4 & 5. One member has two active browser connections: counts as 1 online member, remains online when one closes", async () => {
    const { agent: hostAgent, user: hostUser } =
      await getAuthenticatedAgent("Alice Host");

    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Multi-tab Test Room", language: "python" });
    const room = createRes.body.room;

    // Alice opens tab 1
    registerActiveSyncConnection(
      room.id,
      "sock_alice_tab1",
      hostUser.id,
      "Alice Host",
      "owner"
    );
    // Alice opens tab 2 (same memberId, distinct socketId)
    registerActiveSyncConnection(
      room.id,
      "sock_alice_tab2",
      hostUser.id,
      "Alice Host",
      "owner"
    );

    let res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.status).toBe(200);
    // 2 connections, but only 1 distinct online member
    expect(res.body.onlineMemberCount).toBe(1);
    expect(res.body.members[0].isOnline).toBe(true);

    // Alice closes tab 1
    syncRegistry.unregisterConnection(room.id, "sock_alice_tab1");

    res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    // Still 1 online because tab 2 is still open
    expect(res.body.onlineMemberCount).toBe(1);
    expect(res.body.members[0].isOnline).toBe(true);
  });

  it("6. Last connection closes: member becomes offline and onlineMemberCount is 0", async () => {
    const { agent: hostAgent, user: hostUser } =
      await getAuthenticatedAgent("Alice Host");

    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Zero Presence Test Room", language: "python" });
    const room = createRes.body.room;

    registerActiveSyncConnection(
      room.id,
      "sock_alice_1",
      hostUser.id,
      "Alice Host",
      "owner"
    );

    let res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.body.onlineMemberCount).toBe(1);
    expect(res.body.members[0].isOnline).toBe(true);

    // Alice closes the socket
    syncRegistry.unregisterConnection(room.id, "sock_alice_1");

    res = await hostAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.body.onlineMemberCount).toBe(0);
    expect(res.body.members[0].isOnline).toBe(false);
    expect(res.body.members[0].displayName).toBe("Alice Host");
  });

  it("8. Non-members cannot access the detailed participant roster or presence information", async () => {
    const { agent: hostAgent } = await getAuthenticatedAgent("Alice Host");
    const { agent: nonMemberAgent } = await getAuthenticatedAgent("Eve Outsider");

    const createRes = await hostAgent
      .post("/api/v1/rooms")
      .set("X-Requested-With", "pairprep")
      .send({ title: "Private Presence Room", language: "python" });
    const room = createRes.body.room;

    // Non-member accesses room
    const res = await nonMemberAgent.get(`/api/v1/rooms/${room.slug}`);
    expect(res.status).toBe(200);
    // Public room DTO only
    expect(res.body.room).toBeDefined();
    expect(res.body.room.slug).toBe(room.slug);
    // Detailed member array and online counts must NOT be exposed
    expect(res.body.members).toBeUndefined();
    expect(res.body.onlineMemberCount).toBeUndefined();
    expect(res.body.currentMember).toBeUndefined();

    // Anonymous visitor accesses room
    const anonRes = await request(app).get(`/api/v1/rooms/${room.slug}`);
    expect(anonRes.status).toBe(200);
    expect(anonRes.body.members).toBeUndefined();
    expect(anonRes.body.onlineMemberCount).toBeUndefined();
    expect(anonRes.body.currentMember).toBeUndefined();
  });
});
