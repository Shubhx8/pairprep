import { RoomMemberModel, IRoomMember } from "../models/room_members.js";

export class RoomFullError extends Error {
  public code = "ROOM_FULL";
  public statusCode = 409;
  constructor(message = "Room has reached its maximum limit of 6 participants") {
    super(message);
    this.name = "RoomFullError";
  }
}

export class RoomMemberRepo {
  /**
   * PRD ROOM-4: Enforce max 6 participants in code.
   * If member already exists in room, updates lastSeenAt and returns existing member.
   * If new member and room already has 6 participants, throws RoomFullError.
   */
  public async addMember(data: {
    roomId: string;
    memberId: string;
    displayName: string;
    role: "owner" | "interviewer" | "candidate" | "editor" | "viewer";
    isGuest?: boolean;
  }): Promise<IRoomMember> {
    const existing = await RoomMemberModel.findOne({
      roomId: data.roomId,
      memberId: data.memberId,
    }).exec();

    if (existing) {
      existing.lastSeenAt = new Date();
      return existing.save();
    }

    const currentCount = await RoomMemberModel.countDocuments({
      roomId: data.roomId,
    }).exec();

    if (currentCount >= 6) {
      throw new RoomFullError();
    }

    const member = new RoomMemberModel({
      roomId: data.roomId,
      memberId: data.memberId,
      displayName: data.displayName,
      role: data.role,
      isGuest: data.isGuest ?? false,
      joinedAt: new Date(),
      lastSeenAt: new Date(),
    });

    return member.save();
  }

  public async listMembers(roomId: string): Promise<IRoomMember[]> {
    return RoomMemberModel.find({ roomId }).sort({ joinedAt: 1 }).exec();
  }

  public async findMember(roomId: string, memberId: string): Promise<IRoomMember | null> {
    return RoomMemberModel.findOne({ roomId, memberId }).exec();
  }

  public async updateRole(
    roomId: string,
    memberId: string,
    role: "owner" | "interviewer" | "candidate" | "editor" | "viewer"
  ): Promise<IRoomMember | null> {
    return RoomMemberModel.findOneAndUpdate(
      { roomId, memberId },
      { $set: { role, lastSeenAt: new Date() } },
      { new: true }
    ).exec();
  }

  public async removeMember(roomId: string, memberId: string): Promise<boolean> {
    const result = await RoomMemberModel.findOneAndDelete({
      roomId,
      memberId,
    }).exec();
    return result !== null;
  }
}

export const roomMemberRepo = new RoomMemberRepo();
