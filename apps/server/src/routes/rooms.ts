import { Router, Request, Response, NextFunction } from "express";
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  UpdateMemberRoleRequestSchema,
  RoomListQuerySchema,
  toRoomDto,
  toPublicRoomDto,
  toRoomMemberDto,
} from "@pairprep/shared";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo, RoomFullError } from "../repos/roomMemberRepo.js";
import { guestRepo } from "../repos/guestRepo.js";
import {
  requireUser,
  requirePrincipal,
  setGuestCookie,
  UserPrincipal,
} from "../middleware/identity.js";
import {
  requireMember,
  requireRole,
  requireOpenRoom,
  assertCanModifyMember,
} from "../middleware/authorization.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  roomCreationLimiter,
  roomJoinLookupLimiter,
} from "../middleware/roomRateLimiter.js";
import { AppError } from "../errors/AppError.js";
import { IRoom } from "../models/rooms.js";
import { IRoomMember } from "../models/room_members.js";

export const roomsRouter = Router();

function getRequestId(req: Request, res: Response): string {
  return (
    (res.getHeader("X-Request-Id") as string) ||
    (req.headers["x-request-id"] as string) ||
    ""
  );
}

function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] || "";
  return param || "";
}

/**
 * PRD 13.1 / ROOM-1 & CONC-3: Create a new room with unguessable slug
 * Pipeline: requireUser -> idempotencyMiddleware -> roomCreationLimiter
 */
