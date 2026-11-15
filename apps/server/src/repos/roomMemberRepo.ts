import mongoose from "mongoose";
import { RoomMemberModel, IRoomMember, IRoleOpEvidence } from "../models/room_members.js";
import { RoomModel, IRoom } from "../models/rooms.js";
import { AppError } from "../errors/AppError.js";
import { roomMutationBarrier } from "../events/roomMutationBarrier.js";

export class RoomFullError extends AppError {
  constructor(message = "Room has reached its maximum limit of 6 participants") {
    super(message, 409, "ROOM_FULL");
    this.name = "RoomFullError";
  }
}

export class RoomMemberRepo {
  /**
   * PRD ROOM-4: Enforce max 6 participants atomically with fenced self-healing (>60s).
   * - If member already exists in room, updates lastSeenAt and returns existing member.
   * - If new member and room capacity available, atomically increments memberCount and creates member.
   * - If room full, checks for stale counter drift (>60s) and attempts fenced self-healing before failing.
   */
  public async addMember(data: {
    roomId: string;
    memberId: string;
    displayName: string;
    role: "owner" | "interviewer" | "candidate" | "editor" | "viewer";
    isGuest?: boolean;
    guestExpiresAt?: Date;
    opId?: string;
  }): Promise<IRoomMember> {
    return roomMutationBarrier.withAdmission(data.roomId, async () => {
      // 1. Check if user/guest is already an existing member
      const existing = await RoomMemberModel.findOne({
        roomId: data.roomId,
        memberId: data.memberId,
      }).exec();

      if (existing) {
        existing.lastSeenAt = new Date();
        if (data.displayName && existing.displayName !== data.displayName) {
          existing.displayName = data.displayName;
        }
        if (data.opId) {
          existing.lastOpId = data.opId;
          existing.joinOpId = data.opId;
          if (!existing.appliedOpIds) existing.appliedOpIds = [];
          if (!existing.appliedOpIds.includes(data.opId)) {
            existing.appliedOpIds.push(data.opId);
          }
        }
        return existing.save();
      }

      // Owner member slot is pre-allocated on createRoom (memberCount: 1)
      if (data.role === "owner") {
        const ownerMember = new RoomMemberModel({
          roomId: data.roomId,
          memberId: data.memberId,
          displayName: data.displayName,
          role: "owner",
          isGuest: false,
          lastOpId: data.opId,
          joinOpId: data.opId,
          appliedOpIds: data.opId ? [data.opId] : [],
          roleVersion: 1,
          joinedAt: new Date(),
          lastSeenAt: new Date(),
        });
        return await ownerMember.save();
      }

      // 2. Fetch room to check existence and status
      const room = await RoomModel.findById(data.roomId).exec();
      if (!room || room.status === "deleted") {
        throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
      }
      if (room.status === "ended" || room.status === "archived") {
        throw new AppError(
          "This room is ended or archived and cannot be modified",
          409,
          "ROOM_CLOSED"
        );
      }

      // 3. Conditional atomic increment
      const now = new Date();
      let updatedRoom = await RoomModel.findOneAndUpdate(
        {
          _id: data.roomId,
          memberCount: { $lt: 6 },
          status: { $in: ["open", "live"] },
        },
        { $inc: { memberCount: 1 }, $set: { memberCountUpdatedAt: now } },
        { new: true }
      ).exec();

      // 4. Fenced self-healing (> 60s)
      if (!updatedRoom) {
        const currentRoom = await RoomModel.findById(data.roomId).exec();
        if (!currentRoom || currentRoom.status === "deleted") {
          throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
        }
        if (currentRoom.status === "ended" || currentRoom.status === "archived") {
          throw new AppError(
            "This room is ended or archived and cannot be modified",
            409,
            "ROOM_CLOSED"
          );
        }

        const updatedAt = currentRoom.memberCountUpdatedAt
          ? currentRoom.memberCountUpdatedAt.getTime()
          : 0;

        // Heal only when memberCountUpdatedAt is >60s old
        if (Date.now() - updatedAt > 60000) {
          const actualCount = await RoomMemberModel.countDocuments({
            roomId: data.roomId,
          }).exec();

          if (actualCount < 6) {
            const healed = await RoomModel.findOneAndUpdate(
              {
                _id: data.roomId,
                memberCount: currentRoom.memberCount,
                memberCountUpdatedAt: currentRoom.memberCountUpdatedAt,
              },
              {
                $set: { memberCount: actualCount, memberCountUpdatedAt: new Date() },
              },
              { new: true }
            ).exec();

            if (healed && healed.memberCount < 6) {
              updatedRoom = await RoomModel.findOneAndUpdate(
                {
                  _id: data.roomId,
                  memberCount: { $lt: 6 },
                  status: { $in: ["open", "live"] },
                },
                { $inc: { memberCount: 1 }, $set: { memberCountUpdatedAt: new Date() } },
                { new: true }
              ).exec();
            }
          }
        }

        if (!updatedRoom) {
          throw new RoomFullError();
        }
      }

      // 5. Insert member into room_members
      try {
        const member = new RoomMemberModel({
          roomId: data.roomId,
          memberId: data.memberId,
          displayName: data.displayName,
          role: data.role,
          isGuest: data.isGuest ?? false,
          guestExpiresAt: data.guestExpiresAt,
          lastOpId: data.opId,
          joinOpId: data.opId,
          appliedOpIds: data.opId ? [data.opId] : [],
          roleVersion: 1,
          joinedAt: new Date(),
          lastSeenAt: new Date(),
        });
        return await member.save();
      } catch (err: unknown) {
        // Rollback increment on failure
        await RoomModel.updateOne(
          { _id: data.roomId, memberCount: { $gt: 1 }, status: { $ne: "deleted" } },
          { $inc: { memberCount: -1 }, $set: { memberCountUpdatedAt: new Date() } }
        ).exec();

        // Catch concurrent unique index race (E11000) and return existing member
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: number }).code === 11000
        ) {
          const found = await RoomMemberModel.findOne({
            roomId: data.roomId,
            memberId: data.memberId,
          }).exec();
          if (found) return found;
        }

        throw err;
      }
    });
  }

  public async listMembers(roomId: string): Promise<IRoomMember[]> {
    return RoomMemberModel.find({ roomId }).sort({ joinedAt: 1 }).exec();
  }

  public async findMember(roomId: string, memberId: string): Promise<IRoomMember | null> {
    return RoomMemberModel.findOne({ roomId, memberId }).exec();
  }

  public async findMemberByDocId(
    roomId: string,
    memberDocId: string
  ): Promise<IRoomMember | null> {
    if (!mongoose.isValidObjectId(memberDocId)) {
      return null;
    }
    return RoomMemberModel.findOne({ roomId, _id: memberDocId }).exec();
  }

  public async updateRole(
    roomId: string,
    memberDocId: string,
    role: "owner" | "interviewer" | "candidate" | "editor" | "viewer",
    opId?: string
  ): Promise<IRoomMember | null> {
    return roomMutationBarrier.withAdmission(roomId, async () => {
      if (!mongoose.isValidObjectId(memberDocId)) {
        return null;
      }
      // Fencing: verify room exists and is not deleted, ended, or archived
      const room = await RoomModel.findOne({
        _id: roomId,
        status: { $in: ["open", "live"] },
      }).exec();
      if (!room) {
        return null;
      }

      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const existing = await RoomMemberModel.findOne({
          roomId,
          _id: memberDocId,
        }).exec();
        if (!existing) {
          return null;
        }

        // Idempotency: if opId already recorded in roleOps, return existing
        if (opId && existing.roleOps?.some((r) => r.opId === opId)) {
          return existing;
        }

        // Bounded capacity check for unresolved operations
        if (existing.roleOps && existing.roleOps.length >= 50) {
          throw new AppError(
            "Too many pending role operations for member. Please retry.",
            409,
            "CAPACITY_EXCEEDED"
          );
        }

        const currentVersion = existing.roleVersion ?? 1;
        const nextVersion = currentVersion + 1;
        const roleOpEvidence: IRoleOpEvidence | undefined = opId
          ? { opId, role, version: nextVersion, appliedAt: new Date() }
          : undefined;

        const setUpdate: Record<string, unknown> = {
          role,
          roleVersion: nextVersion,
          lastSeenAt: new Date(),
        };
        if (opId) setUpdate["lastOpId"] = opId;

        const updateOps: Record<string, unknown> = {
          $set: setUpdate,
        };
        if (opId) {
          updateOps["$addToSet"] = { appliedOpIds: opId };
          updateOps["$push"] = { roleOps: roleOpEvidence };
        }

        const updated = await RoomMemberModel.findOneAndUpdate(
          {
            roomId,
            _id: memberDocId,
            $or: [{ roleVersion: currentVersion }, { roleVersion: { $exists: false } }],
          },
          updateOps,
          { new: true }
        ).exec();

        if (updated) {
          return updated;
        }
      }

      return null;
    });
  }

  /**
   * Removes participant crash-consistently via staged tombstone and atomically decrements memberCount.
   * If opId is provided, records operation ownership in removedMembers array and lastRemovedMember.
   */
  public async removeMember(
    roomId: string,
    memberDocId: string,
    opId?: string
  ): Promise<boolean> {
    return roomMutationBarrier.withAdmission(roomId, async () => {
      if (!mongoose.isValidObjectId(memberDocId)) {
        return false;
      }

      if (opId && mongoose.connection.readyState === 1) {
        const roomDoc = await RoomModel.findById(roomId).select("removedMembers").exec();
        if (
          roomDoc &&
          roomDoc.removedMembers &&
          roomDoc.removedMembers.length >= 100 &&
          !roomDoc.removedMembers.some((r) => r.opId === opId)
        ) {
          throw new AppError(
            "Too many pending removal operations for room. Please retry.",
            409,
            "CAPACITY_EXCEEDED"
          );
        }
      }

      // Step 1: Stage tombstone on member document to ensure crash-recovery idempotency
      const tombstoneMarker = opId || "pending_removal";
      let member = await RoomMemberModel.findOneAndUpdate(
        { roomId, _id: memberDocId, tombstoneOpId: { $exists: false } },
        { $set: { tombstoneOpId: tombstoneMarker } },
        { new: true }
      ).exec();

      if (!member) {
        // Check if already tombstoned by this exact opId (retry or recovery)
        member = await RoomMemberModel.findOne({
          roomId,
          _id: memberDocId,
          tombstoneOpId: tombstoneMarker,
        }).exec();
        if (!member) {
          return false;
        }
      }

      // Step 2: Update RoomModel memberCount and record removal evidence
      const roomSet: Record<string, unknown> = {
        memberCountUpdatedAt: new Date(),
      };
      if (opId) {
        roomSet["lastRemovedMember"] = { memberDocId, opId };
      }
      const roomUpdate: Record<string, unknown> = {
        $inc: { memberCount: -1 },
        $set: roomSet,
      };
      if (opId) {
        roomUpdate["$push"] = {
          removedMembers: { memberDocId, opId, removedAt: new Date() },
        };
      }
      await RoomModel.updateOne(
        { _id: roomId, memberCount: { $gt: 1 }, status: { $ne: "deleted" } },
        roomUpdate
      ).exec();

      // Step 3: Hard-delete the tombstoned member document
      await RoomMemberModel.deleteOne({ roomId, _id: memberDocId }).exec();
      return true;
    });
  }

  /**
   * Cleans up operation ownership evidence on terminal operation resolution.
   */
  public async clearOperationEvidence(
    roomId: string,
    memberDocId: string,
    opId: string
  ): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    if (!mongoose.isValidObjectId(memberDocId)) return;
    await RoomMemberModel.updateOne(
      { roomId, _id: memberDocId },
      { $pull: { appliedOpIds: opId, roleOps: { opId } } }
    ).exec();
  }

  /**
   * Removes participant by memberId (user id or guest id) and atomically decrements memberCount
   * if document was deleted and memberCount > 1.
   */
  public async removeByMemberId(roomId: string, memberId: string): Promise<boolean> {
    return roomMutationBarrier.withAdmission(roomId, async () => {
      const result = await RoomMemberModel.findOneAndDelete({
        roomId,
        memberId,
      }).exec();

      if (result) {
        await RoomModel.updateOne(
          { _id: roomId, memberCount: { $gt: 1 }, status: { $ne: "deleted" } },
          { $inc: { memberCount: -1 }, $set: { memberCountUpdatedAt: new Date() } }
        ).exec();
        return true;
      }
      return false;
    });
  }

  /**
   * PRD PER-2: Retrieve rooms owned or joined by user, ordered by joinedAt desc.
   * Uses compound (joinedAt, _id) cursor. Validates cursor strictly; throws 400 INVALID_CURSOR on bad cursor.
   */
  public async listMyRooms(
    userId: string,
    limit = 20,
    cursor?: string
  ): Promise<{ rooms: IRoom[]; nextCursor?: string }> {
    let cursorDate: Date | undefined;
    let cursorId: string | undefined;

    if (cursor) {
      try {
        const jsonStr = Buffer.from(cursor, "base64url").toString("utf-8");
        const decoded = JSON.parse(jsonStr) as Record<string, unknown>;
        if (
          !decoded ||
          typeof decoded !== "object" ||
          typeof decoded["id"] !== "string" ||
          !mongoose.isValidObjectId(decoded["id"]) ||
          typeof decoded["joinedAt"] !== "string" ||
          isNaN(Date.parse(decoded["joinedAt"]))
        ) {
          throw new Error("Invalid cursor format");
        }
        cursorDate = new Date(decoded["joinedAt"]);
        cursorId = decoded["id"];
      } catch {
        throw new AppError("Invalid pagination cursor", 400, "INVALID_CURSOR");
      }
    }

    const memberFilter: Record<string, unknown> = { memberId: userId };
    if (cursorDate && cursorId) {
      memberFilter["$or"] = [
        { joinedAt: { $lt: cursorDate } },
        { joinedAt: cursorDate, _id: { $lt: cursorId } },
      ];
    }

    const memberships = await RoomMemberModel.find(memberFilter)
      .sort({ joinedAt: -1, _id: -1 })
      .limit(limit + 1)
      .exec();

    const hasNextPage = memberships.length > limit;
    const pageMemberships = hasNextPage ? memberships.slice(0, limit) : memberships;

    const roomIds = pageMemberships.map((m) => m.roomId);
    const rooms = await RoomModel.find({ _id: { $in: roomIds } }).exec();

    // Preserve order matching memberships
    const roomMap = new Map(rooms.map((r) => [r.id, r]));
    const orderedRooms: IRoom[] = [];
    for (const m of pageMemberships) {
      const r = roomMap.get(m.roomId);
      if (r) orderedRooms.push(r);
    }

    let nextCursor: string | undefined;
    if (hasNextPage && pageMemberships.length > 0) {
      const lastItem = pageMemberships[pageMemberships.length - 1]!;
      nextCursor = Buffer.from(
        JSON.stringify({
          id: lastItem.id,
          joinedAt: lastItem.joinedAt.toISOString(),
        }),
        "utf-8"
      ).toString("base64url");
    }

    return { rooms: orderedRooms, nextCursor };
  }

  /**
   * Daily maintenance: purges expired guest members using distinct roomId query
   * and atomically decrements memberCount per room by the number of purged members.
   */
  public async purgeExpiredGuestMembers(cutoffDate = new Date()): Promise<number> {
    const roomIds = await RoomMemberModel.distinct("roomId", {
      guestExpiresAt: { $lte: cutoffDate },
    });

    let totalPurged = 0;

    for (const roomId of roomIds) {
      const res = await RoomMemberModel.deleteMany({
        roomId,
        guestExpiresAt: { $lte: cutoffDate },
      }).exec();

      if (res.deletedCount > 0) {
        totalPurged += res.deletedCount;
        await RoomModel.updateOne(
          { _id: roomId, memberCount: { $gt: res.deletedCount } },
          {
            $inc: { memberCount: -res.deletedCount },
            $set: { memberCountUpdatedAt: new Date() },
          }
        ).exec();
      }
    }

    return totalPurged;
  }
}

export const roomMemberRepo = new RoomMemberRepo();
