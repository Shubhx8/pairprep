import { Request, Response, NextFunction } from "express";
import { UserRole } from "@pairprep/shared";
import { IRoom } from "../models/rooms.js";
import { IRoomMember } from "../models/room_members.js";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { AppError } from "../errors/AppError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      room?: IRoom;
      roomMember?: IRoomMember;
    }
  }
}

function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] || "";
  return param || "";
}

/**
 * Validates that the requested room exists and that the calling principal is a member of it.
 * Zero slug reflection in error messages.
 */
export async function requireMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const slug = getParam(req.params["slug"]);
  const requestId =
    (res.getHeader("X-Request-Id") as string) ||
    (req.headers["x-request-id"] as string) ||
    "";

  if (!slug) {
    res.status(404).json({
      error: {
        code: "ROOM_NOT_FOUND",
        message: "Room not found",
        requestId,
      },
    });
    return;
  }

  try {
    const room = await roomRepo.findBySlug(slug);
    if (!room) {
      res.status(404).json({
        error: {
          code: "ROOM_NOT_FOUND",
          message: "Room not found",
          requestId,
        },
      });
      return;
    }

    req.room = room;

    if (!req.principal) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
          requestId,
        },
      });
      return;
    }

    const member = await roomMemberRepo.findMember(room.id, req.principal.id);
    if (!member) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "Access denied: you are not a member of this room",
          requestId,
        },
      });
      return;
    }

    req.roomMember = member;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Validates that the room member has one of the allowed roles.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";

    if (!req.roomMember) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "Access denied",
          requestId,
        },
      });
      return;
    }

    if (!allowedRoles.includes(req.roomMember.role)) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "Insufficient permissions for this operation",
          requestId,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Validates that the room is in "open" status.
 * Rejects ended or archived rooms with 409 ROOM_CLOSED.
 */
export function requireOpenRoom(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId =
    (res.getHeader("X-Request-Id") as string) ||
    (req.headers["x-request-id"] as string) ||
    "";

  if (!req.room) {
    res.status(404).json({
      error: {
        code: "ROOM_NOT_FOUND",
        message: "Room not found",
        requestId,
      },
    });
    return;
  }

  if (req.room.status !== "open") {
    res.status(409).json({
      error: {
        code: "ROOM_CLOSED",
        message: "This room is ended or archived and cannot be modified",
        requestId,
      },
    });
    return;
  }

  next();
}

/**
 * Service function asserting that the target member can be demoted or removed.
 * Room owner cannot be demoted or removed.
 */
export function assertCanModifyMember(
  room: IRoom,
  targetMember: IRoomMember,
  action: "demote" | "remove"
): void {
  if (targetMember.role === "owner" || targetMember.memberId === room.ownerId) {
    const code = action === "demote" ? "CANNOT_DEMOTE_OWNER" : "CANNOT_REMOVE_OWNER";
    const message = `Room owner cannot be ${action === "demote" ? "demoted" : "removed"}`;
    throw new AppError(message, 400, code);
  }
}
