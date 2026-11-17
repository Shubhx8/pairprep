import { Router, Request, Response, NextFunction } from "express";
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  UpdateMemberRoleRequestSchema,
  RoomListQuerySchema,
  toRoomDto,
  toPublicRoomDto,
  toRoomMemberDto,
  toMessageDto,
  ChatHistoryQuerySchema,
} from "@pairprep/shared";
import { roomRepo } from "../repos/roomRepo.js";
import { roomBanRepo } from "../repos/roomBanRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { guestRepo } from "../repos/guestRepo.js";
import { messageRepo } from "../repos/messageRepo.js";
import { getSocketServer } from "../events/socketServer.js";
import { presenceTracker } from "../events/presenceTracker.js";
import { outboxService } from "../events/outboxService.js";
import {
  requireUser,
  requirePrincipal,
  setGuestCookie,
  clearGuestCookie,
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
import { rootLogger } from "../middleware/logger.js";
import { syncRegistry } from "../sync/syncRegistry.js";
import { clientMapRepo } from "../repos/clientMapRepo.js";

export const roomsRouter = Router();

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
    try {
      const parseResult = CreateRoomRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        throw new AppError(
          parseResult.error.issues.map((e) => e.message).join(", "),
          400,
          "VALIDATION_ERROR"
        );
      }

      const user = req.principal as UserPrincipal;
      const rawIdempotencyKey =
        req.idempotencyKey || (req.headers["idempotency-key"] as string | undefined);
      const trimmedIdempotencyKey = rawIdempotencyKey?.trim() || undefined;

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
            let owner = await roomMemberRepo.findMember(existing.id, user.id);
            if (!owner) {
              owner = await roomMemberRepo.addMember({
                roomId: existing.id,
                memberId: user.id,
                displayName: user.displayName,
                role: "owner",
                isGuest: false,
              });
            }
            res.status(201).json({
              room: toRoomDto(existing),
              currentMember: toRoomMemberDto(owner),
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
    try {
      const parseQuery = RoomListQuerySchema.safeParse(req.query);

      if (!parseQuery.success) {
        const hasLimitError = parseQuery.error.issues.some((i) =>
          i.path.includes("limit")
        );
        if (hasLimitError) {
          throw new AppError("Invalid limit parameter", 400, "VALIDATION_ERROR");
        }
        throw new AppError("Invalid pagination cursor", 400, "INVALID_CURSOR");
      }
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

    try {
      const room = await roomRepo.findBySlug(slug);
      if (!room) {
        throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
      }

      const currentPrincipal = req.principal;
      if (currentPrincipal) {
        const isBanned = await roomBanRepo.isBanned(
          room.id,
          currentPrincipal.type,
          currentPrincipal.id
        );
        if (isBanned) {
          throw new AppError(
            "You have been removed from this room and cannot rejoin",
            403,
            "MEMBER_BANNED"
          );
        }
      }

      const member = currentPrincipal
        ? await roomMemberRepo.findMember(room.id, currentPrincipal.id)
        : null;

      if (!member) {
        res.json({
          room: toPublicRoomDto(room),
          serverTime: new Date().toISOString(),
        });
        return;
      }

      const allMembers = await roomMemberRepo.listMembers(room.id);

      const activeConns = syncRegistry.getActiveConnectionsForRoom(room.id);
      const activeMemberIds = new Set<string>();
      for (const conn of activeConns) {
        if (conn.memberId) {
          activeMemberIds.add(conn.memberId);
        }
      }

      const onlinePresenceMembers = presenceTracker.getOnlineMembers(room.id);
      for (const p of onlinePresenceMembers) {
        if (p.memberId) activeMemberIds.add(p.memberId);
        if (p.memberDocId) activeMemberIds.add(p.memberDocId);
      }

      const distinctPrincipalIds = new Set<string>();
      for (const conn of activeConns) {
        if (conn.memberId) distinctPrincipalIds.add(conn.memberId);
      }
      for (const p of onlinePresenceMembers) {
        if (p.memberId) distinctPrincipalIds.add(p.memberId);
      }
      const onlineMemberCount = distinctPrincipalIds.size;

      res.json({
        room: toRoomDto(room),
        serverTime: new Date().toISOString(),
        currentMember: toRoomMemberDto(member, {
          isOnline:
            activeMemberIds.has(member.memberId) ||
            activeMemberIds.has(String(member._id ?? member.id ?? "")),
        }),
        members: allMembers.map((m) => {
          const docId = String(m._id ?? m.id ?? "");
          return toRoomMemberDto(m, {
            isOnline:
              activeMemberIds.has(m.memberId) ||
              (docId ? activeMemberIds.has(docId) : false),
          });
        }),
        onlineMemberCount,
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

    try {
      const room = await roomRepo.findBySlug(slug);
      if (!room) {
        throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
      }

      // Check room status first: closed means ended or archived
      if (room.status === "ended" || room.status === "archived") {
        throw new AppError(
          "This room is ended or archived and cannot be modified",
          409,
          "ROOM_CLOSED"
        );
      }

      // Check if principal is banned from this room (P0-D re-entry prevention via canonical roomBanRepo)
      if (req.principal) {
        const isBanned = await roomBanRepo.isBanned(
          room.id,
          req.principal.type,
          req.principal.id
        );
        if (isBanned) {
          throw new AppError(
            "You have been removed from this room by the host and cannot rejoin",
            403,
            "MEMBER_BANNED"
          );
        }
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

        const io = getSocketServer();
        const opId = outboxService.generateOpId(
          "join",
          room.id,
          user.id,
          String(Date.now())
        );

        const outboxResult = await outboxService.executeDurableOperation<IRoomMember>({
          opId,
          type: "join",
          roomId: room.id,
          payload: {
            memberId: user.id,
            displayName: user.displayName,
            role: "editor",
          },
          messageText: `${user.displayName} joined the room`,
          io,
          mutation: async () => {
            return roomMemberRepo.addMember({
              roomId: room.id,
              memberId: user.id,
              displayName: user.displayName,
              role: "editor",
              isGuest: false,
              opId,
            });
          },
        });
        const member = outboxResult.result;

        await roomRepo.touchActivity(room.id);
        const updatedRoom = await roomRepo.findById(room.id);

        res.json({
          room: toRoomDto(updatedRoom || room),
          currentMember: toRoomMemberDto(member),
        });
        return;
      }

      // 2. Guest join
      const parseResult = JoinRoomRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new AppError(
          parseResult.error.issues.map((e) => e.message).join(", "),
          400,
          "VALIDATION_ERROR"
        );
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

        await roomRepo.touchActivity(room.id);
        const updatedRoom = await roomRepo.findById(room.id);

        res.json({
          room: toRoomDto(updatedRoom || room),
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

      // Create new Room B guest document first
      const guestDoc = await guestRepo.createGuest(displayName, room.id);
      let member: IRoomMember;
      try {
        const io = getSocketServer();
        const opId = outboxService.generateOpId(
          "join",
          room.id,
          guestDoc.id,
          String(Date.now())
        );

        const outboxResult = await outboxService.executeDurableOperation<IRoomMember>({
          opId,
          type: "join",
          roomId: room.id,
          payload: {
            memberId: guestDoc.id,
            displayName: guestDoc.displayName,
            role: "editor",
          },
          messageText: `${guestDoc.displayName} joined the room`,
          io,
          mutation: async () => {
            return roomMemberRepo.addMember({
              roomId: room.id,
              memberId: guestDoc.id,
              displayName: guestDoc.displayName,
              role: "editor",
              isGuest: true,
              guestExpiresAt: guestDoc.expiresAt,
              opId,
            });
          },
        });
        member = outboxResult.result;
      } catch (addErr) {
        // On join failure (e.g. ROOM_FULL), delete the guest created in that request
        await guestRepo.deleteGuest(guestDoc.id);
        throw addErr;
      }

      // Set new cookie for Room B
      setGuestCookie(res, guestDoc.id);

      // Await cleanup of old Room A membership before responding (Item 13 & Phase 17)
      if (oldRoomId && oldGuestId) {
        try {
          const io = getSocketServer();
          const departureOpId = outboxService.generateOpId(
            "remove",
            oldRoomId,
            oldGuestId,
            String(Date.now())
          );
          await outboxService.executeDurableOperation({
            opId: departureOpId,
            type: "remove",
            roomId: oldRoomId,
            payload: {
              memberId: oldGuestId,
              memberDocId: oldGuestId,
            },
            io,
            mutation: async () => {
              return roomMemberRepo.removeByMemberId(
                oldRoomId,
                oldGuestId,
                departureOpId
              );
            },
          });
          await guestRepo.deleteGuest(oldGuestId);
        } catch (err) {
          const errorName = err instanceof Error ? err.name : "UnknownError";
          rootLogger.warn({ errorName }, "Old room guest cleanup failed");
        }
      }

      await roomRepo.touchActivity(room.id);
      const updatedRoom = await roomRepo.findById(room.id);

      res.json({
        room: toRoomDto(updatedRoom || room),
        currentMember: toRoomMemberDto(member),
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / P0-A: Voluntary room departure
 */
roomsRouter.post(
  "/:slug/leave",
  requirePrincipal,
  idempotencyMiddleware,
  requireMember,
  requireOpenRoom,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const room = req.room!;
      const member = req.roomMember!;

      if (member.role === "owner" || member.memberId === room.ownerId) {
        throw new AppError(
          "The room owner cannot leave the room. End or delete the session instead.",
          400,
          "CANNOT_LEAVE_AS_OWNER"
        );
      }

      // Immediately terminate active WebSocket connections for departing member (< 1s revocation)
      syncRegistry.closeConnectionsForMember(room.id, member.memberId, 1000, "left");

      // Durable outbox operation for voluntary departure (reason: "left")
      const io = getSocketServer();
      const opId = outboxService.generateOpId(
        "remove",
        room.id,
        member.id,
        String(Date.now())
      );

      await outboxService.executeDurableOperation({
        opId,
        type: "remove",
        roomId: room.id,
        payload: {
          memberDocId: member.id,
          memberId: member.memberId,
          reason: "left",
        },
        messageText: `${member.displayName} left the room`,
        io,
        mutation: async () => {
          return roomMemberRepo.removeMember(room.id, member.id, opId);
        },
      });

      // Disconnect member Socket.IO sockets after broadcast has gone out (< 1s revocation)
      presenceTracker.disconnectMemberSockets(room.id, member.id);

      // Clear guest cookie and delete guest identity if guest
      if (req.principal?.type === "guest") {
        clearGuestCookie(res);
        try {
          await guestRepo.deleteGuest(member.memberId);
        } catch (err) {
          rootLogger.warn({ err }, "Failed to delete departing guest document");
        }
      }

      await roomRepo.touchActivity(room.id);

      res.json({ status: "ok" });
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
    try {
      const targetId = getParam(req.params.id);
      const parseResult = UpdateMemberRoleRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        throw new AppError(
          parseResult.error.issues.map((e) => e.message).join(", "),
          400,
          "VALIDATION_ERROR"
        );
      }

      const room = req.room!;
      // Accept only the membership id
      const targetMember = await roomMemberRepo.findMemberByDocId(room.id, targetId);

      if (!targetMember) {
        throw new AppError("Participant not found in this room", 404, "MEMBER_NOT_FOUND");
      }

      assertCanModifyMember(room, targetMember, "demote");

      const previousRole = targetMember.role;
      const newRole = parseResult.data.role;

      // Coordinate outbox durable operation and Socket.IO broadcast
      const io = getSocketServer();
      const opId = outboxService.generateOpId(
        "role_change",
        room.id,
        targetMember.id,
        String(Date.now())
      );

      let updatedMember: IRoomMember | null = null;
      await outboxService.executeDurableOperation({
        opId,
        type: "role_change",
        roomId: room.id,
        payload: {
          memberDocId: targetMember.id,
          memberId: targetMember.memberId,
          role: newRole,
          previousRole,
        },
        messageText: `${targetMember.displayName}'s role was changed from ${previousRole} to ${newRole}`,
        io,
        mutation: async () => {
          updatedMember = await roomMemberRepo.updateRole(
            room.id,
            targetMember.id,
            newRole,
            opId
          );
          return updatedMember;
        },
      });

      // Update in-memory presence tracking
      presenceTracker.updateMemberRole(targetMember.id, newRole);

      // Coordinate live sync permissions with syncRegistry (< 1s revocation)
      if (newRole === "viewer") {
        syncRegistry.setMemberReadOnly(room.id, targetMember.memberId, true, "viewer");
      } else if (room.status !== "ended" && room.status !== "archived") {
        syncRegistry.setMemberReadOnly(room.id, targetMember.memberId, false, newRole);
      }

      await roomRepo.touchActivity(room.id);
      const updatedRoom = await roomRepo.findById(room.id);

      res.json({
        room: toRoomDto(updatedRoom || room),
        member: updatedMember ? toRoomMemberDto(updatedMember) : undefined,
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
    const targetId = getParam(req.params.id);

    try {
      const room = req.room!;
      // Accept only the membership id
      const targetMember = await roomMemberRepo.findMemberByDocId(room.id, targetId);

      if (!targetMember) {
        throw new AppError("Participant not found in this room", 404, "MEMBER_NOT_FOUND");
      }

      assertCanModifyMember(room, targetMember, "remove");

      // Prevent owner self-ban explicitly
      if (targetMember.memberId === req.principal!.id) {
        throw new AppError(
          "Room owner cannot remove or ban themselves",
          400,
          "CANNOT_REMOVE_OWNER"
        );
      }

      // Record permanent ban in canonical room_bans collection before destructive removal (P0-D)
      const targetPrincipalType = targetMember.isGuest ? "guest" : "user";
      await roomBanRepo.banPrincipal(
        room.id,
        { id: targetMember.memberId, type: targetPrincipalType },
        req.principal!.id,
        "kicked_by_owner"
      );

      // Immediately terminate active WebSocket connections for removed member (< 1s revocation)
      syncRegistry.closeConnectionsForMember(
        room.id,
        targetMember.memberId,
        4003,
        "removed"
      );

      // Durable outbox operation for member removal (CH-3 Option A departure notice)
      const io = getSocketServer();
      const opId = outboxService.generateOpId(
        "remove",
        room.id,
        targetMember.id,
        String(Date.now())
      );

      await outboxService.executeDurableOperation({
        opId,
        type: "remove",
        roomId: room.id,
        payload: {
          memberDocId: targetMember.id,
          memberId: targetMember.memberId,
          reason: "removed",
        },
        messageText: `${targetMember.displayName} was removed from the room by the owner`,
        io,
        mutation: async () => {
          return roomMemberRepo.removeMember(room.id, targetMember.id, opId);
        },
      });

      // Disconnect member Socket.IO sockets after broadcast has gone out (< 1s revocation)
      presenceTracker.disconnectMemberSockets(room.id, targetMember.id);

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

      // Ending an archived room returns 409 ROOM_CLOSED (Item 12)
      if (room.status === "archived") {
        throw new AppError(
          "This room is archived and cannot be modified",
          409,
          "ROOM_CLOSED"
        );
      }

      // Idempotent: if already ended, return current ended room DTO
      if (room.status === "ended") {
        res.json({ room: toRoomDto(room) });
        return;
      }

      const io = getSocketServer();
      const opId = outboxService.generateOpId(
        "room_ended",
        room.id,
        "all",
        String(Date.now())
      );

      const { result: endedRoom } =
        await outboxService.executeDurableOperation<IRoom | null>({
          opId,
          type: "room_ended",
          roomId: room.id,
          payload: { status: "ended" },
          messageText: "The room session was ended by the owner",
          io,
          mutation: async () => {
            return roomRepo.updateStatus(room.slug, "ended", opId);
          },
        });

      // Immediately enforce read-only across all active sync connections in the room
      syncRegistry.updateRoomLifecycle(room.id, "ended");

      // Prune retention on ended room if message count exceeds 1,000 (Item 12)
      if (endedRoom?.messageSeq && endedRoom.messageSeq > 1000) {
        await messageRepo.deleteMessagesBeforeSeq(room.id, endedRoom.messageSeq - 1000);
      }

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

      // Durable room deletion (H-1, H-2, M-1)
      const io = getSocketServer();
      await outboxService.executeRoomDeletion({
        roomId: room.id,
        slug: room.slug,
        io,
      });

      await clientMapRepo.deleteByRoom(room.id);
      res.status(204).end();
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

/**
 * PRD 13.1 / CH-1 & CH-2: Get room chat messages (cursor paginated)
 * Pipeline: requirePrincipal -> requireMember (viewers allowed!)
 * Supports ?limit=50 (max 100), ?beforeSeq, ?afterSeq
 */
roomsRouter.get(
  "/:slug/messages",
  requirePrincipal,
  requireMember,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const room = req.room!;
      const parseQuery = ChatHistoryQuerySchema.safeParse(req.query);

      if (!parseQuery.success) {
        throw new AppError(
          parseQuery.error.issues.map((e) => e.message).join(", "),
          400,
          "VALIDATION_ERROR"
        );
      }

      const { limit, beforeSeq, afterSeq } = parseQuery.data;

      const historyResult = await messageRepo.getMessages(room.id, {
        limit,
        beforeSeq,
        afterSeq,
      });

      res.json({
        messages: historyResult.messages.map(toMessageDto),
        hasMore: historyResult.hasMore,
        nextCursor: historyResult.nextCursor,
        oldestSeq: historyResult.oldestSeq,
        newestSeq: historyResult.newestSeq,
      });
    } catch (err) {
      handleRouteError(err, req, res, next);
    }
  }
);

function handleRouteError(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  next(err);
}
