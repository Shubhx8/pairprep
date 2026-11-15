import type { Socket } from "socket.io";
import { z } from "zod";
import type { Principal } from "../middleware/identity.js";
import {
  type UserRole,
  type EventAck,
  type EventErrorCode,
  EventErrorCode as ErrorCodes,
} from "@pairprep/shared";
import type { IRoom } from "../models/rooms.js";
import type { IRoomMember } from "../models/room_members.js";
import type { SocketData } from "./socketServer.js";
import { authorizeRoomEvent } from "./authorization.js";
import { rootLogger } from "../middleware/logger.js";

export type TypedSocket = Socket<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  SocketData
>;

export interface EventContext<TPayload> {
  socket: TypedSocket;
  principal: Principal;
  payload: TPayload;
  room?: IRoom;
  member?: IRoomMember;
}

export interface AckCallback<TData = unknown> {
  (ack: EventAck<TData>): void;
}

export class EventError extends Error {
  constructor(
    public readonly code: EventErrorCode,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "EventError";
  }
}

export interface EventDefinition<TPayload, TResult> {
  name: string;
  schema: z.ZodType<TPayload>;
  requireAuth?: boolean;
  requireRoomAuth?: boolean;
  roomIdExtractor?: (payload: TPayload) => string;
  allowedRoles?: UserRole[];
  requireWritable?: boolean;
  handler: (ctx: EventContext<TPayload>) => Promise<TResult> | TResult;
}

/**
 * Registers a strongly-typed, schema-validated, authoritatively checked event handler.
 *
 * Strict execution order:
 * 1. Validate inbound payload against strict Zod schema (rejects unknown fields/types).
 * 2. Verify principal authentication on socket state.
 * 3. Revalidate authoritative room existence, membership, role, and lifecycle in MongoDB.
 * 4. Execute business handler only after all checks pass.
 * 5. Return consistent structured acknowledgement or safe error (no internal leaks).
 */
export function registerEventHandler<TPayload, TResult>(
  socket: TypedSocket,
  definition: EventDefinition<TPayload, TResult>
): void {
  socket.on(definition.name, async (rawPayload: unknown, maybeAck?: unknown) => {
    const ack =
      typeof maybeAck === "function" ? (maybeAck as AckCallback<TResult>) : undefined;

    const sendError = (
      code: EventErrorCode,
      message: string,
      retryAfter?: number
    ): void => {
      const errorAck: EventAck<TResult> = {
        ok: false,
        error: {
          code,
          message,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        },
      };
      if (ack) {
        ack(errorAck);
      } else {
        (
          socket as unknown as {
            emit: (ev: string, data: unknown) => boolean;
          }
        ).emit("room:error", errorAck.error);
      }
    };

    // 1. Schema Validation (rejects unknown fields, invalid types, oversized values)
    const parsed = definition.schema.safeParse(rawPayload);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue
        ? `Validation error on ${firstIssue.path.join(".") || "payload"}: ${firstIssue.message}`
        : "Invalid request payload";
      return sendError(ErrorCodes.VALIDATION_ERROR, message);
    }

    const payload = parsed.data;

    // 2. Authentication Check
    const requireAuth = definition.requireAuth ?? true;
    const principal = socket.data.principal;
    if (requireAuth && (!principal || !principal.id)) {
      return sendError(ErrorCodes.UNAUTHENTICATED, "Authentication required");
    }

    // 3. Authoritative Room Membership & Permission Revalidation
    const requireRoomAuth = definition.requireRoomAuth ?? true;
    let room: IRoom | undefined;
    let member: IRoomMember | undefined;

    if (requireRoomAuth) {
      const roomId = definition.roomIdExtractor
        ? definition.roomIdExtractor(payload)
        : (payload as { roomId?: string }).roomId;

      if (!roomId || typeof roomId !== "string") {
        return sendError(ErrorCodes.BAD_REQUEST, "Missing or invalid roomId");
      }

      const authResult = await authorizeRoomEvent({
        principal,
        roomId,
        allowedRoles: definition.allowedRoles,
        requireWritable: definition.requireWritable,
      });

      if (!authResult.authorized) {
        return sendError(authResult.code, authResult.message);
      }

      room = authResult.room;
      member = authResult.member;
    }

    // 4. Business Handler Execution
    try {
      const result = await definition.handler({
        socket,
        principal: principal!,
        payload,
        room,
        member,
      });

      if (ack) {
        ack({ ok: true, data: result });
      }
    } catch (unexpectedError) {
      if (unexpectedError instanceof EventError) {
        return sendError(
          unexpectedError.code,
          unexpectedError.message,
          unexpectedError.retryAfter
        );
      }

      rootLogger.error(
        {
          err: unexpectedError,
          event: definition.name,
          socketId: socket.id,
          principalId: principal?.id,
        },
        "Unhandled exception in Socket.IO event handler"
      );
      return sendError(
        ErrorCodes.INTERNAL_ERROR,
        "An unexpected error occurred while processing your request"
      );
    }
  });
}
