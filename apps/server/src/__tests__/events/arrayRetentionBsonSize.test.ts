import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateObjectSize } from "bson";
import mongoose from "mongoose";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel, IRoomMember } from "../../models/room_members.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";

describe("T09 Array Retention & BSON Size Benchmark (1,000 Operations)", () => {
  const testRoomId = "507f1f77bcf86cd799439011";
  const testMemberDocId = "507f1f77bcf86cd799439022";
  const testMemberId = "507f1f77bcf86cd799439033";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1,000 sequential role changes with terminal cleanup retain bounded BSON document size (< 256 KiB)", async () => {
    // Model in-memory simulated member document
    const memberDoc = new RoomMemberModel({
      _id: testMemberDocId,
      roomId: testRoomId,
      memberId: testMemberId,
      displayName: "Benchmark Participant",
      role: "viewer",
      roleVersion: 1,
      roleOps: [],
      appliedOpIds: [],
      joinedAt: new Date(),
      lastSeenAt: new Date(),
    });

    vi.spyOn(RoomModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: testRoomId,
        status: "open",
      }),
    } as unknown as ReturnType<typeof RoomModel.findOne>);

    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockImplementation(() => Promise.resolve(memberDoc)),
    } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

    vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockImplementation(
      (_filter, update) => {
        const u = update as {
          $set?: Record<string, unknown>;
          $addToSet?: Record<string, unknown>;
          $push?: Record<string, unknown>;
        };
        if (u.$set) {
          if (u.$set["role"]) memberDoc.role = u.$set["role"] as IRoomMember["role"];
          if (u.$set["roleVersion"])
            memberDoc.roleVersion = u.$set["roleVersion"] as number;
          if (u.$set["lastSeenAt"]) memberDoc.lastSeenAt = u.$set["lastSeenAt"] as Date;
          if (u.$set["lastOpId"]) memberDoc.lastOpId = u.$set["lastOpId"] as string;
        }
        if (u.$addToSet?.["appliedOpIds"]) {
          const id = u.$addToSet["appliedOpIds"] as string;
          if (!memberDoc.appliedOpIds?.includes(id)) {
            memberDoc.appliedOpIds = memberDoc.appliedOpIds || [];
            memberDoc.appliedOpIds.push(id);
          }
        }
        if (u.$push?.["roleOps"]) {
          memberDoc.roleOps = memberDoc.roleOps || [];
          memberDoc.roleOps.push(u.$push["roleOps"] as never);
        }
        return {
          exec: vi.fn().mockResolvedValue(memberDoc),
        } as unknown as ReturnType<typeof RoomMemberModel.findOneAndUpdate>;
      }
    );

    vi.spyOn(RoomMemberModel, "updateOne").mockImplementation(((
      _filter: unknown,
      update: unknown
    ) => {
      const u = update as {
        $pull?: { appliedOpIds?: string; roleOps?: { opId: string } };
      };
      if (u.$pull?.appliedOpIds) {
        memberDoc.appliedOpIds = memberDoc.appliedOpIds?.filter(
          (id) => id !== u.$pull?.appliedOpIds
        );
      }
      if (u.$pull?.roleOps?.opId) {
        memberDoc.roleOps = memberDoc.roleOps?.filter(
          (r) => r.opId !== u.$pull?.roleOps?.opId
        );
      }
      return {
        exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      };
    }) as never);

    const roles: Array<"editor" | "viewer" | "candidate"> = [
      "editor",
      "viewer",
      "candidate",
    ];

    // Execute 1,000 role updates with terminal evidence cleanup
    for (let i = 1; i <= 1000; i++) {
      const opId = `op:role:benchmark:${i}`;
      const targetRole = roles[i % roles.length]!;

      // Phase 1: Apply role update with operation evidence
      const updated = await roomMemberRepo.updateRole(
        testRoomId,
        testMemberDocId,
        targetRole,
        opId
      );
      expect(updated).not.toBeNull();
      expect(updated?.role).toBe(targetRole);

      // Phase 2: Terminal operation resolution cleans up evidence
      // Temporarily mark readyState = 1 to exercise clearOperationEvidence
      (mongoose.connection as unknown as { readyState: number }).readyState = 1;
      await roomMemberRepo.clearOperationEvidence(testRoomId, testMemberDocId, opId);
      (mongoose.connection as unknown as { readyState: number }).readyState = 0;
    }

    // Verify terminal evidence cleanup kept arrays pruned
    expect(memberDoc.appliedOpIds?.length ?? 0).toBe(0);
    expect(memberDoc.roleOps?.length ?? 0).toBe(0);
    expect(memberDoc.roleVersion).toBe(1001);

    // Measure serialized BSON document size
    const rawObject = memberDoc.toObject();
    const bsonSize = calculateObjectSize(rawObject);

    // Assert strictly bounded below 256 KiB (262,144 bytes)
    const MAX_ALLOWED_BSON = 256 * 1024;
    expect(bsonSize).toBeLessThan(MAX_ALLOWED_BSON);

    // Assert in fact compact (< 1 KiB)
    expect(bsonSize).toBeLessThan(1024);
  });

  it("1,000 sequential member removals with terminal cleanup retain bounded BSON document size (< 256 KiB)", async () => {
    // Model in-memory simulated room document
    const roomDoc = new RoomModel({
      _id: testRoomId,
      slug: "benchmark-room-slug",
      title: "Benchmark Room",
      ownerId: "owner_123",
      memberCount: 2,
      removedMembers: [],
      appliedOpIds: [],
      status: "open",
    });

    vi.spyOn(RoomMemberModel, "findOneAndUpdate").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: testMemberDocId,
        roomId: testRoomId,
        tombstoneOpId: "tombstone",
      }),
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
        $set?: Record<string, unknown>;
        $push?: {
          removedMembers?: { memberDocId: string; opId: string; removedAt: Date };
        };
        $pull?: { appliedOpIds?: string; removedMembers?: { opId: string } };
      };

      if (u.$push?.removedMembers) {
        roomDoc.removedMembers = roomDoc.removedMembers || [];
        roomDoc.removedMembers.push(u.$push.removedMembers);
      }
      if (u.$pull?.removedMembers?.opId) {
        roomDoc.removedMembers = roomDoc.removedMembers?.filter(
          (m) => m.opId !== u.$pull?.removedMembers?.opId
        );
      }
      if (u.$pull?.appliedOpIds) {
        roomDoc.appliedOpIds = roomDoc.appliedOpIds?.filter(
          (id) => id !== u.$pull?.appliedOpIds
        );
      }

      return {
        exec: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      };
    }) as never);

    // Execute 1,000 member removals with terminal evidence cleanup
    for (let i = 1; i <= 1000; i++) {
      const opId = `op:removal:benchmark:${i}`;

      const removed = await roomMemberRepo.removeMember(
        testRoomId,
        testMemberDocId,
        opId
      );
      expect(removed).toBe(true);

      // Terminal resolution cleans up evidence
      (mongoose.connection as unknown as { readyState: number }).readyState = 1;
      await roomRepo.clearOperationEvidence(testRoomId, opId);
      (mongoose.connection as unknown as { readyState: number }).readyState = 0;
    }

    // Verify terminal evidence cleanup kept arrays pruned
    expect(roomDoc.removedMembers?.length ?? 0).toBe(0);

    // Measure serialized BSON document size
    const rawObject = roomDoc.toObject();
    const bsonSize = calculateObjectSize(rawObject);

    // Assert strictly bounded below 256 KiB
    const MAX_ALLOWED_BSON = 256 * 1024;
    expect(bsonSize).toBeLessThan(MAX_ALLOWED_BSON);

    // Assert in fact compact (< 1 KiB)
    expect(bsonSize).toBeLessThan(1024);
  });

  it("unresolved operations trigger CAPACITY_EXCEEDED when pending array threshold is reached", async () => {
    // 50 pending role operations without cleanup
    const pendingRoleOps = Array.from({ length: 50 }, (_, i) => ({
      opId: `unresolved:role:${i}`,
      role: "viewer",
      version: i + 1,
      appliedAt: new Date(),
    }));

    const memberDoc = new RoomMemberModel({
      _id: testMemberDocId,
      roomId: testRoomId,
      memberId: testMemberId,
      displayName: "Participant",
      role: "viewer",
      roleVersion: 50,
      roleOps: pendingRoleOps,
      appliedOpIds: pendingRoleOps.map((o) => o.opId),
      joinedAt: new Date(),
      lastSeenAt: new Date(),
    });

    vi.spyOn(RoomModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({ _id: testRoomId, status: "open" }),
    } as unknown as ReturnType<typeof RoomModel.findOne>);

    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue(memberDoc),
    } as unknown as ReturnType<typeof RoomMemberModel.findOne>);

    // Attempting a 51st role change must reject with CAPACITY_EXCEEDED (409)
    await expect(
      roomMemberRepo.updateRole(
        testRoomId,
        testMemberDocId,
        "editor",
        "unresolved:role:51"
      )
    ).rejects.toThrow("Too many pending role operations for member. Please retry.");
  });
});
