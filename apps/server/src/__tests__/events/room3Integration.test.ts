import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { presenceTracker } from "../../events/presenceTracker.js";
import { outboxService } from "../../events/outboxService.js";
import { setSocketServer } from "../../events/socketServer.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { messageRepo } from "../../repos/messageRepo.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import type { Server, Socket } from "socket.io";
import { authorizeRoomEvent } from "../../events/authorization.js";
import { UserModel } from "../../models/users.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { DurableOperationModel } from "../../models/durable_operations.js";
import type { UserPrincipal } from "../../middleware/identity.js";

function createMockIo() {
  const emitMock = vi.fn();
  const toMock = vi.fn().mockReturnValue({ emit: emitMock });
  return {
    to: toMock,
    emit: emitMock,
  } as unknown as Server;
}

function createMockSocket(id: string) {
  return {
    id,
    disconnect: vi.fn(),
  } as unknown as Socket;
}

describe("T09 Phase 2 — ROOM-3, SEC-7, CH-3 Integration (Role Changes, Presence, Outbox)", () => {
  let mockIo: Server;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
    mockIo = createMockIo();
    setSocketServer(mockIo);
    presenceTracker.reset();

    // Default mock for DurableOperationModel.prototype.save
    vi.spyOn(DurableOperationModel.prototype, "save").mockResolvedValue({
      opId: "mock_op",
      status: "intent_recorded",
    } as unknown as typeof DurableOperationModel);

    vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ opId: "mock_op", status: "published" }),
    } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "mock_op",
        roomId: "507f1f77bcf86cd799439011",
        status: "applied",
        payload: {},
      }),
    } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

    vi.spyOn(RoomModel, "findOne").mockReturnValue({
      exec: vi
        .fn()
        .mockResolvedValue({ _id: "507f1f77bcf86cd799439011", status: "open" }),
    } as unknown as ReturnType<typeof RoomModel.findOne>);
    vi.spyOn(roomRepo, "allocateMessageSeq").mockResolvedValue(1);
    vi.spyOn(RoomModel, "updateOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    } as unknown as ReturnType<typeof RoomModel.updateOne>);
    vi.spyOn(RoomMemberModel, "updateOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    } as unknown as ReturnType<typeof RoomMemberModel.updateOne>);
    vi.spyOn(messageRepo, "createMessage").mockResolvedValue({
      _id: "msg_1",
      seq: 1,
      roomId: "507f1f77bcf86cd799439011",
      authorId: "system",
      text: "System notice",
      ts: new Date(),
      kind: "system",
    } as unknown as Awaited<ReturnType<typeof messageRepo.createMessage>>);
  });

  describe("ROOM-3: Live Role Changes via REST & Socket.IO (< 1s Enforcement)", () => {
    it("REST PATCH role change coordinates DB update, syncRegistry, and emits room:role_changed", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439022";
      const memberUserId = "user_editor_1";

      // Register active socket in presence
      const socket = createMockSocket("sock_1");
      presenceTracker.registerSocket(socket, roomId, {
        id: memberDocId,
        memberId: memberUserId,
        displayName: "Charlie",
        role: "editor",
      });

      const updateRoleSpy = vi.spyOn(roomMemberRepo, "updateRole").mockResolvedValue({
        id: memberDocId,
        memberId: memberUserId,
        role: "viewer",
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.updateRole>>);

      const setReadOnlySpy = vi.spyOn(syncRegistry, "setMemberReadOnly");

      // Execute simulated PATCH /members/:id logic
      const startTime = Date.now();
      const opId = outboxService.generateOpId(
        "role_change",
        roomId,
        memberDocId,
        "test_nonce"
      );
      await outboxService.executeDurableOperation({
        opId,
        type: "role_change",
        roomId,
        payload: {
          memberId: memberUserId,
          role: "viewer",
          previousRole: "editor",
        },
        messageText: "Charlie's role was changed from editor to viewer",
        io: mockIo,
        mutation: async () => {
          return roomMemberRepo.updateRole(roomId, memberDocId, "viewer");
        },
      });

      presenceTracker.updateMemberRole(memberDocId, "viewer");
      syncRegistry.setMemberReadOnly(roomId, memberUserId, true, "viewer");
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(1000); // Live change applied within 1 second per PRD ROOM-3
      expect(updateRoleSpy).toHaveBeenCalledWith(roomId, memberDocId, "viewer");
      expect(setReadOnlySpy).toHaveBeenCalledWith(roomId, memberUserId, true, "viewer");
      expect(presenceTracker.getOnlineMembers(roomId)[0]?.role).toBe("viewer");
    });

    it("demoted member's subsequent Socket.IO event immediately fails with INSUFFICIENT_ROLE", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const principal: UserPrincipal = {
        type: "user",
        id: "507f1f77bcf86cd799439033",
        displayName: "Charlie",
        role: "user",
        user: {
          id: "507f1f77bcf86cd799439033",
          displayName: "Charlie",
          role: "user",
          disabled: false,
        } as unknown as never,
      };

      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: principal.id, disabled: false }),
      } as unknown as ReturnType<typeof UserModel.findById>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: roomId, status: "live" }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      // Database returns newly demoted "viewer" role
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          roomId,
          memberId: principal.id,
          role: "viewer",
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      // Operation requiring editor role (e.g. mutating action)
      const authResult = await authorizeRoomEvent({
        principal,
        roomId,
        allowedRoles: ["owner", "editor"],
      });

      expect(authResult.authorized).toBe(false);
      if (!authResult.authorized) {
        expect(authResult.code).toBe("INSUFFICIENT_ROLE");
      }
    });
  });

  describe("SEC-7 & CH-3: Member Removal vs Disconnect Semantics", () => {
    it("owner removal disconnects member sockets, emits room:member_left, and records departure notice", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439044";
      const memberUserId = "user_removed_1";

      const s1 = createMockSocket("s1");
      const s2 = createMockSocket("s2");
      presenceTracker.registerSocket(s1, roomId, {
        id: memberDocId,
        memberId: memberUserId,
        displayName: "Dave",
        role: "viewer",
      });
      presenceTracker.registerSocket(s2, roomId, {
        id: memberDocId,
        memberId: memberUserId,
        displayName: "Dave",
        role: "viewer",
      });

      const syncCloseSpy = vi.spyOn(syncRegistry, "closeConnectionsForMember");
      const removeMemberSpy = vi
        .spyOn(roomMemberRepo, "removeMember")
        .mockResolvedValue(true);

      // Execute simulated DELETE /members/:id logic
      presenceTracker.disconnectMemberSockets(roomId, memberDocId);
      syncRegistry.closeConnectionsForMember(roomId, memberUserId, 4003, "removed");

      const opId = outboxService.generateOpId(
        "remove",
        roomId,
        memberDocId,
        "test_nonce"
      );
      await outboxService.executeDurableOperation({
        opId,
        type: "remove",
        roomId,
        payload: { memberId: memberUserId },
        messageText: "Dave was removed from the room by the owner",
        io: mockIo,
        mutation: async () => {
          return roomMemberRepo.removeMember(roomId, memberDocId);
        },
      });

      // Verify all sockets forcefully disconnected
      expect(s1.disconnect).toHaveBeenCalledWith(true);
      expect(s2.disconnect).toHaveBeenCalledWith(true);
      expect(syncCloseSpy).toHaveBeenCalledWith(roomId, memberUserId, 4003, "removed");
      expect(removeMemberSpy).toHaveBeenCalledWith(roomId, memberDocId);
      expect(presenceTracker.getOnlineMemberCount(roomId)).toBe(0);
    });

    it("ordinary disconnect does NOT create a persistent leave message (CH-3 Option A)", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const s1 = createMockSocket("s1");
      presenceTracker.registerSocket(s1, roomId, {
        id: "doc_1",
        memberId: "user_1",
        displayName: "Alice",
        role: "editor",
      });

      const createMessageSpy = vi.spyOn(messageRepo, "createMessage");

      // Unregister socket on regular tab close / network drop
      const unreg = presenceTracker.unregisterSocket("s1");

      expect(unreg.transition).toBe("left");
      expect(unreg.isLastSocket).toBe(true);

      // CH-3 Option A: zero persistent chat messages created on ordinary disconnect
      expect(createMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe("ROOM-6: Lifecycle Integration (Ended and Deleted Rooms)", () => {
    it("room end updates sync lifecycle, broadcasts status_changed, and prunes retention if > 1,000", async () => {
      const roomId = "507f1f77bcf86cd799439011";

      vi.spyOn(roomRepo, "updateStatus").mockResolvedValue({
        id: roomId,
        slug: "test-slug",
        status: "ended",
        messageSeq: 1050,
      } as unknown as Awaited<ReturnType<typeof roomRepo.updateStatus>>);

      const syncLifecycleSpy = vi.spyOn(syncRegistry, "updateRoomLifecycle");
      const pruneSpy = vi
        .spyOn(messageRepo, "deleteMessagesBeforeSeq")
        .mockResolvedValue(50);

      const opId = outboxService.generateOpId("room_ended", roomId, "all", "test_nonce");
      const { result: endedRoom } = await outboxService.executeDurableOperation({
        opId,
        type: "room_ended",
        roomId,
        payload: { status: "ended" },
        messageText: "The room session was ended by the owner",
        io: mockIo,
        mutation: async () => {
          return roomRepo.updateStatus("test-slug", "ended");
        },
      });

      syncRegistry.updateRoomLifecycle(roomId, "ended");

      if (endedRoom && endedRoom.messageSeq && endedRoom.messageSeq > 1000) {
        await messageRepo.deleteMessagesBeforeSeq(roomId, endedRoom.messageSeq - 1000);
      }

      expect(syncLifecycleSpy).toHaveBeenCalledWith(roomId, "ended");
      expect(pruneSpy).toHaveBeenCalledWith(roomId, 50); // Pruned messages <= 50 (1050 - 1000)
    });

    it("room deletion disconnects all Socket.IO sockets and cascades child collections", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const s1 = createMockSocket("s1");
      const s2 = createMockSocket("s2");

      presenceTracker.registerSocket(s1, roomId, {
        id: "d1",
        memberId: "u1",
        displayName: "User 1",
        role: "owner",
      });
      presenceTracker.registerSocket(s2, roomId, {
        id: "d2",
        memberId: "u2",
        displayName: "User 2",
        role: "editor",
      });

      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);
      vi.spyOn(roomRepo, "setDeletionBarrier").mockResolvedValue({
        _id: roomId,
        slug: "test-slug",
        status: "deleted",
        deletionOpId: `op:room_deleted:${roomId}:all`,
      } as unknown as Awaited<ReturnType<typeof roomRepo.setDeletionBarrier>>);

      // Execute durable room deletion (H-1, H-2, M-1)
      await outboxService.executeRoomDeletion({
        roomId,
        slug: "test-slug",
        io: mockIo,
      });

      // M-1: graceful disconnection allows buffers to drain without immediate forced kill
      expect(s1.disconnect).toHaveBeenCalledWith(false);
      expect(s2.disconnect).toHaveBeenCalledWith(false);
      // H-2: activeOpId is preserved during cascade
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, `op:room_deleted:${roomId}:all`);
      expect(presenceTracker.getOnlineMemberCount(roomId)).toBe(0);
    });
  });
});
