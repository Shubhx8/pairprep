import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { RoomBanModel } from "../../models/room_bans.js";
import { RoomModel } from "../../models/rooms.js";
import { UserModel, type IUser } from "../../models/users.js";
import { GuestModel } from "../../models/guests.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { roomBanRepo } from "../../repos/roomBanRepo.js";
import { authorizeRoomEvent } from "../../events/authorization.js";
import type { UserPrincipal } from "../../middleware/identity.js";
import { EventErrorCode } from "@pairprep/shared";

describe("T09 Phase 1 & 2 — Canonical Permanent Ban Architecture & Enforcement", () => {
  const roomId = "507f1f77bcf86cd799439099";
  const userId = "507f1f77bcf86cd799439011";
  const guestId = "507f1f77bcf86cd799439022";
  const ownerId = "507f1f77bcf86cd799439000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Canonical Ban Persistence & Idempotency", () => {
    it("banPrincipal performs an atomic upsert into room_bans with $setOnInsert", async () => {
      const updateOneSpy = vi.spyOn(RoomBanModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, upsertedCount: 1 }),
      } as unknown as ReturnType<typeof RoomBanModel.updateOne>);

      const roomUpdateSpy = vi.spyOn(RoomModel, "findByIdAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({}),
      } as unknown as ReturnType<typeof RoomModel.findByIdAndUpdate>);

      // Mock mongoose connection readyState
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

      await roomBanRepo.banPrincipal(
        roomId,
        { id: userId, type: "user" },
        ownerId,
        "kicked_by_owner"
      );

      expect(updateOneSpy).toHaveBeenCalledWith(
        {
          roomId,
          principalType: "user",
          principalId: userId,
        },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            bannedBy: ownerId,
            reason: "kicked_by_owner",
          }),
        }),
        { upsert: true }
      );

      expect(roomUpdateSpy).toHaveBeenCalledWith(roomId, {
        $addToSet: { bannedMemberIds: userId },
      });
    });

    it("isBanned returns true if principal exists in room_bans", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
      vi.spyOn(RoomBanModel, "exists").mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
      } as unknown as { _id: mongoose.Types.ObjectId });

      const banned = await roomBanRepo.isBanned(roomId, "user", userId);
      expect(banned).toBe(true);
      expect(RoomBanModel.exists).toHaveBeenCalledWith({
        roomId,
        principalType: "user",
        principalId: userId,
      });
    });

    it("isBanned falls back to room.bannedMemberIds for legacy support", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
      vi.spyOn(RoomBanModel, "exists").mockResolvedValue(null);
      vi.spyOn(RoomModel, "exists").mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
      } as unknown as { _id: mongoose.Types.ObjectId });

      const banned = await roomBanRepo.isBanned(roomId, "guest", guestId);
      expect(banned).toBe(true);
      expect(RoomModel.exists).toHaveBeenCalledWith({
        _id: roomId,
        bannedMemberIds: guestId,
      });
    });

    it("isBanned returns false if neither room_bans nor legacy array matches", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
      vi.spyOn(RoomBanModel, "exists").mockResolvedValue(null);
      vi.spyOn(RoomModel, "exists").mockResolvedValue(null);

      const banned = await roomBanRepo.isBanned(roomId, "user", "clean_user");
      expect(banned).toBe(false);
    });

    it("deleteBansForRoom cascades ban deletion when room is deleted", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
      const deleteSpy = vi.spyOn(RoomBanModel, "deleteMany").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      } as unknown as ReturnType<typeof RoomBanModel.deleteMany>);

      const deleted = await roomBanRepo.deleteBansForRoom(roomId);
      expect(deleted).toBe(3);
      expect(deleteSpy).toHaveBeenCalledWith({ roomId });
    });
  });

  describe("2. Legacy Ban Migration", () => {
    it("migrates legacy bannedMemberIds resolving user vs guest identities", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

      const mockRooms = [
        {
          _id: new mongoose.Types.ObjectId(roomId),
          ownerId: new mongoose.Types.ObjectId(ownerId),
          bannedMemberIds: [userId, guestId, "unresolved_id_123456789012"],
          createdAt: new Date("2026-11-01T00:00:00Z"),
        },
      ];

      vi.spyOn(RoomModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockRooms),
        }),
      } as unknown as ReturnType<typeof RoomModel.find>);

      // User exists for userId
      vi.spyOn(UserModel, "exists").mockImplementation(((filter: unknown) => {
        const id = (filter as { _id: string })._id;
        return Promise.resolve(
          id === userId ? { _id: new mongoose.Types.ObjectId() } : null
        );
      }) as never);

      // Guest exists for guestId
      vi.spyOn(GuestModel, "exists").mockImplementation(((filter: unknown) => {
        const id = (filter as { _id: string })._id;
        return Promise.resolve(
          id === guestId ? { _id: new mongoose.Types.ObjectId() } : null
        );
      }) as never);

      const upsertSpy = vi.spyOn(RoomBanModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true }),
      } as unknown as ReturnType<typeof RoomBanModel.updateOne>);

      const res = await roomBanRepo.migrateLegacyBans();

      expect(res.migratedCount).toBe(3);
      expect(res.unresolvedCount).toBe(1); // unresolved_id_123456789012
      expect(res.errors).toHaveLength(0);

      // Verify userId was migrated as user
      expect(upsertSpy).toHaveBeenCalledWith(
        { roomId, principalType: "user", principalId: userId },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            reason: "migrated_from_legacy_bannedMemberIds",
          }),
        }),
        { upsert: true }
      );

      // Verify guestId was migrated as guest
      expect(upsertSpy).toHaveBeenCalledWith(
        { roomId, principalType: "guest", principalId: guestId },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            reason: "migrated_from_legacy_bannedMemberIds",
          }),
        }),
        { upsert: true }
      );

      // Verify unresolved was migrated with fallback provenance
      expect(upsertSpy).toHaveBeenCalledWith(
        { roomId, principalType: "user", principalId: "unresolved_id_123456789012" },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            reason: "migrated_legacy_unresolved_provenance",
          }),
        }),
        { upsert: true }
      );
    });

    it("migration is safely repeatable and idempotent without corrupting data", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

      vi.spyOn(RoomModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            {
              _id: new mongoose.Types.ObjectId(roomId),
              ownerId: new mongoose.Types.ObjectId(ownerId),
              bannedMemberIds: [userId],
            },
          ]),
        }),
      } as unknown as ReturnType<typeof RoomModel.find>);

      vi.spyOn(UserModel, "exists").mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
      } as unknown as { _id: mongoose.Types.ObjectId });
      const upsertSpy = vi.spyOn(RoomBanModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      } as unknown as ReturnType<typeof RoomBanModel.updateOne>);

      // Run twice
      const run1 = await roomBanRepo.migrateLegacyBans();
      const run2 = await roomBanRepo.migrateLegacyBans();

      expect(run1.migratedCount).toBe(1);
      expect(run2.migratedCount).toBe(1);
      expect(upsertSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("3. Protocol-Level Ban Authorization Checks", () => {
    it("authorizeRoomEvent rejects permanently banned user with FORBIDDEN", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: userId, disabled: false }),
      } as unknown as ReturnType<typeof UserModel.findById>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: roomId,
          id: roomId,
          status: "open",
        }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      // Mock isBanned -> true
      vi.spyOn(roomBanRepo, "isBanned").mockResolvedValue(true);

      const mockPrincipal: UserPrincipal = {
        type: "user",
        id: userId,
        displayName: "Alice",
        role: "user",
        user: {
          _id: new mongoose.Types.ObjectId(userId),
          disabled: false,
        } as unknown as IUser,
      };

      const authRes = await authorizeRoomEvent({
        principal: mockPrincipal,
        roomId,
      });

      expect(authRes.authorized).toBe(false);
      if (!authRes.authorized) {
        expect(authRes.code).toBe(EventErrorCode.FORBIDDEN);
        expect(authRes.message).toBe("Banned from room");
      }
    });

    it("authorizeRoomEvent allows non-banned active member", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: userId, disabled: false }),
      } as unknown as ReturnType<typeof UserModel.findById>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: roomId,
          id: roomId,
          status: "open",
        }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      vi.spyOn(roomBanRepo, "isBanned").mockResolvedValue(false);

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          id: "doc_alice",
          roomId,
          memberId: userId,
          role: "editor",
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      const mockPrincipal: UserPrincipal = {
        type: "user",
        id: userId,
        displayName: "Alice",
        role: "user",
        user: {
          _id: new mongoose.Types.ObjectId(userId),
          disabled: false,
        } as unknown as IUser,
      };

      const authRes = await authorizeRoomEvent({
        principal: mockPrincipal,
        roomId,
      });

      expect(authRes.authorized).toBe(true);
    });
  });
});
