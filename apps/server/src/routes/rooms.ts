import { Router, Request, Response } from "express";
import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  UpdateMemberRoleRequestSchema,
  RoomResponseSchema,
  ApiErrorSchema,
} from "@pairprep/shared";
import { roomService, RoomError } from "../services/roomService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const roomsRouter = Router();
roomsRouter.use(requireAuth);

function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] || "";
  return param || "";
}

/**
 * PRD 13.1 / ROOM-1: Create a new room with unguessable slug
 */
roomsRouter.post("/", (req: Request, res: Response) => {
  const parseResult = CreateRoomRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorPayload = ApiErrorSchema.parse({
      error: "INVALID_REQUEST",
      message: parseResult.error.errors.map((e) => e.message).join(", "),
      requestId: (req.headers["x-request-id"] as string) || undefined,
    });
    res.status(400).json(errorPayload);
    return;
  }

  const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;

  try {
    const { room, ownerMember } = roomService.createRoom(
      parseResult.data,
      req.userId!,
      idempotencyKey
    );

    const responsePayload = RoomResponseSchema.parse({
      room,
      currentMember: ownerMember,
    });
    res.status(201).json(responsePayload);
  } catch (err: unknown) {
    handleError(err, req, res);
  }
});

/**
 * PRD 13.1 / ROOM-2: Retrieve room details by unguessable slug
 */
roomsRouter.get("/:slug", (req: Request, res: Response) => {
  const slug = getParam(req.params.slug);
  const room = roomService.getRoomBySlug(slug);

  if (!room) {
    const errorPayload = ApiErrorSchema.parse({
      error: "ROOM_NOT_FOUND",
      message: `Room with slug '${slug}' not found`,
      requestId: (req.headers["x-request-id"] as string) || undefined,
    });
    res.status(404).json(errorPayload);
    return;
  }

  const currentMember = room.members.find((m) => m.id === req.userId);

  const responsePayload = RoomResponseSchema.parse({
    room,
    currentMember,
  });
  res.json(responsePayload);
});

/**
 * PRD 13.1 / ROOM-2, ROOM-3, ROOM-4 & AUTH-3: Join room as guest or authenticated user
 */
roomsRouter.post("/:slug/join", (req: Request, res: Response) => {
  const slug = getParam(req.params.slug);
  const parseResult = JoinRoomRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    const errorPayload = ApiErrorSchema.parse({
      error: "INVALID_REQUEST",
      message: parseResult.error.errors.map((e) => e.message).join(", "),
      requestId: (req.headers["x-request-id"] as string) || undefined,
    });
    res.status(400).json(errorPayload);
    return;
  }

  try {
    const { room, member } = roomService.joinRoom(
      slug,
      parseResult.data,
      req.userId!,
      req.isGuest
    );

    const responsePayload = RoomResponseSchema.parse({
      room,
      currentMember: member,
    });
    res.json(responsePayload);
  } catch (err: unknown) {
    handleError(err, req, res);
  }
});

/**
 * PRD 13.1 / ROOM-3: Change participant role (owner only)
 */
roomsRouter.patch("/:slug/members/:id", (req: Request, res: Response) => {
  const slug = getParam(req.params.slug);
  const targetMemberId = getParam(req.params.id);
  const parseResult = UpdateMemberRoleRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    const errorPayload = ApiErrorSchema.parse({
      error: "INVALID_REQUEST",
      message: parseResult.error.errors.map((e) => e.message).join(", "),
      requestId: (req.headers["x-request-id"] as string) || undefined,
    });
    res.status(400).json(errorPayload);
    return;
  }

  try {
    const updatedRoom = roomService.updateMemberRole(
      slug,
      targetMemberId,
      parseResult.data.role,
      req.userId!
    );

    res.json({ room: updatedRoom });
  } catch (err: unknown) {
    handleError(err, req, res);
  }
});

/**
 * PRD 13.1 / SEC-7 / ROOM-3: Remove participant from room (owner only)
 */
roomsRouter.delete("/:slug/members/:id", (req: Request, res: Response) => {
  const slug = getParam(req.params.slug);
  const targetMemberId = getParam(req.params.id);

  try {
    const updatedRoom = roomService.removeMember(slug, targetMemberId, req.userId!);

    res.json({ room: updatedRoom });
  } catch (err: unknown) {
    handleError(err, req, res);
  }
});

/**
 * PRD 13.1 / ROOM-6: End session (owner only)
 */
roomsRouter.post("/:slug/end", (req: Request, res: Response) => {
  const slug = getParam(req.params.slug);

  try {
    const endedRoom = roomService.endRoom(slug, req.userId!);
    res.json({ room: endedRoom });
  } catch (err: unknown) {
    handleError(err, req, res);
  }
});

function handleError(err: unknown, req: Request, res: Response): void {
  if (err instanceof RoomError) {
    const errorPayload = ApiErrorSchema.parse({
      error: err.code,
      message: err.message,
      requestId: (req.headers["x-request-id"] as string) || undefined,
    });
    res.status(err.statusCode).json(errorPayload);
    return;
  }

  const errorPayload = ApiErrorSchema.parse({
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
    requestId: (req.headers["x-request-id"] as string) || undefined,
  });
  res.status(500).json(errorPayload);
}
