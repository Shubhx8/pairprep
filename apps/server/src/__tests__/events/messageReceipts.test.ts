import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageRepo, messageRepo } from "../../repos/messageRepo.js";
import { MessageModel } from "../../models/messages.js";
import { toMessageDto, EventErrorCode, type EventAck } from "@pairprep/shared";
import { attachRoomEventHandlers } from "../../events/roomEvents.js";
import * as authModule from "../../events/authorization.js";
import type { TypedSocket } from "../../events/eventDispatcher.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { RoomModel, type IRoom } from "../../models/rooms.js";
import { roomMutationBarrier } from "../../events/roomMutationBarrier.js";
import { OutboxService } from "../../events/outboxService.js";
import { DurableOperationModel } from "../../models/durable_operations.js";

describe("T09 Controlled Remediation — Genuine WhatsApp Message Receipts & Persistence", () => {
  let testRepo: MessageRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    testRepo = new MessageRepo();
  });

  describe("MessageRepo markDelivered & markRead", () => {
    it("1. markDelivered idempotently adds recipient memberId to deliveredTo array", async () => {
      const mockDoc = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        seq: 1,
        authorId: "user_alice",
        text: "Hello Bob",
        ts: new Date(),
        deliveredTo: ["user_bob"],
        readBy: [],
      };

      vi.spyOn(MessageModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockDoc),
      } as unknown as ReturnType<typeof MessageModel.findOneAndUpdate>);

      const result = await testRepo.markDelivered(
        "507f1f77bcf86cd799439099",
        "507f1f77bcf86cd799439011",
        "user_bob"
      );

      expect(MessageModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: "507f1f77bcf86cd799439011",
          roomId: "507f1f77bcf86cd799439099",
          $or: [
            { recipientIds: { $exists: false } },
            { recipientIds: { $size: 0 } },
            { recipientIds: "user_bob" },
          ],
          excludedRecipientIds: { $ne: "user_bob" },
        },
        { $addToSet: { deliveredTo: "user_bob" } },
        { new: true }
      );
      expect(result?.deliveredTo).toContain("user_bob");
    });

    it("2. markRead idempotently adds recipient to readBy AND deliveredTo array", async () => {
      const mockDoc = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        seq: 1,
        authorId: "user_alice",
        text: "Hello Bob",
        ts: new Date(),
        deliveredTo: ["user_bob"],
        readBy: ["user_bob"],
      };

      vi.spyOn(MessageModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockDoc),
      } as unknown as ReturnType<typeof MessageModel.findOneAndUpdate>);

      const result = await testRepo.markRead(
        "507f1f77bcf86cd799439099",
        "507f1f77bcf86cd799439011",
        "user_bob"
      );

      expect(MessageModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: "507f1f77bcf86cd799439011",
          roomId: "507f1f77bcf86cd799439099",
          $or: [
            { recipientIds: { $exists: false } },
            { recipientIds: { $size: 0 } },
            { recipientIds: "user_bob" },
          ],
          excludedRecipientIds: { $ne: "user_bob" },
        },
        { $addToSet: { readBy: "user_bob", deliveredTo: "user_bob" } },
        { new: true }
      );
      expect(result?.readBy).toContain("user_bob");
      expect(result?.deliveredTo).toContain("user_bob");
    });
  });

  describe("toMessageDto receipt serialization", () => {
    it("3. serializes recipientIds, deliveredTo, and readBy arrays onto MessageDto", () => {
      const dbMsg = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        authorId: "user_alice",
        authorName: "Alice",
        seq: 5,
        text: "Verified message",
        ts: new Date("2026-11-16T12:00:00Z"),
        kind: "user" as const,
        recipientIds: ["user_bob", "user_charlie"],
        deliveredTo: ["user_bob", "user_charlie"],
        readBy: ["user_bob"],
      };

      const dto = toMessageDto(dbMsg);

      expect(dto.id).toBe("507f1f77bcf86cd799439011");
      expect(dto.recipientIds).toEqual(["user_bob", "user_charlie"]);
      expect(dto.deliveredTo).toEqual(["user_bob", "user_charlie"]);
      expect(dto.readBy).toEqual(["user_bob"]);
    });

    it("4. handles missing deliveredTo and readBy gracefully", () => {
      const dbMsg = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        authorId: "user_alice",
        seq: 1,
        text: "Legacy message",
        ts: "2026-11-16T12:00:00.000Z",
      };

      const dto = toMessageDto(dbMsg);
      expect(dto.deliveredTo).toBeUndefined();
      expect(dto.readBy).toBeUndefined();
    });
  });

  describe("Receipt Monotonicity and Integrity", () => {
    it("5. status cannot regress: reading guarantees delivered state remains present", async () => {
      const msg = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        seq: 1,
        authorId: "user_alice",
        text: "Important message",
        ts: new Date(),
        deliveredTo: ["user_bob"],
        readBy: ["user_bob"],
      };

      // Simulating a delayed delivery event arriving after read
      vi.spyOn(MessageModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(msg),
      } as unknown as ReturnType<typeof MessageModel.findOneAndUpdate>);

      await testRepo.markDelivered(msg.roomId, msg._id, "user_bob");

      // Verify deliveredTo and readBy both contain user_bob
      expect(msg.deliveredTo).toContain("user_bob");
      expect(msg.readBy).toContain("user_bob");
    });

    it("6. duplicate receipts are idempotent with $addToSet and do not corrupt state", async () => {
      const msg = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        seq: 1,
        authorId: "user_alice",
        text: "Idempotent message",
        ts: new Date(),
        deliveredTo: ["user_bob"],
        readBy: ["user_bob"],
      };

      const findOneAndUpdateSpy = vi
        .spyOn(MessageModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(msg),
        } as unknown as ReturnType<typeof MessageModel.findOneAndUpdate>);

      // Call markDelivered twice with same member
      await testRepo.markDelivered(msg.roomId, msg._id, "user_bob");
      await testRepo.markDelivered(msg.roomId, msg._id, "user_bob");

      expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(2);
      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        {
          _id: msg._id,
          roomId: msg.roomId,
          $or: [
            { recipientIds: { $exists: false } },
            { recipientIds: { $size: 0 } },
            { recipientIds: "user_bob" },
          ],
          excludedRecipientIds: { $ne: "user_bob" },
        },
        { $addToSet: { deliveredTo: "user_bob" } },
        { new: true }
      );
    });

    it("7. tracks multiple independent recipients in group rooms", async () => {
      const msg = {
        _id: "507f1f77bcf86cd799439011",
        roomId: "507f1f77bcf86cd799439099",
        seq: 1,
        authorId: "user_alice",
        text: "Group sync message",
        ts: new Date(),
        recipientIds: ["user_bob", "user_charlie", "user_dan"],
        deliveredTo: ["user_bob", "user_charlie"],
        readBy: ["user_bob"],
      };

      vi.spyOn(MessageModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(msg),
      } as unknown as ReturnType<typeof MessageModel.findOneAndUpdate>);

      const res = await testRepo.markRead(msg.roomId, msg._id, "user_charlie");
      expect(res?.deliveredTo).toContain("user_bob");
      expect(res?.deliveredTo).toContain("user_charlie");
      expect(res?.readBy).toContain("user_bob");
    });
  });

  describe("Socket Event Protocol & Authorization Checks", () => {
    const roomId = "507f1f77bcf86cd799439099";
    const messageId = "507f1f77bcf86cd799439011";
    let handlers: Record<
      string,
      (payload: unknown, ack?: (res: unknown) => void) => Promise<void>
    >;
    let mockSocket: TypedSocket;

    beforeEach(() => {
      handlers = {};
      mockSocket = {
        id: "mock_socket_user_bob",
        data: {
          principal: {
            type: "user",
            id: "user_bob",
            displayName: "Bob",
            role: "user",
          },
        },
        on: vi.fn((event: string, handler: unknown) => {
          handlers[event] = handler as (
            payload: unknown,
            ack?: (res: unknown) => void
          ) => Promise<void>;
          return mockSocket;
        }),
        emit: vi.fn(),
        to: vi.fn().mockReturnThis(),
      } as unknown as TypedSocket;

      vi.spyOn(authModule, "authorizeRoomEvent").mockResolvedValue({
        authorized: true,
        room: {
          id: roomId,
          status: "open",
        } as unknown as import("../../models/rooms.js").IRoom,
        member: {
          id: "doc_bob",
          memberId: "user_bob",
          displayName: "Bob",
          role: "editor",
        } as unknown as import("../../models/room_members.js").IRoomMember,
        principal: {
          type: "user",
          id: "user_bob",
          displayName: "Bob",
          role: "user",
        } as unknown as import("../../middleware/identity.js").Principal,
      });

      attachRoomEventHandlers(mockSocket);
    });

    it("8. chat:delivered is rejected with FORBIDDEN if sender attempts self-delivery", async () => {
      const selfMessage = {
        _id: messageId,
        roomId,
        authorId: "user_bob", // bob is the sender
        seq: 1,
        recipientIds: ["user_alice"],
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(selfMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:delivered"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("Sender cannot acknowledge delivery");
      }
    });

    it("9. chat:delivered is rejected with FORBIDDEN if user is not in message.recipientIds", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 2,
        recipientIds: ["user_charlie"], // bob is NOT in recipientIds
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:delivered"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("not an eligible recipient");
      }
    });

    it("10. chat:delivered succeeds for eligible recipient and broadcasts to room", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 3,
        recipientIds: ["user_bob"],
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      const markDeliveredSpy = vi
        .spyOn(messageRepo, "markDelivered")
        .mockResolvedValue({} as unknown as import("../../models/messages.js").IMessage);

      let ackResult: EventAck | undefined;
      await handlers["chat:delivered"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(true);
      if (ackResult?.ok) {
        expect(ackResult.data).toEqual({
          messageId,
          delivered: true,
        });
      }
      expect(markDeliveredSpy).toHaveBeenCalledWith(roomId, messageId, "user_bob");
    });

    it("11. chat:read is rejected with FORBIDDEN if sender attempts self-read", async () => {
      const selfMessage = {
        _id: messageId,
        roomId,
        authorId: "user_bob", // bob is the sender
        seq: 1,
        recipientIds: ["user_alice"],
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(selfMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:read"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("Sender cannot acknowledge read");
      }
    });

    it("12. chat:read is rejected with FORBIDDEN if user is not in message.recipientIds", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 4,
        recipientIds: ["user_charlie"], // bob is NOT in recipientIds
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:read"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("not an eligible recipient");
      }
    });

    it("13. chat:read succeeds for eligible recipient and invokes messageRepo.markRead", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 5,
        recipientIds: ["user_bob"],
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      const markReadSpy = vi
        .spyOn(messageRepo, "markRead")
        .mockResolvedValue({} as unknown as import("../../models/messages.js").IMessage);

      let ackResult: EventAck | undefined;
      await handlers["chat:read"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(true);
      if (ackResult?.ok) {
        expect(ackResult.data).toEqual({
          messageId,
          read: true,
        });
      }
      expect(markReadSpy).toHaveBeenCalledWith(roomId, messageId, "user_bob");
    });

    it("14. chat:delivered is rejected with FORBIDDEN if recipient was subsequently excluded", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 6,
        recipientIds: ["user_bob"],
        excludedRecipientIds: ["user_bob"], // bob was removed from room
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:delivered"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("not an eligible recipient");
      }
    });

    it("15. chat:read is rejected with FORBIDDEN if recipient was subsequently excluded", async () => {
      const peerMessage = {
        _id: messageId,
        roomId,
        authorId: "user_alice",
        seq: 7,
        recipientIds: ["user_bob"],
        excludedRecipientIds: ["user_bob"], // bob was removed from room
      };

      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(peerMessage),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      let ackResult: EventAck | undefined;
      await handlers["chat:read"]!({ roomId, messageId }, (res) => {
        ackResult = res as EventAck;
      });

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.FORBIDDEN);
        expect(ackResult?.error.message).toContain("not an eligible recipient");
      }
    });

    it("16. excludeRecipientFromRoomMessages calls updateMany with $addToSet on excludedRecipientIds", async () => {
      const updateManySpy = vi.spyOn(MessageModel, "updateMany").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 3 }),
      } as unknown as ReturnType<typeof MessageModel.updateMany>);

      const count = await testRepo.excludeRecipientFromRoomMessages(roomId, "user_bob");

      expect(updateManySpy).toHaveBeenCalledWith(
        { roomId, recipientIds: "user_bob" },
        { $addToSet: { excludedRecipientIds: "user_bob" } }
      );
      expect(count).toBe(3);
    });

    it("17. removeByMemberId stages tombstone, excludes receipts, decrements memberCount, and deletes doc (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const memberDoc = {
        _id: "507f1f77bcf86cd799439033",
        roomId,
        memberId: "guest_bob",
        displayName: "Bob",
      };

      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(memberDoc),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({ removedMembers: [] }),
        }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      const updateRoomSpy = vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(2);

      const result = await roomMemberRepo.removeByMemberId(roomId, "guest_bob");

      expect(result).toBe(true);
      expect(excludeSpy).toHaveBeenCalledWith(roomId, "guest_bob");
      expect(updateRoomSpy).toHaveBeenCalled();
      expect(deleteDocSpy).toHaveBeenCalled();
    });

    it("18. purgeExpiredGuestMembers identifies expired guests and excludes them from message receipts (BUG-02)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      vi.spyOn(RoomMemberModel, "distinct").mockResolvedValue([roomId]);

      vi.spyOn(RoomMemberModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi
            .fn()
            .mockResolvedValue([
              { memberId: "expired_guest_1" },
              { memberId: "expired_guest_2" },
            ]),
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.find>);

      vi.spyOn(RoomMemberModel, "deleteMany").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 2 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteMany>);

      vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(4);

      const cutoff = new Date();
      const purged = await roomMemberRepo.purgeExpiredGuestMembers(cutoff);

      expect(purged).toBe(2);
      expect(excludeSpy).toHaveBeenCalledWith(roomId, [
        "expired_guest_1",
        "expired_guest_2",
      ]);
    });

    it("19. outbox crash recovery for remove operation invokes excludeRecipientFromRoomMessages (BUG-03)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:member_victim:99999`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "507f1f77bcf86cd799439044",
          memberId: "user_victim",
        },
      };

      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);
      vi.spyOn(roomRepo, "clearOperationEvidence").mockResolvedValue();

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      // Simulate crash between staged tombstone and completion
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd799439044",
          roomId,
          memberId: "user_victim",
          tombstoneOpId: opId,
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(1);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(excludeSpy).toHaveBeenCalledWith(roomId, "user_victim");
    });

    it("20. removeByMemberId retry after tombstone avoids double-decrementing memberCount (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const memberDoc = {
        _id: "507f1f77bcf86cd799439033",
        roomId,
        memberId: "guest_bob",
        tombstoneOpId: `departure:${roomId}:guest_bob`,
      };

      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(memberDoc),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({
            removedMembers: [{ opId: `departure:${roomId}:guest_bob` }],
          }),
        }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      const updateRoomSpy = vi.spyOn(RoomModel, "updateOne");
      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(0);

      const result = await roomMemberRepo.removeByMemberId(roomId, "guest_bob");

      expect(result).toBe(true);
      expect(excludeSpy).toHaveBeenCalledWith(roomId, "guest_bob");
      expect(updateRoomSpy).not.toHaveBeenCalled();
      expect(deleteDocSpy).toHaveBeenCalled();
    });

    it("21. removeByMemberId failure in receipt exclusion halts before deleting member doc (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const memberDoc = {
        _id: "507f1f77bcf86cd799439033",
        roomId,
        memberId: "guest_bob",
      };

      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(memberDoc),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      vi.spyOn(messageRepo, "excludeRecipientFromRoomMessages").mockRejectedValue(
        new Error("Database write failure")
      );

      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne");

      await expect(roomMemberRepo.removeByMemberId(roomId, "guest_bob")).rejects.toThrow(
        "Database write failure"
      );

      expect(deleteDocSpy).not.toHaveBeenCalled();
    });

    it("22. purgeExpiredGuestMembers skips non-guests and members with null/missing expiry (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const distinctSpy = vi.spyOn(RoomMemberModel, "distinct").mockResolvedValue([]);

      const cutoff = new Date();
      await roomMemberRepo.purgeExpiredGuestMembers(cutoff);

      expect(distinctSpy).toHaveBeenCalledWith(
        "roomId",
        expect.objectContaining({
          isGuest: true,
          guestExpiresAt: { $exists: true, $ne: null, $lte: cutoff },
        })
      );
    });

    it("23. purgeExpiredGuestMembers aborts deletion if receipt exclusion fails (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      vi.spyOn(RoomMemberModel, "distinct").mockResolvedValue([roomId]);

      vi.spyOn(RoomMemberModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([{ memberId: "expired_g1" }]),
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.find>);

      vi.spyOn(messageRepo, "excludeRecipientFromRoomMessages").mockRejectedValue(
        new Error("Exclusion network failure")
      );

      const deleteManySpy = vi.spyOn(RoomMemberModel, "deleteMany");

      await expect(roomMemberRepo.purgeExpiredGuestMembers()).rejects.toThrow(
        "Exclusion network failure"
      );

      expect(deleteManySpy).not.toHaveBeenCalled();
    });

    it("24. outbox recovery excludes receipts even if member document was already deleted before crash (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:member_ghost:88888`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "507f1f77bcf86cd799439099",
          memberId: "user_ghost",
        },
      };

      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        removedMembers: [
          { opId, memberDocId: "507f1f77bcf86cd799439099", removedAt: new Date() },
        ],
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);
      vi.spyOn(roomRepo, "clearOperationEvidence").mockResolvedValue();

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(1);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(excludeSpy).toHaveBeenCalledWith(roomId, "user_ghost");
    });

    it("25. outbox recovery performs receipt exclusion BEFORE deleting tombstoned member document (Phase 15)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:member_seq:77777`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "507f1f77bcf86cd799439088",
          memberId: "user_seq",
        },
      };

      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);
      vi.spyOn(roomRepo, "clearOperationEvidence").mockResolvedValue();

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd799439088",
          roomId,
          memberId: "user_seq",
          tombstoneOpId: opId,
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const callOrder: string[] = [];

      vi.spyOn(messageRepo, "excludeRecipientFromRoomMessages").mockImplementation(
        async () => {
          callOrder.push("exclude");
          return 1;
        }
      );

      vi.spyOn(RoomMemberModel, "deleteOne").mockImplementation(
        () =>
          ({
            exec: vi.fn().mockImplementation(async () => {
              callOrder.push("delete");
              return { deletedCount: 1 };
            }),
          }) as unknown as ReturnType<typeof RoomMemberModel.deleteOne>
      );

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(callOrder).toEqual(["exclude", "delete"]);
    });

    it("26. reconcilePendingOperations discovers and recovers orphaned departure tombstones from MongoDB on startup (Phase 17)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();

      const orphanDoc = {
        _id: "507f1f77bcf86cd799439099",
        roomId,
        memberId: "orphaned_guest_1",
        tombstoneOpId: `departure:${roomId}:orphaned_guest_1`,
      };

      vi.spyOn(RoomMemberModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([orphanDoc]),
      } as unknown as ReturnType<typeof RoomMemberModel.find>);

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      const removeByMemberIdSpy = vi
        .spyOn(roomMemberRepo, "removeByMemberId")
        .mockResolvedValue(true);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(removeByMemberIdSpy).toHaveBeenCalledWith(
        roomId,
        "orphaned_guest_1",
        `departure:${roomId}:orphaned_guest_1`
      );
    });

    it("27. outbox recovery for remove successfully resolves memberId when memberDocId is not an ObjectId (Phase 17)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:guest_string_id:88888`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "guest_string_id",
          memberId: "guest_string_id",
        },
      };

      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);
      vi.spyOn(roomRepo, "clearOperationEvidence").mockResolvedValue();

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      // Query by memberId (non-ObjectId) succeeds
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd7994390aa",
          roomId,
          memberId: "guest_string_id",
          tombstoneOpId: opId,
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(1);

      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(excludeSpy).toHaveBeenCalledWith(roomId, "guest_string_id");
      expect(deleteDocSpy).toHaveBeenCalledWith({
        roomId,
        _id: "507f1f77bcf86cd7994390aa",
      });
    });

    it("28. crash recovery at Stage 2 (after exclusion before decrement) resumes decrement and deletes doc (Phase 17)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:stage2_user:12345`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "507f1f77bcf86cd7994390bb",
          memberId: "stage2_user",
        },
      };

      // Room document does not yet have opId in removedMembers (decrement did not execute before crash)
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        id: roomId,
        memberCount: 3,
        removedMembers: [],
      } as unknown as IRoom);

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd7994390bb",
          roomId,
          memberId: "stage2_user",
          tombstoneOpId: opId,
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      const roomUpdateSpy = vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(1);

      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      expect(excludeSpy).toHaveBeenCalledWith(roomId, "stage2_user");
      expect(roomUpdateSpy).toHaveBeenCalled();
      expect(deleteDocSpy).toHaveBeenCalledWith({
        roomId,
        _id: "507f1f77bcf86cd7994390bb",
      });
    });

    it("29. crash recovery at Stage 3 (after decrement before deletion) avoids duplicate decrement and deletes doc (Phase 17)", async () => {
      roomMutationBarrier.resetRoom(roomId);
      const outboxService = new OutboxService();
      const opId = `op:remove:${roomId}:stage3_user:54321`;
      const pendingOp = {
        opId,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: {
          memberDocId: "507f1f77bcf86cd7994390cc",
          memberId: "stage3_user",
        },
      };

      // Room document already has opId in removedMembers (decrement DID happen before crash)
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        id: roomId,
        memberCount: 2,
        removedMembers: [{ memberDocId: "507f1f77bcf86cd7994390cc", opId }],
      } as unknown as IRoom);

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      const roomUpdateSpy = vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const excludeSpy = vi
        .spyOn(messageRepo, "excludeRecipientFromRoomMessages")
        .mockResolvedValue(1);

      const deleteDocSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const mockIo = {
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as Parameters<typeof outboxService.reconcilePendingOperations>[0];

      await outboxService.reconcilePendingOperations(mockIo);

      // Must ensure receipts are excluded
      expect(excludeSpy).toHaveBeenCalledWith(roomId, "stage3_user");
      // Must NOT decrement room memberCount a second time
      expect(roomUpdateSpy).not.toHaveBeenCalled();
      // Must delete leftover document
      expect(deleteDocSpy).toHaveBeenCalledWith({
        roomId,
        _id: "507f1f77bcf86cd7994390cc",
      });
    });

    it("30. markReadBatch updates multiple message documents atomically with $addToSet", async () => {
      const msgIds = [
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439012",
        "507f1f77bcf86cd799439013",
      ];
      vi.spyOn(MessageModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(msgIds.map((id) => ({ _id: id }))),
        }),
      } as unknown as ReturnType<typeof MessageModel.find>);

      vi.spyOn(MessageModel, "updateMany").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 3 }),
      } as unknown as ReturnType<typeof MessageModel.updateMany>);

      const res = await testRepo.markReadBatch(roomId, msgIds, "user_bob");

      expect(MessageModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: msgIds }, roomId },
        { $addToSet: { readBy: "user_bob", deliveredTo: "user_bob" } }
      );
      expect(res.updatedIds).toEqual(msgIds);
      expect(res.modifiedCount).toBe(3);
    });

    it("31. markReadBatch enforces sender and departed member exclusions", async () => {
      const msgIds = ["507f1f77bcf86cd799439011"];
      const findSpy = vi.spyOn(MessageModel, "find").mockReturnValue({
        select: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([]),
        }),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const res = await testRepo.markReadBatch(roomId, msgIds, "user_bob");

      expect(findSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: { $in: msgIds },
          roomId,
          authorId: { $ne: "user_bob" },
          excludedRecipientIds: { $ne: "user_bob" },
        })
      );
      expect(res.updatedIds).toEqual([]);
      expect(res.modifiedCount).toBe(0);
    });

    it("32. chat:read_batch succeeds and broadcasts to room", async () => {
      const batchIds = ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"];
      vi.spyOn(messageRepo, "markReadBatch").mockResolvedValue({
        updatedIds: batchIds,
        modifiedCount: 2,
      });

      let ackResult: EventAck<{ messageIds: string[]; readCount: number }> | undefined;
      await handlers["chat:read_batch"]!({ roomId, messageIds: batchIds }, (res) => {
        ackResult = res as EventAck<{ messageIds: string[]; readCount: number }>;
      });

      expect(ackResult?.ok).toBe(true);
      if (ackResult?.ok) {
        expect(ackResult.data.readCount).toBe(2);
        expect(ackResult.data.messageIds).toEqual(batchIds);
      }
    });

    it("33. chat:read_batch rejects empty batch or batch > 50 messages with BAD_REQUEST", async () => {
      // Too many messages (> 50)
      const oversizedBatch = Array.from(
        { length: 51 },
        (_, i) => `507f1f77bcf86cd7994390${String(i).padStart(2, "0")}`
      );

      let ackResult: EventAck | undefined;
      await handlers["chat:read_batch"]!(
        { roomId, messageIds: oversizedBatch },
        (res) => {
          ackResult = res as EventAck;
        }
      );

      expect(ackResult?.ok).toBe(false);
      if (!ackResult?.ok) {
        expect(ackResult?.error.code).toBe(EventErrorCode.VALIDATION_ERROR);
      }
    });

    it("34. chat:read_batch deduplicates message IDs before processing", async () => {
      const markSpy = vi.spyOn(messageRepo, "markReadBatch").mockResolvedValue({
        updatedIds: ["507f1f77bcf86cd799439011"],
        modifiedCount: 1,
      });

      const duplicateBatch = [
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439011",
      ];

      await handlers["chat:read_batch"]!(
        { roomId, messageIds: duplicateBatch },
        () => {}
      );

      expect(markSpy).toHaveBeenCalledWith(
        roomId,
        ["507f1f77bcf86cd799439011"],
        "user_bob"
      );
    });
  });
});
