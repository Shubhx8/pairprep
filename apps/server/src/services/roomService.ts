import crypto from "node:crypto";
import {
  Room,
  RoomMember,
  UserRole,
  CreateRoomRequest,
  JoinRoomRequest,
  PARTICIPANT_PALETTE,
} from "@pairprep/shared";

export class RoomError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "RoomError";
  }
}

interface IdempotencyRecord {
  room: Room;
  createdAt: number;
}

export class RoomService {
  private roomsById = new Map<string, Room>();
  private roomsBySlug = new Map<string, string>(); // slug -> id
  private idempotencyCache = new Map<string, IdempotencyRecord>();

  /**
   * PRD ROOM-1: Generate a cryptographically secure slug with at least 128 bits of entropy
   */
  public generateSlug(): string {
    return crypto.randomBytes(16).toString("hex"); // 16 bytes = 128 bits of cryptographic randomness
  }

  /**
   * PRD ROOM-1 & CONC-3: Create a new room with unguessable slug and optional idempotency key
   */
  public createRoom(
    params: CreateRoomRequest,
    ownerId: string,
    idempotencyKey?: string
  ): { room: Room; ownerMember: RoomMember } {
    // PRD CONC-3: Idempotency check (within 24 hours)
    if (idempotencyKey) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && Date.now() - cached.createdAt < 24 * 60 * 60 * 1000) {
        const owner =
          cached.room.members.find((m) => m.id === ownerId) || cached.room.members[0];
        if (!owner) {
          throw new RoomError("INTERNAL_ERROR", "Cached room has no members", 500);
        }
        return { room: cached.room, ownerMember: owner };
      }
    }

    const roomId = crypto.randomUUID();
    const slug = this.generateSlug();
    const now = new Date().toISOString();

    const ownerMember: RoomMember = {
      id: ownerId,
      displayName: params.ownerName || "Anonymous Host",
      role: "owner",
      color: PARTICIPANT_PALETTE[0],
      isGuest: true,
      joinedAt: now,
    };

    const room: Room = {
      id: roomId,
      slug,
      title: params.title,
      type: params.type,
      language: params.language,
      status: "open",
      ownerId,
      timeLimitSec: params.timeLimitSec,
      members: [ownerMember],
      createdAt: now,
    };

    this.roomsById.set(roomId, room);
    this.roomsBySlug.set(slug, roomId);

    if (idempotencyKey) {
      this.idempotencyCache.set(idempotencyKey, {
        room,
        createdAt: Date.now(),
      });
    }

    return { room, ownerMember };
  }

  /**
   * PRD ROOM-2: Retrieve room metadata and participants by slug
   */
  public getRoomBySlug(slug: string): Room | null {
    const roomId = this.roomsBySlug.get(slug);
    if (!roomId) return null;
    return this.roomsById.get(roomId) || null;
  }

  /**
   * PRD ROOM-2, ROOM-3, ROOM-4 & AUTH-3: Join a room as a guest or authenticated user
   */
  public joinRoom(
    slug: string,
    params: JoinRoomRequest,
    userId: string,
    isGuest: boolean = true
  ): { room: Room; member: RoomMember } {
    const room = this.getRoomBySlug(slug);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "Room not found", 404);
    }

    if (room.status === "ended" || room.status === "archived") {
      throw new RoomError(
        "ROOM_CLOSED",
        "This room has already ended and is read-only",
        403
      );
    }

    // Check if user is already a member
    const existingIndex = room.members.findIndex((m) => m.id === userId);
    if (existingIndex !== -1) {
      const existing = room.members[existingIndex]!;
      // Update display name if changed
      if (params.displayName && existing.displayName !== params.displayName) {
        existing.displayName = params.displayName;
      }
      return { room, member: existing };
    }

    // PRD ROOM-4: Participant limit - max 6 participants
    if (room.members.length >= 6) {
      throw new RoomError(
        "ROOM_FULL",
        "Room is full: maximum of 6 participants reached",
        409
      );
    }

    // Determine initial role
    let initialRole: UserRole = "editor";
    if (params.role) {
      initialRole = params.role;
    } else if (room.type === "interview") {
      // In interview rooms: 1st joiner after owner is candidate, rest are viewers (PRD INT-1)
      const hasCandidate = room.members.some((m) => m.role === "candidate");
      initialRole = hasCandidate ? "viewer" : "candidate";
    }

    // Assign next available color from palette
    const usedColors = new Set(room.members.map((m) => m.color));
    const availableColor: string =
      PARTICIPANT_PALETTE.find((c) => !usedColors.has(c)) ||
      PARTICIPANT_PALETTE[room.members.length % PARTICIPANT_PALETTE.length] ||
      "#3B82F6";

    const newMember: RoomMember = {
      id: userId,
      displayName: params.displayName,
      role: initialRole,
      color: availableColor,
      isGuest,
      joinedAt: new Date().toISOString(),
    };

    room.members.push(newMember);
    return { room, member: newMember };
  }

  /**
   * PRD ROOM-3: Update participant role (only room owner can change roles)
   */
  public updateMemberRole(
    slug: string,
    targetMemberId: string,
    newRole: UserRole,
    requesterId: string
  ): Room {
    const room = this.getRoomBySlug(slug);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "Room not found", 404);
    }

    if (room.ownerId !== requesterId) {
      throw new RoomError(
        "FORBIDDEN",
        "Only the room owner has permission to change participant roles",
        403
      );
    }

    const member = room.members.find((m) => m.id === targetMemberId);
    if (!member) {
      throw new RoomError("MEMBER_NOT_FOUND", "Participant not found in this room", 404);
    }

    // If owner transfers ownership
    if (newRole === "owner") {
      const prevOwner = room.members.find((m) => m.id === room.ownerId);
      if (prevOwner) {
        prevOwner.role = "editor";
      }
      room.ownerId = targetMemberId;
    }

    member.role = newRole;
    return room;
  }

  /**
   * PRD SEC-7 / ROOM-3: Remove a participant (owner only)
   */
  public removeMember(slug: string, targetMemberId: string, requesterId: string): Room {
    const room = this.getRoomBySlug(slug);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "Room not found", 404);
    }

    if (room.ownerId !== requesterId && requesterId !== targetMemberId) {
      throw new RoomError(
        "FORBIDDEN",
        "Only the room owner can remove other participants",
        403
      );
    }

    if (targetMemberId === room.ownerId) {
      throw new RoomError("CANNOT_REMOVE_OWNER", "Room owner cannot be removed", 400);
    }

    room.members = room.members.filter((m) => m.id !== targetMemberId);
    return room;
  }

  /**
   * PRD ROOM-6: End a room (becomes read-only)
   */
  public endRoom(slug: string, requesterId: string): Room {
    const room = this.getRoomBySlug(slug);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", "Room not found", 404);
    }

    if (room.ownerId !== requesterId) {
      throw new RoomError("FORBIDDEN", "Only the room owner can end the session", 403);
    }

    room.status = "ended";
    room.endedAt = new Date().toISOString();
    return room;
  }

  /**
   * Clear all rooms (used for clean test isolation)
   */
  public reset(): void {
    this.roomsById.clear();
    this.roomsBySlug.clear();
    this.idempotencyCache.clear();
  }
}

export const roomService = new RoomService();
