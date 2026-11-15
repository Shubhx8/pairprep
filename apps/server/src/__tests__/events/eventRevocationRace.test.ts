import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { authorizeRoomEvent } from "../../events/authorization.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { UserModel } from "../../models/users.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { EventErrorCode } from "@pairprep/shared";
import type { UserPrincipal } from "../../middleware/identity.js";

describe("T09 Phase 1 — Race & Revocation Authorization Linearization", () => {
  const validRoomId = "507f1f77bcf86cd799439011";
  const validUserId = "507f1f77bcf86cd799439022";

  const mockUserPrincipal: UserPrincipal = {
    type: "user",
    id: validUserId,
    displayName: "Racing User",
    role: "user",
    user: {
      id: validUserId,
      displayName: "Racing User",
      role: "user",
      disabled: false,
    } as unknown as never,
  };

  const mockRoom = {
    id: validRoomId,
    _id: validRoomId,
    title: "Race Room",
    slug: "ungw83kd92mf74js",
    ownerId: "507f1f77bcf86cd799439099",
    status: "open",
  };

  const mockMember = {
    id: "507f1f77bcf86cd799439044",
    _id: "507f1f77bcf86cd799439044",
    roomId: validRoomId,
    memberId: validUserId,
    displayName: "Racing User",
    role: "editor",
    isGuest: false,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    syncRegistry.resetAll();

    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

    vi.spyOn(UserModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        id: validUserId,
        disabled: false,
      }),
    } as unknown as never);

    vi.spyOn(RoomModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockRoom),
    } as unknown as never);

    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockMember),
    } as unknown as never);
  });

  it("1. Member removal racing with event: once removal takes effect, subsequent protected operations are rejected", async () => {
    // Member exists initially
    const preRemoval = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      allowedRoles: ["editor"],
    });
    expect(preRemoval.authorized).toBe(true);

    // Concurrent removal: DB document deleted (e.g. owner kicks member via REST)
    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as unknown as never);

    // Linearization point: authorizeRoomEvent queries DB at event execution
    const postRemoval = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      allowedRoles: ["editor"],
    });

    expect(postRemoval.authorized).toBe(false);
    if (!postRemoval.authorized) {
      expect(postRemoval.code).toBe(EventErrorCode.NOT_ROOM_MEMBER);
    }
  });

  it("2. Role change racing with event: once demoted to viewer, editor-only operations are rejected", async () => {
    // Editor role initially
    const preDemotion = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      allowedRoles: ["editor", "owner"],
    });
    expect(preDemotion.authorized).toBe(true);

    // Concurrent demotion: role updated to viewer in DB
    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        ...mockMember,
        role: "viewer",
      }),
    } as unknown as never);

    // Linearization point: authorizeRoomEvent observes demoted role
    const postDemotion = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      allowedRoles: ["editor", "owner"],
    });

    expect(postDemotion.authorized).toBe(false);
    if (!postDemotion.authorized) {
      expect(postDemotion.code).toBe(EventErrorCode.INSUFFICIENT_ROLE);
    }

    // But viewer-allowed operations still succeed
    const viewerAllowed = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      allowedRoles: ["owner", "editor", "viewer"],
    });
    expect(viewerAllowed.authorized).toBe(true);
  });

  it("3. Room ending racing with write event: once room status changes to ended, write operations are rejected", async () => {
    // Room open initially
    const preEnding = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      requireWritable: true,
    });
    expect(preEnding.authorized).toBe(true);

    // Concurrent end room: status updated to 'ended' in DB
    vi.spyOn(RoomModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        ...mockRoom,
        status: "ended",
      }),
    } as unknown as never);

    // Write operations must fail with ROOM_CLOSED
    const postEndingWrite = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      requireWritable: true,
    });

    expect(postEndingWrite.authorized).toBe(false);
    if (!postEndingWrite.authorized) {
      expect(postEndingWrite.code).toBe(EventErrorCode.ROOM_CLOSED);
    }

    // Read operations (requireWritable: false) still succeed
    const postEndingRead = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
      requireWritable: false,
    });
    expect(postEndingRead.authorized).toBe(true);
  });

  it("4. Room deletion racing with event: once deleted, all operations are rejected with ROOM_NOT_FOUND", async () => {
    // Room exists initially
    const preDelete = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
    });
    expect(preDelete.authorized).toBe(true);

    // Concurrent delete: Room document deleted in DB
    vi.spyOn(RoomModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as unknown as never);

    const postDelete = await authorizeRoomEvent({
      principal: mockUserPrincipal,
      roomId: validRoomId,
    });

    expect(postDelete.authorized).toBe(false);
    if (!postDelete.authorized) {
      expect(postDelete.code).toBe(EventErrorCode.ROOM_NOT_FOUND);
    }
  });

  it("5. Multiple concurrent events linearize against latest authoritative state", async () => {
    let callCount = 0;
    // Simulate member being removed after exactly 2 successful calls
    vi.spyOn(RoomMemberModel, "findOne").mockImplementation(() => {
      callCount++;
      return {
        exec: vi.fn().mockResolvedValue(callCount <= 2 ? mockMember : null),
      } as unknown as never;
    });

    const results = await Promise.all([
      authorizeRoomEvent({ principal: mockUserPrincipal, roomId: validRoomId }),
      authorizeRoomEvent({ principal: mockUserPrincipal, roomId: validRoomId }),
      authorizeRoomEvent({ principal: mockUserPrincipal, roomId: validRoomId }),
      authorizeRoomEvent({ principal: mockUserPrincipal, roomId: validRoomId }),
    ]);

    const authorized = results.filter((r) => r.authorized);
    const rejected = results.filter((r) => !r.authorized);

    expect(authorized.length).toBe(2);
    expect(rejected.length).toBe(2);
    rejected.forEach((r) => {
      if (!r.authorized) {
        expect(r.code).toBe(EventErrorCode.NOT_ROOM_MEMBER);
      }
    });
  });
});
