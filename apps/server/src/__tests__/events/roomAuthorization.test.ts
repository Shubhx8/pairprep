import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { authorizeRoomEvent } from "../../events/authorization.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { UserModel } from "../../models/users.js";
import { GuestModel } from "../../models/guests.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { EventErrorCode } from "@pairprep/shared";
import type { UserPrincipal, GuestPrincipal } from "../../middleware/identity.js";

describe("T09 Phase 1 — Authoritative Room Authorization Service", () => {
  const validRoomId = "507f1f77bcf86cd799439011";
  const validUserId = "507f1f77bcf86cd799439022";
  const validGuestId = "507f1f77bcf86cd799439033";

  const mockUserPrincipal: UserPrincipal = {
    type: "user",
    id: validUserId,
    displayName: "Test User",
    role: "user",
    user: {
      id: validUserId,
      displayName: "Test User",
      role: "user",
      disabled: false,
    } as unknown as never,
  };

  const mockGuestPrincipal: GuestPrincipal = {
    type: "guest",
    id: validGuestId,
    displayName: "Test Guest",
    roomId: validRoomId,
    guest: {
      id: validGuestId,
      displayName: "Test Guest",
      roomId: validRoomId,
      expiresAt: new Date(Date.now() + 86400000),
    } as unknown as never,
  };

  const mockRoom = {
    id: validRoomId,
    _id: validRoomId,
    title: "Test Room",
    slug: "ungw83kd92mf74js",
    ownerId: validUserId,
    status: "open",
  };

  const mockMember = {
    id: "507f1f77bcf86cd799439044",
    _id: "507f1f77bcf86cd799439044",
    roomId: validRoomId,
    memberId: validUserId,
    displayName: "Test User",
    role: "editor",
    isGuest: false,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    syncRegistry.resetAll();

    // Default: mongoose connection is ready
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

    // Default database spies
    vi.spyOn(UserModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        id: validUserId,
        disabled: false,
      }),
    } as unknown as never);

    vi.spyOn(GuestModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        id: validGuestId,
        roomId: validRoomId,
        expiresAt: new Date(Date.now() + 86400000),
      }),
    } as unknown as never);

    vi.spyOn(RoomModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockRoom),
    } as unknown as never);

    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockMember),
    } as unknown as never);
  });

  describe("1. Authentication & Principal Verification", () => {
    it("rejects missing principal with UNAUTHENTICATED", async () => {
      const result = await authorizeRoomEvent({
        principal: null,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.UNAUTHENTICATED);
        expect(result.message).toMatch(/authentication required/i);
      }
    });

    it("rejects disabled user account with ACCOUNT_DISABLED", async () => {
      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          id: validUserId,
          disabled: true,
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.ACCOUNT_DISABLED);
        expect(result.message).toMatch(/account is disabled/i);
      }
    });

    it("rejects expired guest principal with GUEST_EXPIRED", async () => {
      vi.spyOn(GuestModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          id: validGuestId,
          roomId: validRoomId,
          expiresAt: new Date(Date.now() - 1000), // Expired 1s ago
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockGuestPrincipal,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.GUEST_EXPIRED);
        expect(result.message).toMatch(/guest session has expired/i);
      }
    });

    it("rejects guest attempting to access different room with FORBIDDEN", async () => {
      const otherRoomId = "507f1f77bcf86cd799439099";
      const result = await authorizeRoomEvent({
        principal: mockGuestPrincipal,
        roomId: otherRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.FORBIDDEN);
        expect(result.message).toMatch(/guest session is not valid for this room/i);
      }
    });

    it("fails closed when database is disconnected with INTERNAL_ERROR", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.INTERNAL_ERROR);
        expect(result.message).toMatch(/database unavailable/i);
      }
    });
  });

  describe("2. Room Existence & Lifecycle Checks", () => {
    it("rejects malformed roomId with BAD_REQUEST", async () => {
      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: "not-an-objectid",
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.BAD_REQUEST);
      }
    });

    it("rejects missing or deleted room with ROOM_NOT_FOUND", async () => {
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.ROOM_NOT_FOUND);
      }
    });

    it("rejects write operations on ended rooms with ROOM_CLOSED", async () => {
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockRoom,
          status: "ended",
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        requireWritable: true,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.ROOM_CLOSED);
      }
    });

    it("permits read operations on ended rooms when requireWritable is false", async () => {
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockRoom,
          status: "ended",
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        requireWritable: false,
      });

      expect(result.authorized).toBe(true);
    });

    it("rejects write operations on archived rooms with ROOM_CLOSED", async () => {
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockRoom,
          status: "archived",
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        requireWritable: true,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.ROOM_CLOSED);
      }
    });

    it("respects dynamic read-only locking via syncRegistry", async () => {
      syncRegistry.setRoomReadOnly(validRoomId);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        requireWritable: true,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.ROOM_CLOSED);
      }
    });
  });

  describe("3. Room Membership & Role Permissions", () => {
    it("rejects non-members with NOT_ROOM_MEMBER", async () => {
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null), // No membership document
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.NOT_ROOM_MEMBER);
        expect(result.message).toMatch(/not an active member/i);
      }
    });

    it("permits member when role matches allowedRoles", async () => {
      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        allowedRoles: ["editor", "owner"],
      });

      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.member.role).toBe("editor");
        expect(result.room.id).toBe(validRoomId);
      }
    });

    it("rejects viewer from editor/owner operation with INSUFFICIENT_ROLE", async () => {
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockMember,
          role: "viewer",
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        allowedRoles: ["editor", "owner"],
      });

      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.code).toBe(EventErrorCode.INSUFFICIENT_ROLE);
        expect(result.message).toMatch(/insufficient permissions/i);
      }
    });

    it("permits viewer for viewer-allowed operations (e.g. chat, join)", async () => {
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockMember,
          role: "viewer",
        }),
      } as unknown as never);

      const result = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        allowedRoles: ["owner", "editor", "viewer"],
      });

      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.member.role).toBe("viewer");
      }
    });
  });

  describe("4. Dynamic Authorization Revalidation & Revocation", () => {
    it("rejects previously connected socket after member is removed from database", async () => {
      // First check: user is member -> authorized
      const firstCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });
      expect(firstCheck.authorized).toBe(true);

      // Member removed in DB (e.g. by owner kick)
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as never);

      // Subsequent check for same socket: rejected!
      const subsequentCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });
      expect(subsequentCheck.authorized).toBe(false);
      if (!subsequentCheck.authorized) {
        expect(subsequentCheck.code).toBe(EventErrorCode.NOT_ROOM_MEMBER);
      }
    });

    it("rejects previously connected editor after demotion to viewer on editor-only event", async () => {
      // First check: role is editor
      const firstCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        allowedRoles: ["editor", "owner"],
      });
      expect(firstCheck.authorized).toBe(true);

      // Role changed to viewer in DB
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...mockMember,
          role: "viewer",
        }),
      } as unknown as never);

      // Subsequent check on same socket: rejected!
      const subsequentCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
        allowedRoles: ["editor", "owner"],
      });
      expect(subsequentCheck.authorized).toBe(false);
      if (!subsequentCheck.authorized) {
        expect(subsequentCheck.code).toBe(EventErrorCode.INSUFFICIENT_ROLE);
      }
    });

    it("rejects previously connected socket after user account is disabled", async () => {
      // First check: account active
      const firstCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });
      expect(firstCheck.authorized).toBe(true);

      // User disabled in DB
      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          id: validUserId,
          disabled: true,
        }),
      } as unknown as never);

      // Subsequent check on same socket: rejected!
      const subsequentCheck = await authorizeRoomEvent({
        principal: mockUserPrincipal,
        roomId: validRoomId,
      });
      expect(subsequentCheck.authorized).toBe(false);
      if (!subsequentCheck.authorized) {
        expect(subsequentCheck.code).toBe(EventErrorCode.ACCOUNT_DISABLED);
      }
    });
  });
});
