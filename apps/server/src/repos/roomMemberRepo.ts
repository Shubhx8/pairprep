import { RoomMemberModel, IRoomMember } from "../models/room_members.js";
import { RoomModel, IRoom } from "../models/rooms.js";
import { AppError } from "../errors/AppError.js";

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
  }): Promise<IRoomMember> {
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
      return existing.save();
    }

    // 2. Fetch room to check existence and status
    const room = await RoomModel.findById(data.roomId).exec();
    if (!room) {
      throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
    }
    if (room.status !== "open") {
      throw new AppError(
        "This room is ended or archived and cannot be modified",
        409,
        "ROOM_CLOSED"
      );
    }

    // 3. Conditional atomic increment
    const now = new Date();
    let updatedRoom = await RoomModel.findOneAndUpdate(
      { _id: data.roomId, memberCount: { $lt: 6 }, status: "open" },
      { $inc: { memberCount: 1 }, $set: { memberCountUpdatedAt: now } },
      { new: true }
    ).exec();

    // 4. Fenced self-healing (> 60s)
    if (!updatedRoom) {
      const currentRoom = await RoomModel.findById(data.roomId).exec();
      if (!currentRoom) {
        throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
      }
      if (currentRoom.status !== "open") {
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
              { _id: data.roomId, memberCount: { $lt: 6 }, status: "open" },
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
        joinedAt: new Date(),
        lastSeenAt: new Date(),
      });
      return await member.save();
    } catch (err: unknown) {
      // Rollback increment on failure
      await RoomModel.updateOne(
        { _id: data.roomId, memberCount: { $gt: 1 } },
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
    return RoomMemberModel.findOne({ roomId, _id: memberDocId }).exec();
  }

  public async updateRole(
    roomId: string,
    memberDocId: string,
    role: "owner" | "interviewer" | "candidate" | "editor" | "viewer"
  ): Promise<IRoomMember | null> {
    return RoomMemberModel.findOneAndUpdate(
      { roomId, _id: memberDocId },
      { $set: { role, lastSeenAt: new Date() } },
      { new: true }
    ).exec();
  }

  /**
   * Removes participant and atomically decrements memberCount if document was deleted and memberCount > 1.
   */
  public async removeMember(roomId: string, memberDocId: string): Promise<boolean> {
    const result = await RoomMemberModel.findOneAndDelete({
      roomId,
      _id: memberDocId,
    }).exec();

    if (result) {
      await RoomModel.updateOne(
        { _id: roomId, memberCount: { $gt: 1 } },
        { $inc: { memberCount: -1 }, $set: { memberCountUpdatedAt: new Date() } }
      ).exec();
      return true;
    }
    return false;
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