roomsRouter.post(
  "/",
  requireUser,
  idempotencyMiddleware,
  roomCreationLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = getRequestId(req, res);
    const parseResult = CreateRoomRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_FAILED",
          message: parseResult.error.errors.map((e) => e.message).join(", "),
          requestId,
        },
      });
      return;
    }

    const user = req.principal as UserPrincipal;
    const rawIdempotencyKey = (req.headers["idempotency-key"] ||
      req.headers["x-idempotency-key"]) as string | undefined;
    const trimmedIdempotencyKey = rawIdempotencyKey?.trim() || undefined;

    try {
      let room: IRoom;
      try {
        room = await roomRepo.createRoom({
          title: parseResult.data.title,
          type: "practice",
          language: parseResult.data.language,
          timeLimitSec: parseResult.data.timeLimitSec,
          ownerId: user.id,
          idempotencyKey: trimmedIdempotencyKey,
        });
      } catch (err: unknown) {
        // Crash recovery: check if room was already created under (ownerId, idempotencyKey)
        if (
          trimmedIdempotencyKey &&
          typeof err === "object" &&
          err !== null &&
          (err as { code?: number }).code === 11000
        ) {
          const existing = await roomRepo.findByOwnerAndIdempotencyKey(
            user.id,
            trimmedIdempotencyKey
          );
          if (existing) {
            const owner = await roomMemberRepo.findMember(existing.id, user.id);
            res.status(201).json({
              room: toRoomDto(existing),
              currentMember: owner ? toRoomMemberDto(owner) : undefined,
            });
            return;
          }
        }
        throw err;
      }

      let ownerMember: IRoomMember;
      try {
        ownerMember = await roomMemberRepo.addMember({
          roomId: room.id,
          memberId: user.id,
          displayName: user.displayName,
          role: "owner",
          isGuest: false,
        });
      } catch (memberErr) {
        // Compensation: if owner member insert fails, delete the created room document
        await roomRepo.deleteRoom(room.id);
        throw memberErr;
      }

      res.status(201).json({
        room: toRoomDto(room),
        currentMember: toRoomMemberDto(ownerMember),
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / PER-2: Retrieve my rooms (owned and joined), cursor-paginated
 */
roomsRouter.get(
  "/",
  requireUser,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = getRequestId(req, res);
    const parseQuery = RoomListQuerySchema.safeParse(req.query);

    if (!parseQuery.success) {
      res.status(400).json({
        error: {
          code: "INVALID_CURSOR",
          message: "Invalid pagination cursor",
          requestId,
        },
      });
      return;
    }

    try {
      const user = req.principal as UserPrincipal;
      const { rooms, nextCursor } = await roomMemberRepo.listMyRooms(
        user.id,
        parseQuery.data.limit,
        parseQuery.data.cursor
      );

      res.json({
        rooms: rooms.map(toRoomDto),
        nextCursor,
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / ROOM-2: Retrieve room details by unguessable slug
 * Public: returns PublicRoomDto (never other participants' details)
 * Member: returns full RoomResponse with member list
 */
roomsRouter.get(
  "/:slug",
  roomJoinLookupLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const slug = getParam(req.params.slug);
    const requestId = getRequestId(req, res);

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

      const currentPrincipalId = req.principal?.id;
      const member = currentPrincipalId
        ? await roomMemberRepo.findMember(room.id, currentPrincipalId)
        : null;

      if (!member) {
        res.json({ room: toPublicRoomDto(room) });
        return;
      }

      const allMembers = await roomMemberRepo.listMembers(room.id);

      res.json({
        room: toRoomDto(room),
        currentMember: toRoomMemberDto(member),
        members: allMembers.map(toRoomMemberDto),
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / ROOM-2, ROOM-3, ROOM-4 & AUTH-3: Join room as guest or authenticated user
 */
roomsRouter.post(
  "/:slug/join",
  roomJoinLookupLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const slug = getParam(req.params.slug);
    const requestId = getRequestId(req, res);

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

      // Check room status first
      if (room.status !== "open") {
        res.status(409).json({
          error: {
            code: "ROOM_CLOSED",
            message: "This room is ended or archived and cannot be modified",
            requestId,
          },
        });
        return;
      }

      // 1. Signed-in user join (takes precedence over any guest cookie)
      if (req.principal?.type === "user") {
        const user = req.principal;
        const existingMember = await roomMemberRepo.findMember(room.id, user.id);
        if (existingMember) {
          res.json({
            room: toRoomDto(room),
            currentMember: toRoomMemberDto(existingMember),
          });
          return;
        }

        const member = await roomMemberRepo.addMember({
          roomId: room.id,
          memberId: user.id,
          displayName: user.displayName,
          role: "editor",
          isGuest: false,
        });

        res.json({
          room: toRoomDto(room),
          currentMember: toRoomMemberDto(member),
        });
        return;
      }

      // 2. Guest join
      const parseResult = JoinRoomRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: "VALIDATION_FAILED",
            message: parseResult.error.errors.map((e) => e.message).join(", "),
            requestId,
          },
        });
        return;
      }

      const displayName = parseResult.data.displayName;

      // Same-room guest rejoin
      if (req.principal?.type === "guest" && req.principal.roomId === room.id) {
        const member = await roomMemberRepo.addMember({
          roomId: room.id,
          memberId: req.principal.id,
          displayName,
          role: "editor",
          isGuest: true,
          guestExpiresAt: req.principal.guest.expiresAt,
        });

        res.json({
          room: toRoomDto(room),
          currentMember: toRoomMemberDto(member),
        });
        return;
      }

      // Cross-room guest join or anonymous new guest
      const oldRoomId =
        req.principal?.type === "guest" && req.principal.roomId !== room.id
          ? req.principal.roomId
          : undefined;
      const oldGuestId = oldRoomId ? req.principal?.id : undefined;

      // Create new Room B guest document and membership first
      const guestDoc = await guestRepo.createGuest(displayName, room.id);
      const member = await roomMemberRepo.addMember({
        roomId: room.id,
        memberId: guestDoc.id,
        displayName: guestDoc.displayName,
        role: "editor",
        isGuest: true,
        guestExpiresAt: guestDoc.expiresAt,
      });

      // Set new cookie for Room B
      setGuestCookie(res, guestDoc.id);

      // Best-effort cleanup of old Room A membership afterwards
      if (oldRoomId && oldGuestId) {
        (async () => {
          try {
            await roomMemberRepo.removeMember(oldRoomId, oldGuestId);
            await guestRepo.deleteGuest(oldGuestId);
          } catch {
            // Ignore best-effort cleanup errors
          }
        })();
      }

      res.json({
        room: toRoomDto(room),
        currentMember: toRoomMemberDto(member),
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / ROOM-3: Change participant role (owner only)
 */
roomsRouter.patch(
  "/:slug/members/:id",
  requirePrincipal,
  idempotencyMiddleware,
  requireMember,
  requireRole(["owner"]),
  requireOpenRoom,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = getRequestId(req, res);
    const targetId = getParam(req.params.id);
    const parseResult = UpdateMemberRoleRequestSchema.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_FAILED",
          message: parseResult.error.errors.map((e) => e.message).join(", "),
          requestId,
        },
      });
      return;
    }

    try {
      const room = req.room!;
      const targetMember =
        (await roomMemberRepo.findMemberByDocId(room.id, targetId)) ||
        (await roomMemberRepo.findMember(room.id, targetId));

      if (!targetMember) {
        res.status(404).json({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Participant not found in this room",
            requestId,
          },
        });
        return;
      }

      assertCanModifyMember(room, targetMember, "demote");

      const updatedMember = await roomMemberRepo.updateRole(
        room.id,
        targetMember.id,
        parseResult.data.role
      );

      await roomRepo.touchActivity(room.id);
      const updatedRoom = await roomRepo.findById(room.id);

      res.json({
        room: toRoomDto(updatedRoom || room),
        currentMember: updatedMember ? toRoomMemberDto(updatedMember) : undefined,
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / SEC-7 / ROOM-3: Remove participant from room (owner only)
 */
roomsRouter.delete(
  "/:slug/members/:id",
  requirePrincipal,
  requireMember,
  requireRole(["owner"]),
  requireOpenRoom,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = getRequestId(req, res);
    const targetId = getParam(req.params.id);

    try {
      const room = req.room!;
      const targetMember =
        (await roomMemberRepo.findMemberByDocId(room.id, targetId)) ||
        (await roomMemberRepo.findMember(room.id, targetId));

      if (!targetMember) {
        res.status(404).json({
          error: {
            code: "MEMBER_NOT_FOUND",
            message: "Participant not found in this room",
            requestId,
          },
        });
        return;
      }

      assertCanModifyMember(room, targetMember, "remove");

      await roomMemberRepo.removeMember(room.id, targetMember.id);
      await roomRepo.touchActivity(room.id);

      res.json({ status: "ok" });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / ROOM-6: End session (owner only, idempotent)
 */
roomsRouter.post(
  "/:slug/end",
  requirePrincipal,
  idempotencyMiddleware,
  requireMember,
  requireRole(["owner"]),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const room = req.room!;

      // Idempotent: if already ended, return current ended room DTO
      if (room.status === "ended") {
        res.json({ room: toRoomDto(room) });
        return;
      }

      const endedRoom = await roomRepo.updateStatus(room.slug, "ended");
      res.json({ room: toRoomDto(endedRoom || room) });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / ROOM-6: Delete room (owner only, cascade children first)
 */
roomsRouter.delete(
  "/:slug",
  requireUser,
  idempotencyMiddleware,
  requireMember,
  requireRole(["owner"]),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const room = req.room!;
      await roomRepo.deleteRoom(room.id);
      res.status(204).end();
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

function handleRouteError(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = getRequestId(req, res);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
        fields: err.fields,
      },
    });
    return;
  }

  if (err instanceof RoomFullError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    });
    return;
  }

  next(err);
}
