import mongoose from "mongoose";
import type { Principal } from "../middleware/identity.js";
import { type UserRole, EventErrorCode } from "@pairprep/shared";
import { RoomModel, type IRoom } from "../models/rooms.js";
import { RoomMemberModel, type IRoomMember } from "../models/room_members.js";
import { UserModel } from "../models/users.js";
import { GuestModel } from "../models/guests.js";
import { syncRegistry } from "../sync/syncRegistry.js";

export interface AuthorizeRoomEventOptions {
  principal?: Principal | null;
  roomId: string;
  allowedRoles?: UserRole[];
  requireWritable?: boolean;
}

export type RoomAuthorizationResult =
  | {
      authorized: true;
      room: IRoom;
      member: IRoomMember;
      principal: Principal;
    }
  | {
      authorized: false;
      code: EventErrorCode;
      message: string;
    };

/**
 * Authoritative Room Event Authorization Service.
 *
 * Revalidates authoritative database state on EVERY protected event:
 * 1. Principal authentication and database connectivity.
 * 2. Principal freshness: user account not disabled, guest token not expired.
 * 3. Room existence, deletion, and lifecycle (ended/archived).
 * 4. Active room membership (rejects removed members).
 * 5. Current role permissions against allowed roles.
 *
 * Never trusts client-supplied claims or stale connection-time socket state.
 */
export async function authorizeRoomEvent(
  options: AuthorizeRoomEventOptions
): Promise<RoomAuthorizationResult> {
  const { principal, roomId, allowedRoles, requireWritable = false } = options;

  // 1. Principal presence check
  if (!principal || !principal.id) {
    return {
      authorized: false,
      code: EventErrorCode.UNAUTHENTICATED,
      message: "Authentication required",
    };
  }

  // 2. Database readiness check
  if (mongoose.connection.readyState !== 1) {
    return {
      authorized: false,
      code: EventErrorCode.INTERNAL_ERROR,
      message: "Database unavailable",
    };
  }

  // 3. Revalidate principal freshness (user or guest)
  if (principal.type === "user") {
    const userDoc = await UserModel.findById(principal.id).exec();
    if (!userDoc) {
      return {
        authorized: false,
        code: EventErrorCode.UNAUTHENTICATED,
        message: "User account not found",
      };
    }
    if (userDoc.disabled) {
      return {
        authorized: false,
        code: EventErrorCode.ACCOUNT_DISABLED,
        message: "Account is disabled",
      };
    }
  } else if (principal.type === "guest") {
    const guestDoc = await GuestModel.findById(principal.id).exec();
    if (!guestDoc || guestDoc.expiresAt.getTime() <= Date.now()) {
      return {
        authorized: false,
        code: EventErrorCode.GUEST_EXPIRED,
        message: "Guest session has expired",
      };
    }
    if (guestDoc.roomId !== roomId) {
      return {
        authorized: false,
        code: EventErrorCode.FORBIDDEN,
        message: "Guest session is not valid for this room",
      };
    }
  } else {
    return {
      authorized: false,
      code: EventErrorCode.UNAUTHENTICATED,
      message: "Invalid principal type",
    };
  }

  // 4. Room existence & lifecycle validation
  if (!mongoose.Types.ObjectId.isValid(roomId)) {
    return {
      authorized: false,
      code: EventErrorCode.BAD_REQUEST,
      message: "Invalid room identifier",
    };
  }

  const room = await RoomModel.findById(roomId).exec();
  if (!room || room.status === "deleted") {
    return {
      authorized: false,
      code: EventErrorCode.ROOM_NOT_FOUND,
      message: "Room not found or has been deleted",
    };
  }

  // 5. Writable room check (PRD ROOM-6 / ED-6)
  if (requireWritable) {
    if (
      room.status === "ended" ||
      room.status === "archived" ||
      syncRegistry.isRoomReadOnly(room.id)
    ) {
      return {
        authorized: false,
        code: EventErrorCode.ROOM_CLOSED,
        message: "This room is ended or archived and cannot be modified",
      };
    }
  }

  // 6. Active membership verification
  const member = await RoomMemberModel.findOne({
    roomId: room.id,
    memberId: principal.id,
  }).exec();

  if (!member) {
    return {
      authorized: false,
      code: EventErrorCode.NOT_ROOM_MEMBER,
      message: "You are not an active member of this room",
    };
  }

  // 7. Role-based permission enforcement
  if (allowedRoles && allowedRoles.length > 0) {
    if (!allowedRoles.includes(member.role)) {
      return {
        authorized: false,
        code: EventErrorCode.INSUFFICIENT_ROLE,
        message: "Insufficient permissions for this operation",
      };
    }
  }

  return {
    authorized: true,
    room,
    member,
    principal,
  };
}
