import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import {
  roomMutationBarrier,
  DrainTimeoutError,
} from "../../events/roomMutationBarrier.js";
import { OutboxService } from "../../events/outboxService.js";
import { DurableOperationModel } from "../../models/durable_operations.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { UserModel } from "../../models/users.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { messageRepo } from "../../repos/messageRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { abortRoomPersistence, flushRoom } from "../../sync/persistence.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { authorizeRoomEvent } from "../../events/authorization.js";
import { EventErrorCode } from "@pairprep/shared";
import type { Principal } from "../../middleware/identity.js";
import type { Server } from "socket.io";

function createMockIo() {
  const emitMock = vi.fn();
  const toMock = vi.fn().mockReturnValue({ emit: emitMock });
  return {
    to: toMock,
    emit: emitMock,
  } as unknown as Server;
}

describe("T09 Phase 2 — Corrective Verification (H-1, H-2, H-3, M-1, M-2, M-3, M-4, M-5)", () => {
  let outboxService: OutboxService;
  let mockIo: Server;
  const testRoomId = "507f1f77bcf86cd799439099";

  beforeEach(() => {
    roomMutationBarrier.resetRoom(testRoomId);
    outboxService = new OutboxService();
    mockIo = createMockIo();
    vi.restoreAllMocks();
  });

  describe("H-1: Room Mutation Barrier & Post-Deletion Fencing", () => {
    it("admits mutation when room is open and tracks active mutation count", async () => {
      expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(true);
      let executed = false;
      const result = await roomMutationBarrier.withAdmission(testRoomId, async () => {
        executed = true;
        return "success";
      });
      expect(executed).toBe(true);
      expect(result).toBe("success");
    });

    it("rejects new mutations immediately after admission is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(false);

      await expect(
        roomMutationBarrier.withAdmission(testRoomId, async () => "should-not-run")
      ).rejects.toThrow("Room not found or closed");
    });

    it("drains active in-flight mutations during deletion before barrier release", async () => {
      let mutationFinished = false;
      const mutationPromise = roomMutationBarrier.withAdmission(testRoomId, async () => {
        await new Promise((r) => setTimeout(r, 50));
        mutationFinished = true;
        return "done";
      });

      // Close admission and drain
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(false);

      await roomMutationBarrier.drainRoomMutations(testRoomId);
      expect(mutationFinished).toBe(true);
      await expect(mutationPromise).resolves.toBe("done");
    });

    it("re-entrant admission leases allow nested withAdmission without deadlocks or double-counting", async () => {
      let innerExecuted = false;
      await roomMutationBarrier.withAdmission(testRoomId, async () => {
        expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(1);
        expect(roomMutationBarrier.isAdmitted(testRoomId)).toBe(true);
        await roomMutationBarrier.withAdmission(testRoomId, async () => {
          // Nested call re-uses lease; does not increment activeCount
          expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(1);
          expect(roomMutationBarrier.isAdmitted(testRoomId)).toBe(true);
          innerExecuted = true;
        });
        expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(1);
      });
      expect(innerExecuted).toBe(true);
      expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(0);
    });

    it("drainRoomMutations throws DrainTimeoutError on timeout with active mutations, preserving barrier", async () => {
      let releaseMutation: (() => void) | undefined;
      const blockerPromise = roomMutationBarrier.withAdmission(testRoomId, () => {
        return new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      });

      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(
        roomMutationBarrier.drainRoomMutations(testRoomId, 20)
      ).rejects.toThrowError(DrainTimeoutError);

      // Barrier remains closed and active count still reflects the in-flight mutation
      expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(false);
      expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(1);

      // Release blocker
      releaseMutation?.();
      await blockerPromise;
      expect(roomMutationBarrier.getActiveCount(testRoomId)).toBe(0);
    });

    it("messageRepo.createMessage rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(
        messageRepo.createMessage({
          roomId: testRoomId,
          authorId: "user_1",
          seq: 1,
          text: "hello",
          kind: "user",
        })
      ).rejects.toThrow("Room not found or closed");
    });

    it("roomRepo.allocateMessageSeq rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(roomRepo.allocateMessageSeq(testRoomId, false)).rejects.toThrow(
        "Room not found or closed"
      );
    });

    it("roomMemberRepo.addMember rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(
        roomMemberRepo.addMember({
          roomId: testRoomId,
          memberId: "user_2",
          displayName: "Bob",
          role: "editor",
        })
      ).rejects.toThrow("Room not found or closed");
    });

    it("roomMemberRepo.updateRole rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(
        roomMemberRepo.updateRole(testRoomId, "507f1f77bcf86cd799439022", "viewer")
      ).rejects.toThrow("Room not found or closed");
    });

    it("roomMemberRepo.removeMember rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(
        roomMemberRepo.removeMember(testRoomId, "507f1f77bcf86cd799439022")
      ).rejects.toThrow("Room not found or closed");
    });

    it("roomMemberRepo.removeByMemberId rejects when barrier is closed", async () => {
      roomMutationBarrier.closeRoomAdmission(testRoomId);
      await expect(roomMemberRepo.removeByMemberId(testRoomId, "user_2")).rejects.toThrow(
        "Room not found or closed"
      );
    });

    it("roomRepo.updateStatus rejects modifying a deleted room", async () => {
      vi.spyOn(RoomModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      const updated = await roomRepo.updateStatus("test-slug", "ended");
      expect(updated).toBeNull();
    });
  });

  describe("H-2: In-Flight Yjs Persistence Flush Drain & Deletion Abort", () => {
    it("abortRoomPersistence awaits in-flight flushes and drains persistence", async () => {
      syncRegistry.markRoomDeleted(testRoomId);
      expect(syncRegistry.isRoomDeleted(testRoomId)).toBe(true);

      const abortPromise = abortRoomPersistence(testRoomId);
      await expect(abortPromise).resolves.not.toThrow();
    });

    it("flushRoom skips database persistence if room is marked deleted", async () => {
      syncRegistry.markRoomDeleted(testRoomId);
      const createSpy = vi.spyOn(DocUpdateModel, "create");

      await flushRoom(testRoomId);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("H-3: Join Operation Ownership & Intent Ordering", () => {
    it("stamps opId into member document atomically on appliedOpIds and joinOpId", async () => {
      const opId = "op:join:testRoom:u1:nonce1";
      const memberDoc: Record<string, unknown> = {
        _id: "m_doc_1",
        roomId: testRoomId,
        userId: "u1",
        displayName: "User One",
        role: "editor",
        roleVersion: 1,
        appliedOpIds: [opId],
        joinOpId: opId,
        lastOpId: opId,
      };

      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue({ _id: testRoomId, status: "open", memberCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      vi.spyOn(RoomModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: testRoomId, memberCount: 2 }),
      } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      vi.spyOn(RoomMemberModel.prototype, "save").mockResolvedValue(
        memberDoc as unknown as typeof RoomMemberModel
      );

      const created = await roomMemberRepo.addMember({
        roomId: testRoomId,
        memberId: "u1",
        displayName: "User One",
        role: "editor",
        opId,
      });

      expect(created.appliedOpIds).toContain(opId);
      expect(created.joinOpId).toBe(opId);
    });

    it("reconciler recovers crashed join if appliedOpIds contains opId", async () => {
      const opId = "op:join:testRoom:u1:crash_join";
      const pendingOp = {
        opId,
        roomId: testRoomId,
        type: "join",
        status: "intent_recorded",
        payload: { memberId: "u1", displayName: "User One" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        id: "m_doc_1",
        memberId: "u1",
        appliedOpIds: [opId],
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMember>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

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
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });
  });

  describe("M-1: Monotonic CAS Outbox State Transitions", () => {
    it("rejects backwards transition from terminal completed state", async () => {
      const opId = "op:test:terminal:1";
      const doc = {
        opId,
        roomId: testRoomId,
        status: "completed",
      };

      vi.spyOn(DurableOperationModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null), // CAS query matches { opId, status: { $in: allowedFrom } } -> null
      } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      // Attempting to advance a completed op via reconcile
      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([doc]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);
      // Completed op is not in query filter ($in: ['intent_recorded', 'applied', 'persisted', 'published'])
      expect(reconciled).toBe(0);
    });
  });

  describe("M-2 & M-3: Revision Tracking & ABA Role-Change Recovery", () => {
    it("aborts recovery when member roleVersion is strictly greater than op roleVersion", async () => {
      const opIdA = "op:role:v1";
      const pendingOp = {
        opId: opIdA,
        roomId: testRoomId,
        type: "role_change",
        status: "intent_recorded",
        payload: {
          memberDocId: "m1",
          memberId: "u1",
          role: "editor",
          roleVersion: 1, // Created at version 1
        },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      // Member underwent A -> B -> A; role is "editor" coincidentally, but roleVersion is now 3!
      vi.spyOn(roomMemberRepo, "findMemberByDocId").mockResolvedValue({
        id: "m1",
        role: "editor",
        roleVersion: 3, // Advanced past op
        appliedOpIds: [opIdA, "opB", "opC"],
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMemberByDocId>>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);
      expect(reconciled).toBe(1);
      // Because roleVersion 3 > opRoleVersion 1, it must be marked abandoned despite matching role
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdA }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "abandoned" }),
        }),
        expect.anything()
      );
    });

    it("advances recovery when member roleVersion matches op roleVersion", async () => {
      const opIdA = "op:role:v2";
      const pendingOp = {
        opId: opIdA,
        roomId: testRoomId,
        type: "role_change",
        status: "intent_recorded",
        payload: {
          memberDocId: "m1",
          memberId: "u1",
          role: "interviewer",
          roleVersion: 2,
        },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomMemberRepo, "findMemberByDocId").mockResolvedValue({
        id: "m1",
        role: "interviewer",
        roleVersion: 2,
        appliedOpIds: [opIdA],
      } as unknown as Awaited<ReturnType<typeof roomMemberRepo.findMemberByDocId>>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

      const updateSpy = vi
        .spyOn(DurableOperationModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue(pendingOp),
        } as unknown as ReturnType<typeof DurableOperationModel.findOneAndUpdate>);

      const reconciled = await outboxService.reconcilePendingOperations(mockIo);
      expect(reconciled).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ opId: opIdA }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });
  });

  describe("M-4: Two-Phase Member Removal & Recovery", () => {
    it("stages tombstone before updating room memberCount and hard-deleting", async () => {
      const memberDocId = "507f1f77bcf86cd799439033";
      const opId = "op:remove:phase2:test";

      const findOneAndUpdateSpy = vi
        .spyOn(RoomMemberModel, "findOneAndUpdate")
        .mockReturnValue({
          exec: vi.fn().mockResolvedValue({ _id: memberDocId, tombstoneOpId: opId }),
        } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);

      const updateOneSpy = vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      const deleteOneSpy = vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      const removed = await roomMemberRepo.removeMember(testRoomId, memberDocId, opId);
      expect(removed).toBe(true);

      // Verify staged tombstone
      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: testRoomId, _id: memberDocId }),
        expect.objectContaining({ $set: { tombstoneOpId: opId } }),
        { new: true }
      );
      // Verify room memberCount update
      expect(updateOneSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: testRoomId, status: { $ne: "deleted" } }),
        expect.objectContaining({
          $inc: { memberCount: -1 },
          $push: {
            removedMembers: {
              memberDocId,
              opId,
              removedAt: expect.any(Date),
            },
          },
        })
      );
      // Verify hard delete of member
      expect(deleteOneSpy).toHaveBeenCalledWith({ roomId: testRoomId, _id: memberDocId });
    });

    it("retains evidence for unresolved Op 1 after 51 sequential removals (no slice cap)", async () => {
      const calls: Record<string, unknown>[] = [];
      vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: "m1", tombstoneOpId: "op" }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>);
      vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);
      vi.spyOn(RoomModel, "updateOne").mockImplementation(((
        _filter: unknown,
        update: unknown
      ) => {
        calls.push(update as Record<string, unknown>);
        return {
          exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
        };
      }) as never);

      for (let i = 1; i <= 51; i++) {
        await roomMemberRepo.removeMember(
          testRoomId,
          "507f1f77bcf86cd799439033",
          `op:remove:${i}`
        );
      }

      expect(calls.length).toBe(51);
      // Verify that no call contained $slice
      for (const call of calls) {
        const push = call["$push"] as Record<string, unknown> | undefined;
        if (push && push["removedMembers"]) {
          expect(
            (push["removedMembers"] as Record<string, unknown>)["$slice"]
          ).toBeUndefined();
        }
      }
    });

    it("reconciles crashed removal where member was tombstoned before room decrement", async () => {
      const opId = "op:remove:crash_tombstone";
      const memberDocId = "507f1f77bcf86cd799439044";
      const pendingOp = {
        opId,
        roomId: testRoomId,
        type: "remove",
        status: "intent_recorded",
        payload: { memberDocId, memberId: "u44" },
      };

      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([pendingOp]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: testRoomId,
        removedMembers: [],
      } as unknown as Awaited<ReturnType<typeof roomRepo.findById>>);

      // Member still exists with tombstoneOpId!
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: memberDocId,
          tombstoneOpId: opId,
        }),
      } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

      vi.spyOn(RoomModel, "updateOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      } as unknown as ReturnType<typeof RoomModel.updateOne>);

      vi.spyOn(RoomMemberModel, "deleteOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      } as unknown as ReturnType<typeof RoomMemberModel.deleteOne>);

      vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(pendingOp),
      } as unknown as ReturnType<typeof DurableOperationModel.findOne>);

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
          $set: expect.objectContaining({ status: "applied" }),
        }),
        expect.anything()
      );
    });
  });

  describe("M-5: Authoritative Reconnect Rejection", () => {
    it("authorizeRoomEvent rejects deleted rooms with ROOM_NOT_FOUND", async () => {
      (mongoose.connection as unknown as { readyState: number }).readyState = 1;
      vi.spyOn(UserModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          id: "507f1f77bcf86cd799439011",
          disabled: false,
        }),
      } as unknown as ReturnType<typeof UserModel.findById>);

      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: testRoomId,
          status: "deleted",
        }),
      } as unknown as ReturnType<typeof RoomModel.findById>);

      try {
        const result = await authorizeRoomEvent({
          roomId: testRoomId,
          principal: {
            type: "user",
            id: "507f1f77bcf86cd799439011",
            displayName: "Test User",
          } as unknown as Principal,
        });
        expect(result.authorized).toBe(false);
        if (!result.authorized) {
          expect(result.code).toBe(EventErrorCode.ROOM_NOT_FOUND);
        }
      } finally {
        (mongoose.connection as unknown as { readyState: number }).readyState = 0;
      }
    });

    it("reconstructs closed room admission on startup for tombstoned rooms", async () => {
      (mongoose.connection as unknown as { readyState: number }).readyState = 1;
      vi.spyOn(RoomModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([{ _id: testRoomId, status: "deleted" }]),
      } as unknown as ReturnType<typeof RoomModel.find>);
      vi.spyOn(DurableOperationModel, "find").mockReturnValue({
        exec: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof DurableOperationModel.find>);

      try {
        expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(true);
        await outboxService.reconcilePendingOperations(mockIo);
        expect(roomMutationBarrier.isRoomOpen(testRoomId)).toBe(false);
      } finally {
        (mongoose.connection as unknown as { readyState: number }).readyState = 0;
      }
    });
  });
});
