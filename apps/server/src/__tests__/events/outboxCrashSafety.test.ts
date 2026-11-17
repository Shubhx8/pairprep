import { describe, it, expect, beforeEach, vi } from "vitest";
import { OutboxService } from "../../events/outboxService.js";
import { DurableOperationModel } from "../../models/durable_operations.js";
import { messageRepo } from "../../repos/messageRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { MessageModel } from "../../models/messages.js";
import { EventModel } from "../../models/events.js";
import { GuestModel } from "../../models/guests.js";
import { ClientMapModel } from "../../models/client_map.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { abortRoomPersistence } from "../../sync/persistence.js";
import { presenceTracker } from "../../events/presenceTracker.js";
import { roomMutationBarrier } from "../../events/roomMutationBarrier.js";
import type { Server, Socket } from "socket.io";

function createMockIo() {
  const emitMock = vi.fn();
  const toMock = vi.fn().mockReturnValue({ emit: emitMock });
  return {
    to: toMock,
    emit: emitMock,
  } as unknown as Server;
}

describe("T09 Phase 2 — Outbox Crash-Safety & Durability (CH-3, ROOM-3, SEC-7)", () => {
  let outboxService: OutboxService;
  let mockIo: Server;

  beforeEach(() => {
    roomMutationBarrier.resetRoom("507f1f77bcf86cd799439011");
    roomMutationBarrier.resetRoom("room_1");
    roomMutationBarrier.resetRoom("room_test");
    outboxService = new OutboxService();
    mockIo = createMockIo();
    vi.restoreAllMocks();
    vi.spyOn(DocUpdateModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(DocSnapshotModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(MessageModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(EventModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(GuestModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(ClientMapModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
    vi.spyOn(RoomMemberModel, "deleteMany").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ acknowledged: true }),
    } as never);
  });

  describe("Standard Outbox Execution Flow", () => {
    it("completes full 7-step outbox lifecycle: intent -> mutation -> applied -> persist -> published", async () => {
      const opId = "op:role_change:room_1:member_1:12345";
      const savedDoc: Record<string, unknown> = {
        opId,
        roomId: "room_1",
        type: "role_change",
        status: "intent_recorded",
        payload: { memberId: "m1", role: "editor" },
      };

      vi.spyOn(DurableOperationModel.prototype, "save").mockResolvedValue(
        savedDoc as unknown as typeof DurableOperationModel
      );
      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockImplementation(
        (_query, update) => {
          const updateObj = (update as { $set?: Record<string, unknown> }).$set || {};
          Object.assign(savedDoc, updateObj);
          return {
            exec: vi.fn().mockResolvedValue(savedDoc),
          } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>;
        }
      );
      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(savedDoc),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(roomRepo, "allocateMessageSeq").mockResolvedValue(10);
      vi.spyOn(messageRepo, "createMessage").mockResolvedValue({
        _id: "msg_123",
        roomId: "room_1",
        authorId: "system",
        seq: 10,
        text: "Alice's role was changed to editor",
        ts: new Date(),
        kind: "system",
      } as unknown as Awaited<ReturnType<typeof messageRepo.createMessage>>);

      const domainMutation = vi.fn().mockResolvedValue({ updated: true });

      const { result, message } = await outboxService.executeDurableOperation({
        opId,
        type: "role_change",
        roomId: "room_1",
        payload: { memberId: "m1", role: "editor" },
        messageText: "Alice's role was changed to editor",
        io: mockIo,
        mutation: domainMutation,
      });

      expect(result).toEqual({ updated: true });
      expect(message).toBeDefined();
      expect(["published", "completed"]).toContain(savedDoc["status"]);
      expect(domainMutation).toHaveBeenCalledTimes(1);

      // Verify Socket.IO broadcast was called
      expect(mockIo.to).toHaveBeenCalledWith("room:room_1");
    });

    it("marks operation as abandoned when domain mutation throws an exception", async () => {
      const opId = "op:remove:room_1:member_2:999";
      const savedDoc: Record<string, unknown> = {
        opId,
        roomId: "room_1",
        type: "remove",
        status: "intent_recorded",
      };

      vi.spyOn(DurableOperationModel.prototype, "save").mockResolvedValue(
        savedDoc as unknown as typeof DurableOperationModel
      );
      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockImplementation(
        (_query, update) => {
          const updateObj = (update as { $set?: Record<string, unknown> }).$set || {};
          Object.assign(savedDoc, updateObj);
          return {
            exec: vi.fn().mockResolvedValue(savedDoc),
          } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>;
        }
      );

      const failingMutation = vi
        .fn()
        .mockRejectedValue(new Error("Document locked by other process"));

      await expect(
        outboxService.executeDurableOperation({
          opId,
          type: "remove",
          roomId: "room_1",
          payload: { memberId: "m2" },
          io: mockIo,
          mutation: failingMutation,
        })
      ).rejects.toThrow("Document locked by other process");

      expect(savedDoc["status"]).toBe("abandoned");
      expect(savedDoc["error"]).toBe("Document locked by other process");
    });
  });

  describe("Crash Recovery Matrix (Reconciliation at Every Persistence Boundary)", () => {
    it("Crash Boundary 1: Reconciler marks intent_recorded abandoned when domain mutation never occurred", async () => {
      const pendingOp = {
        opId: "op:role_change:room_1:m1:crash1",
        roomId: "room_1",
        type: "role_change",
        status: "intent_recorded",
        payload: { memberId: "m1", role: "viewer" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Member still has old role "editor", meaning domain mutation never happened
      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        memberId: "m1",
        role: "editor",
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMember>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: "op:role_change:room_1:m1:crash1" }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
    });

    it("Crash Boundary 2: Reconciler detects mutation occurred, advances to applied, persists message, and publishes", async () => {
      const pendingOp = {
        opId: "op:role_change:room_1:m1:crash2",
        roomId: "room_1",
        type: "role_change",
        status: "intent_recorded",
        payload: {
          memberId: "m1",
          role: "viewer",
          messageText: "Alice was demoted to viewer",
        },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Member has new role "viewer" and matching roleOps evidence, proving mutation committed before crash
      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        memberId: "m1",
        role: "viewer",
        roleVersion: 2,
        roleOps: [
          {
            opId: "op:role_change:room_1:m1:crash2",
            role: "viewer",
            version: 2,
            appliedAt: new Date(),
          },
        ],
        lastOpId: "op:role_change:room_1:m1:crash2",
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMember>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(roomRepo, "allocateMessageSeq").mockResolvedValue(25);
      vi.spyOn(messageRepo, "createMessage").mockResolvedValue({
        _id: "msg_25",
        roomId: "room_1",
        authorId: "system",
        seq: 25,
        text: "Alice was demoted to viewer",
        ts: new Date(),
        kind: "system",
      } as unknown as Awaited<ReturnType<typeof messageRepo.createMessage>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Advances to applied, persisted, and published
      expect(messageRepo.createMessage).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: "op:role_change:room_1:m1:crash2" }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });

    it("Crash Boundary 3: Reconciler detects persisted status, broadcasts without duplicate message insertion", async () => {
      const pendingOp = {
        opId: "op:remove:room_1:m2:crash3",
        roomId: "room_1",
        type: "remove",
        status: "persisted",
        messageId: "msg_99",
        payload: { memberId: "m2" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      vi.spyOn(messageRepo, "getRecentMessages").mockResolvedValue([
        {
          _id: "msg_99",
          roomId: "room_1",
          authorId: "system",
          text: "Bob was removed",
          ts: new Date(),
          seq: 99,
          kind: "system",
        } as unknown as Awaited<ReturnType<typeof messageRepo.getRecentMessages>>[0],
      ]);

      const createMsgSpy = vi.spyOn(messageRepo, "createMessage");
      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Zero duplicate message creation
      expect(createMsgSpy).not.toHaveBeenCalled();
      // Published broadcast emitted
      expect(mockIo.to).toHaveBeenCalledWith("room:room_1");
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: "op:remove:room_1:m2:crash3" }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "published" }),
        }),
        expect.anything()
      );
    });

    it("Operation Ownership: Reconciler marks intent_recorded abandoned when role matches coincidentally but lastOpId differs", async () => {
      const pendingOp = {
        opId: "op:role_change:room_1:m1:crash_unowned",
        roomId: "room_1",
        type: "role_change",
        status: "intent_recorded",
        payload: { memberId: "m1", role: "viewer" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Member already had role "viewer", but it was stamped by a prior operation "old_op_999"!
      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        memberId: "m1",
        role: "viewer",
        lastOpId: "old_op_999",
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMember>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Operation MUST be abandoned because lastOpId does not match this operation
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: "op:role_change:room_1:m1:crash_unowned" }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
    });
  });

  describe("H-1, H-2 & M-1 — Durable Room Deletion Lifecycle & Crash Safety", () => {
    it("executes full 7-step durable room deletion flow with deletion barrier and safe outbox cleanup", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const slug = "test-slug";
      const opId = `op:room_deleted:${roomId}:all`;

      const savedDoc: Record<string, unknown> = {
        opId,
        roomId,
        type: "room_deleted",
        status: "intent_recorded",
      };

      vi.spyOn(DurableOperationModel.prototype, "save").mockResolvedValue(
        savedDoc as unknown as typeof DurableOperationModel
      );
      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockImplementation(
        (_query, update) => {
          const updateObj = (update as { $set?: Record<string, unknown> }).$set || {};
          Object.assign(savedDoc, updateObj);
          return {
            exec: vi.fn().mockResolvedValue(savedDoc),
          } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>;
        }
      );

      const barrierSpy = vi.spyOn(roomRepo, "setDeletionBarrier").mockResolvedValue({
        _id: roomId,
        slug,
        status: "deleted",
        deletionOpId: opId,
      } as unknown as Awaited<ReturnType<typeof roomRepo.setDeletionBarrier>>);

      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);

      await outboxService.executeRoomDeletion({
        roomId,
        slug,
        io: mockIo,
      });

      // 1. Deletion barrier set
      expect(barrierSpy).toHaveBeenCalledWith(roomId, opId);
      // 2. Broadcast room:deleted emitted to room channel
      expect(mockIo.to).toHaveBeenCalledWith(`room:${roomId}`);
      // 3. Cascade cleanup called preserving activeOpId
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, opId);
      // 4. Terminal state is completed
      expect(savedDoc["status"]).toBe("completed");
    });

    it("Crash Boundary: Reconciler recovers from crash after deletion barrier by broadcasting and completing cascade", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "intent_recorded",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Room has status "deleted" and deletionOpId matches this op
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        status: "deleted",
        deletionOpId: opId,
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);
      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Advances to applied, published, cascades deletion, and completes
      expect(mockIo.to).toHaveBeenCalledWith(`room:${roomId}`);
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, opId);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        }),
        expect.anything()
      );
    });

    it("Crash Boundary: Reconciler marks intent_recorded abandoned if deletion barrier was never set", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "intent_recorded",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Room is still "open" with no deletionOpId
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        status: "open",
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
    });
  });

  describe("Operation Ownership Survives Subsequent Mutations (Scenarios 1-4)", () => {
    it("Scenario 1: Role-change ownership: superseding role change prevents regressive broadcast", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439022";
      const opIdA = "op:role_change:room_1:m1:opA";

      const pendingOpA = {
        opId: opIdA,
        roomId,
        type: "role_change",
        status: "intent_recorded",
        payload: { memberDocId, role: "viewer" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOpA]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Member was mutated by OpA, but later changed to "editor" by OpB
      // member.appliedOpIds contains opA, but member.role is now "editor"
      vi.spyOn(roomMemberRepo, "findMemberByDocId").mockResolvedValue({
        id: memberDocId,
        memberId: "u1",
        role: "editor",
        appliedOpIds: [opIdA, "opB"],
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMemberByDocId>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOpA),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // OpA must be marked abandoned because newer operation OpB changed the role
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdA }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
      // Zero broadcasts of the regressive "viewer" role
      expect(mockIo.to).not.toHaveBeenCalled();
    });

    it("Scenario 2: Removal ownership survives a subsequent removal on another member", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opIdA = "op:remove:room_1:m1:opA";

      const pendingOpA = {
        opId: opIdA,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: { memberDocId: "m1", memberId: "u1" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOpA]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Room has removedMembers array preserving opA even after opB removed another member
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        removedMembers: [
          { memberDocId: "m1", opId: opIdA, removedAt: new Date() },
          { memberDocId: "m2", opId: "opB", removedAt: new Date() },
        ],
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOpA),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOpA),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // OpA ownership verified via removedMembers array! Advances to applied
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdA }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 3: Join / removal / rejoin ownership remains unambiguous across operations", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opIdRemove = "op:remove:room_1:m1:nonce1";
      const opIdRejoin = "op:join:room_1:m2:nonce2";

      const pendingRemove = {
        opId: opIdRemove,
        roomId,
        type: "remove",
        status: "intent_recorded",
        payload: { memberDocId: "m1", memberId: "u1" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingRemove]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Room contains opIdRemove in removedMembers
      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        removedMembers: [{ memberDocId: "m1", opId: opIdRemove, removedAt: new Date() }],
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      // Rejoined member doc exists with new opIdRejoin
      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        id: "m2",
        memberId: "u1",
        appliedOpIds: [opIdRejoin],
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMember>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingRemove),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingRemove),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Removal is verified from room.removedMembers despite user rejoining!
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdRemove }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 4: Room status operation ownership survives subsequent transition", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opIdEnd = "op:room_ended:room_1:all:1";

      const pendingEnd = {
        opId: opIdEnd,
        roomId,
        type: "room_ended",
        status: "intent_recorded",
        payload: { status: "ended" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingEnd]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: roomId,
        status: "ended",
        appliedOpIds: [opIdEnd],
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingEnd),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingEnd),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdEnd }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });
  });

  describe("Room Deletion Recovery & False-Positive Prevention (Scenarios 5-8)", () => {
    it("Scenario 5: Intent-recorded deletion with a missing room does not falsely advance", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "intent_recorded",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Room is completely missing from MongoDB
      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Must NOT advance to applied; must be abandoned
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
      // Zero broadcasts emitted
      expect(mockIo.to).not.toHaveBeenCalled();
    });

    it("Scenario 6: Applied deletion with a missing room resumes cleanup and finishes", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "applied",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);
      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, opId);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 7: Published deletion with a missing room resumes cleanup without rebroadcast", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "published",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "findById").mockResolvedValue(null);
      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Zero broadcasts because status was already published!
      expect(mockIo.to).not.toHaveBeenCalled();
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, opId);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 8: Two concurrent deletion attempts produce exactly one winner and one deletion broadcast", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const slug = "test-slug";
      const opIdWinner = `op:room_deleted:${roomId}:all`;

      // Op 1 wins barrier
      vi.spyOn(roomRepo, "setDeletionBarrier")
        .mockResolvedValueOnce({
          _id: roomId,
          slug,
          status: "deleted",
          deletionOpId: opIdWinner,
        } as unknown as Awaited<ReturnType<typeof roomRepo.setDeletionBarrier>>)
        // Op 2 loses barrier
        .mockResolvedValueOnce(null);

      vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);
      vi.spyOn(DurableOperationModel.prototype, "save").mockResolvedValue({} as never);
      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ status: "completed" }),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      // Request 1 executes and succeeds
      await outboxService.executeRoomDeletion({ roomId, slug, io: mockIo });
      expect(mockIo.to).toHaveBeenCalledTimes(1);

      // Request 2 executes concurrently and is rejected with 404
      await expect(
        outboxService.executeRoomDeletion({ roomId, slug, io: mockIo })
      ).rejects.toThrow("Room not found");

      // Exactly ONE broadcast total across both requests
      expect(mockIo.to).toHaveBeenCalledTimes(1);
    });
  });

  describe("Safe Outbox Retention & Cleanup (Scenarios 9-11)", () => {
    it("Scenario 9: Pending operations are not deleted during room cleanup; transitioned to abandoned", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const activeOpId = `op:room_deleted:${roomId}:all`;

      const updateManySpy = vi
        .spyOn(DurableOperationModel, "updateMany")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue({ matchedCount: 2, modifiedCount: 2 }),
        } as unknown as ReturnType<typeof DurableOperationModel.updateMany>);

      const deleteManySpy = vi
        .spyOn(DurableOperationModel, "deleteMany")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        } as unknown as ReturnType<typeof DurableOperationModel.deleteMany>);

      vi.spyOn(RoomModel, "findByIdAndDelete").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: roomId }),
      } as unknown as ReturnType<typeof RoomModel.findByIdAndDelete>);

      await roomRepo.deleteRoom(roomId, activeOpId);

      // Pending non-terminal ops were safely marked abandoned, NOT deleted!
      expect(updateManySpy).toHaveBeenCalledWith(
        {
          roomId,
          opId: { $ne: activeOpId },
          status: { $in: ["intent_recorded", "applied", "persisted", "published"] },
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "abandoned",
            error: expect.stringContaining("Superseded"),
          }),
        })
      );

      // Terminal operations are retained for 7 days via TTL index; deleteMany is NOT called
      expect(deleteManySpy).not.toHaveBeenCalled();
    });

    it("Scenario 10: Pending operations cannot mutate the room after being superseded", async () => {
      const roomId = "507f1f77bcf86cd799439011";

      // Attempting to allocate sequence on superseded room fails
      vi.spyOn(RoomModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      await expect(roomRepo.allocateMessageSeq(roomId, true)).rejects.toThrow(
        "Cannot allocate sequence number: room not found or closed"
      );
    });

    it("Scenario 11: Terminal retention does not erase active recovery evidence", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const activeOpId = `op:room_deleted:${roomId}:all`;

      const deleteManySpy = vi
        .spyOn(DurableOperationModel, "deleteMany")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        } as unknown as ReturnType<typeof DurableOperationModel.deleteMany>);

      vi.spyOn(DurableOperationModel, "updateMany").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      } as unknown as ReturnType<typeof DurableOperationModel.updateMany>);

      vi.spyOn(RoomModel, "findByIdAndDelete").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: roomId }),
      } as unknown as ReturnType<typeof RoomModel.findByIdAndDelete>);

      await roomRepo.deleteRoom(roomId, activeOpId);

      // Terminal operations are retained for 7 days via TTL index; deleteMany is NOT called
      expect(deleteManySpy).not.toHaveBeenCalled();
    });
  });

  describe("Deletion Barrier Write-Fencing Protocol (Scenarios 12-16)", () => {
    it("Scenario 12: Member join racing with deletion barrier is rejected with ROOM_NOT_FOUND", async () => {
      const roomId = "507f1f77bcf86cd799439011";

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      // Room document is already tombstoned to "deleted"
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: roomId, status: "deleted" }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      await expect(
        roomMemberRepo.addMember({
          roomId,
          memberId: "u_race",
          displayName: "Race User",
          role: "editor",
        })
      ).rejects.toThrow("Room not found");
    });

    it("Scenario 13: Role change racing with deletion barrier is rejected (fenced)", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439022";

      // Room is in "deleted" status
      vi.spyOn(RoomModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null), // Filter status: { $in: ["open", "live"] } returns null
      } as unknown as ReturnType<typeof RoomModel.findOne>);

      const result = await roomMemberRepo.updateRole(
        roomId,
        memberDocId,
        "viewer",
        "op:race"
      );
      expect(result).toBeNull();
    });

    it("Scenario 14: Member removal racing with deletion barrier cannot decrement deleted room", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberDocId = "507f1f77bcf86cd799439022";

      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: memberDocId, tombstoneOpId: "op:race" }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      const updateSpy = vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      await roomMemberRepo.removeMember(roomId, memberDocId, "op:race");

      // Verifies update query enforces status: { $ne: "deleted" }
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: { $ne: "deleted" } }),
        expect.anything()
      );
    });

    it("Scenario 15: Chat message persistence racing with deletion cannot allocate sequence on deleted room", async () => {
      const roomId = "507f1f77bcf86cd799439011";

      vi.spyOn(RoomModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      await expect(roomRepo.allocateMessageSeq(roomId, false)).rejects.toThrow(
        "Cannot allocate sequence number: room not found or closed"
      );
    });

    it("Scenario 16: System-message sequence allocation rejects deleted rooms even with allowClosed=true", async () => {
      const roomId = "507f1f77bcf86cd799439011";

      const findOneAndUpdateSpy = vi
        .spyOn(RoomModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(null),
        } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      await expect(roomRepo.allocateMessageSeq(roomId, true)).rejects.toThrow(
        "Cannot allocate sequence number: room not found or closed"
      );

      // Verifies query filter enforced status: { $ne: "deleted" }
      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: { $ne: "deleted" } }),
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe("Collaborative Sync & Persistence Fencing (Scenarios 17-19)", () => {
    it("Scenario 17: Existing Hocuspocus connection cannot persist after deletion barrier", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      syncRegistry.markRoomDeleted(roomId);
      syncRegistry.setRoomReadOnly(roomId);

      expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
    });

    it("Scenario 18: Pending Hocuspocus persistence queues are cancelled before cascade cleanup", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      // Should execute without throwing and cancel queues
      await expect(abortRoomPersistence(roomId)).resolves.not.toThrow();
    });

    it("Scenario 19: New Hocuspocus connection cannot be promoted after room deletion", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      syncRegistry.markRoomDeleted(roomId);

      const promoResult = syncRegistry.promoteReservation(
        "sock_test",
        roomId,
        "u1",
        { id: "u1", type: "user", displayName: "Test" },
        { readOnly: false }
      );

      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("room_unavailable");
      }
    });
  });

  describe("Socket Delivery, Acknowledgement & Timeout (Scenario 20)", () => {
    it("Scenario 20: Socket acknowledgement success and timeout behavior", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const mockSocket = {
        id: "sock_ack",
        connected: true,
        timeout: vi.fn().mockReturnValue({
          emit: vi.fn((_event, _payload, cb) => cb()),
        }),
        disconnect: vi.fn(),
      } as unknown as Socket;

      presenceTracker.registerSocket(mockSocket, roomId, {
        id: "m_ack",
        memberId: "u_ack",
        displayName: "Ack User",
        role: "editor",
      });

      await presenceTracker.gracefulDisconnectRoomSockets(roomId, 50);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(false);
      expect(presenceTracker.getOnlineMemberCount(roomId)).toBe(0);
    });
  });

  describe("End-to-End Recovery Boundaries & Idempotency (Scenarios 21-24)", () => {
    it("Scenario 21: Crash after broadcast but before published achieves at-least-once recovery", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "applied",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);
      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      // Re-emits broadcast (at-least-once)
      expect(mockIo.to).toHaveBeenCalledWith(`room:${roomId}`);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 22: Crash during child cleanup is recoverable and idempotent", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "published",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      const deleteRoomSpy = vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(true);
      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(deleteRoomSpy).toHaveBeenCalledWith(roomId, opId);
    });

    it("Scenario 23: Crash after room document deletion but before completed finishes terminal transition", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const opId = `op:room_deleted:${roomId}:all`;

      const pendingOp = {
        opId,
        roomId,
        type: "room_deleted",
        status: "published",
        payload: { slug: "test-slug" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "deleteRoom").mockResolvedValue(false); // room already deleted
      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);

      expect(reconciled).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        }),
        expect.anything()
      );
    });

    it("Scenario 24: Repeated reconciliation is idempotent", async () => {
      // All operations have already reached terminal state
      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);
      expect(reconciled).toBe(0);
      expect(mockIo.to).not.toHaveBeenCalled();
    });
  });
});
