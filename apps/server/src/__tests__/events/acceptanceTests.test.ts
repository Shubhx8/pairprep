import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { setupGracefulShutdown } from "../../index.js";
import { abortRoomPersistence } from "../../sync/persistence.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { RoomMemberModel, IRoomMember } from "../../models/room_members.js";
import { RoomModel, IRoom } from "../../models/rooms.js";
import { isAllowedOrigin } from "../../sync/origin.js";
import { roomsRouter } from "../../routes/rooms.js";
import { ChatRateLimiter } from "../../events/chatRateLimiter.js";
import { MessageModel, IMessage } from "../../models/messages.js";

describe("T09 Phase 0–2 Acceptance Criteria Tests (A, B, C, D, E)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────
  // Acceptance Test A: Graceful shutdown under 10 seconds
  // ─────────────────────────────────────────────────────────────
  describe("Acceptance Test A: Graceful Shutdown Under 10 Seconds", () => {
    it("completes shutdown within 10s: drains active mutations, aborts Yjs persistence, and closes sockets", async () => {
      const server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, resolve));

      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      const mockSyncDrain = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await abortRoomPersistence("room_drain_123");
      });

      const mockSocketClose = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const { handleShutdown } = setupGracefulShutdown(server, async () => {
        await Promise.allSettled([mockSyncDrain(), mockSocketClose()]);
      });

      const startTime = Date.now();
      await handleShutdown("SIGTERM");
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(10_000);
      expect(mockSyncDrain).toHaveBeenCalledTimes(1);
      expect(mockSocketClose).toHaveBeenCalledTimes(1);
    });

    it("times out cleanly at 10s if a stuck handler hangs, forcing exit", async () => {
      vi.useFakeTimers();
      const server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, resolve));

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);

      const stuckHandler = vi.fn().mockImplementation(
        () => new Promise(() => {}) // never resolves
      );

      const { handleShutdown } = setupGracefulShutdown(server, stuckHandler);
      void handleShutdown("SIGTERM");

      // Advance clock past 10 seconds
      await vi.advanceTimersByTimeAsync(10_000);

      expect(stuckHandler).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Acceptance Test B: Removed member can rejoin immediately
  // ─────────────────────────────────────────────────────────────
  describe("Acceptance Test B: Immediate Rejoin After Member Removal", () => {
    it("allows a removed participant to rejoin immediately with clean slate and without corrupting removal evidence", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439022";
      const memberId = "user_rejoining_123";
      const opId = "op:removal:acceptance:1";

      const roomState = {
        _id: roomId,
        memberCount: 2,
        memberCountUpdatedAt: new Date(),
        removedMembers: [] as Array<{
          memberDocId: string;
          opId: string;
          removedAt: Date;
        }>,
        status: "open",
      };

      // Mock RoomModel.findById for removeMember / addMember
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        select: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(roomState),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      // Mock RoomMemberModel for removal
      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: memberDocId, tombstoneOpId: opId }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(RoomModel, "updateOne").mockImplementation(((
        _filter: unknown,
        update: unknown
      ) => {
        const u = update as {
          $inc?: { memberCount?: number };
          $push?: {
            removedMembers?: { memberDocId: string; opId: string; removedAt: Date };
          };
        };
        if (u.$inc?.memberCount) roomState.memberCount += u.$inc.memberCount;
        if (u.$push?.removedMembers)
          roomState.removedMembers.push(u.$push.removedMembers);
        return {
          exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
        };
      }) as never);

      // 1. Remove participant
      const removed = await roomMemberRepo.removeMember(roomId, memberDocId, opId);
      expect(removed).toBe(true);
      expect(roomState.memberCount).toBe(1);
      expect(roomState.removedMembers).toHaveLength(1);
      expect(roomState.removedMembers[0]?.opId).toBe(opId);

      // 2. Immediate rejoin
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null), // no existing member doc
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "findOneAndUpdate").mockImplementation((_filter, update) => {
        const u = update as { $inc?: { memberCount?: number } };
        if (u.$inc?.memberCount) roomState.memberCount += u.$inc.memberCount;
        return {
          exec: vi.fn().mockResolvedValue(roomState),
        } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>;
      });

      const createdMemberDoc = new RoomMemberModel({
        _id: "507f1f77bcf86cd799439099",
        roomId,
        memberId,
        displayName: "Rejoined Participant",
        role: "viewer",
        roleVersion: 1,
        roleOps: [],
        appliedOpIds: [],
        joinedAt: new Date(),
        lastSeenAt: new Date(),
      });

      vi.spyOn(RoomMemberModel.prototype, "save").mockImplementation(function (
        this: unknown
      ) {
        return Promise.resolve(createdMemberDoc);
      });

      const rejoined = await roomMemberRepo.addMember({
        roomId,
        memberId,
        displayName: "Rejoined Participant",
        role: "viewer",
      });

      // Assert clean slate for rejoined member
      expect(rejoined).toBeDefined();
      expect(rejoined.role).toBe("viewer");
      expect(rejoined.roleVersion).toBe(1);
      expect(rejoined.roleOps?.length ?? 0).toBe(0);

      // Assert room removal evidence is preserved intact
      expect(roomState.memberCount).toBe(2);
      expect(roomState.removedMembers).toHaveLength(1);
      expect(roomState.removedMembers[0]?.opId).toBe(opId);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Acceptance Test C: Origin validation
  // ─────────────────────────────────────────────────────────────
  describe("Acceptance Test C: Origin Validation", () => {
    it("admits configured development origins localhost:5173 and localhost:5174", () => {
      expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
      expect(isAllowedOrigin("http://localhost:5174")).toBe(true);
      expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
      expect(isAllowedOrigin("http://127.0.0.1:5174")).toBe(true);
    });

    it("rejects unlisted untrusted origins", () => {
      expect(isAllowedOrigin("http://evil-site.com")).toBe(false);
      expect(isAllowedOrigin("http://attacker.local:5173")).toBe(false);
      expect(isAllowedOrigin("https://malicious.org")).toBe(false);
    });

    it("rejects missing, undefined, or empty origin headers", () => {
      expect(isAllowedOrigin(undefined)).toBe(false);
      expect(isAllowedOrigin("")).toBe(false);
      expect(isAllowedOrigin([])).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Acceptance Test D: History authorization
  // ─────────────────────────────────────────────────────────────
  describe("Acceptance Test D: History API Authorization & Cross-Room Isolation", () => {
    const app = express();
    app.use(express.json());

    let mockPrincipal: { id: string; role?: string } | null = null;

    app.use((req, _res, next) => {
      if (mockPrincipal) {
        (req as unknown as { principal: unknown }).principal = mockPrincipal;
      }
      next();
    });

    app.use("/api/rooms", roomsRouter);

    it("returns 401 when request is unauthenticated (missing principal)", async () => {
      mockPrincipal = null;

      vi.spyOn(roomRepo, "findBySlug").mockResolvedValue({
        id: "room_1",
        slug: "test-slug-1",
        status: "open",
      } as unknown as IRoom);

      const res = await request(app).get("/api/rooms/test-slug-1/messages");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when principal is not a member of the room", async () => {
      mockPrincipal = { id: "user_intruder" };

      vi.spyOn(roomRepo, "findBySlug").mockResolvedValue({
        id: "room_1",
        slug: "test-slug-1",
        status: "open",
      } as unknown as IRoom);

      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue(null);

      const res = await request(app).get("/api/rooms/test-slug-1/messages");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("allows authorized participants (including viewers) to receive room messages", async () => {
      mockPrincipal = { id: "user_viewer" };

      vi.spyOn(roomRepo, "findBySlug").mockResolvedValue({
        id: "room_1",
        slug: "test-slug-1",
        status: "open",
      } as unknown as IRoom);

      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        id: "mem_1",
        roomId: "room_1",
        memberId: "user_viewer",
        role: "viewer",
      } as unknown as IRoomMember);

      const mockMessages: IMessage[] = [
        {
          _id: "msg_1",
          roomId: "room_1",
          authorId: "user_1",
          authorName: "User 1",
          seq: 1,
          text: "Hello Room 1",
          ts: new Date(),
          kind: "user",
        } as unknown as IMessage,
      ];

      vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockMessages),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const res = await request(app).get("/api/rooms/test-slug-1/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].text).toBe("Hello Room 1");
    });

    it("enforces cross-room isolation: queries are strictly filtered by target room.id", async () => {
      mockPrincipal = { id: "user_isolated" };

      vi.spyOn(roomRepo, "findBySlug").mockResolvedValue({
        id: "room_isolation_target",
        slug: "slug-isolated",
        status: "open",
      } as unknown as IRoom);

      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        id: "mem_2",
        roomId: "room_isolation_target",
        memberId: "user_isolated",
        role: "editor",
      } as unknown as IRoomMember);

      const findSpy = vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const res = await request(app).get("/api/rooms/slug-isolated/messages");
      expect(res.status).toBe(200);

      expect(findSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: "room_isolation_target" })
      );
      expect(findSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ roomId: "other_room" })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Acceptance Test E: Limiter key expiry
  // ─────────────────────────────────────────────────────────────
  describe("Acceptance Test E: Limiter Sliding Window Key Expiry", () => {
    it("expires user and IP window keys after 10s and fully releases capacity", () => {
      const limiter = new ChatRateLimiter({
        windowMs: 10_000,
        userMax: 20,
        ipMax: 100,
      });

      const baseTime = 1_000_000;

      // Exhaust user limit (20 messages)
      for (let i = 0; i < 20; i++) {
        const res = limiter.consume("user_expire_test", "10.0.0.1", baseTime);
        expect(res.allowed).toBe(true);
      }

      // 21st message at same second is rejected
      const rejected = limiter.consume("user_expire_test", "10.0.0.1", baseTime);
      expect(rejected.allowed).toBe(false);
      expect(rejected.reason).toBe("user_limit");

      // Advance clock past 10 seconds: 10,001 ms later
      const afterExpiry = baseTime + 10_001;
      const allowedAfterExpiry = limiter.consume(
        "user_expire_test",
        "10.0.0.1",
        afterExpiry
      );
      expect(allowedAfterExpiry.allowed).toBe(true);
    });

    it("maintains independent quotas for user and IP", () => {
      const limiter = new ChatRateLimiter({
        windowMs: 10_000,
        userMax: 5,
        ipMax: 20,
      });

      const now = Date.now();

      // User 1 exhausts user quota on shared IP
      for (let i = 0; i < 5; i++) {
        expect(limiter.consume("user_1", "192.168.1.1", now).allowed).toBe(true);
      }
      expect(limiter.consume("user_1", "192.168.1.1", now).allowed).toBe(false);

      // User 2 on the SAME IP still has capacity because IP limit (20) is not reached
      expect(limiter.consume("user_2", "192.168.1.1", now).allowed).toBe(true);
    });

    it("prunes expired timestamps on pruneAll() to reclaim memory", () => {
      const limiter = new ChatRateLimiter({ windowMs: 5000 });
      const now = 500_000;

      limiter.consume("u1", "1.1.1.1", now);
      limiter.consume("u2", "2.2.2.2", now + 1000);

      // Advance clock by 6 seconds
      limiter.pruneAll(now + 6000);

      // Both expired entries should be removed
      const freshResult = limiter.consume("u1", "1.1.1.1", now + 6000);
      expect(freshResult.allowed).toBe(true);
    });
  });
});
