import type { Socket } from "socket.io";
import {
  ClientEventName,
  EventErrorCode,
  RoomJoinPayloadSchema,
  RoomLeavePayloadSchema,
  ChatSendPayloadSchema,
  toMessageDto,
  sanitizeChatText,
  type RoomJoinPayload,
  type RoomJoinAckData,
  type RoomLeavePayload,
  type RoomLeaveAckData,
  type ChatSendPayload,
  type ChatSendAckData,
} from "@pairprep/shared";
import { registerEventHandler, EventError, type TypedSocket } from "./eventDispatcher.js";
import { resolveHandshakeIp } from "./rateLimiter.js";
import { chatRateLimiter } from "./chatRateLimiter.js";
import { presenceTracker } from "./presenceTracker.js";
import { roomRepo } from "../repos/roomRepo.js";
import { messageRepo } from "../repos/messageRepo.js";
import { roomMutationBarrier } from "./roomMutationBarrier.js";

function emitToRoom(
  socket: TypedSocket,
  roomChannel: string,
  event: string,
  data: unknown
): void {
  (
    socket as unknown as {
      to: (ch: string) => { emit: (ev: string, payload: unknown) => boolean };
    }
  )
    .to(roomChannel)
    .emit(event, data);
}

function emitToRoomIncludeSender(
  socket: TypedSocket,
  roomChannel: string,
  event: string,
  data: unknown
): void {
  const io = (
    socket as unknown as {
      server?: {
        to: (ch: string) => { emit: (ev: string, payload: unknown) => boolean };
      };
    }
  ).server;
  if (io) {
    io.to(roomChannel).emit(event, data);
  } else {
    emitDirect(socket, event, data);
    emitToRoom(socket, roomChannel, event, data);
  }
}

function emitDirect(socket: TypedSocket, event: string, data: unknown): void {
  (
    socket as unknown as {
      emit: (ev: string, payload: unknown) => boolean;
    }
  ).emit(event, data);
}

/**
 * Attaches canonical Room Event handlers to an authenticated Socket.IO connection.
 * Covers:
 * 1. room:join — Join transport channel, register presence, emit presence:snapshot and online status.
 * 2. room:leave — Leave transport channel, unregister presence, emit offline status if last socket.
 * 3. chat:send — Authoritative persistent chat with sequence allocation, AD-7 rate limiting,
 *    and real-time room broadcast.
 */
export function attachRoomEventHandlers(socket: TypedSocket): void {
  // 1. room:join — Join room events channel
  registerEventHandler<RoomJoinPayload, RoomJoinAckData>(socket, {
    name: ClientEventName.ROOM_JOIN,
    schema: RoomJoinPayloadSchema,
    requireAuth: true,
    requireRoomAuth: true,
    requireWritable: false, // Joining is permitted even in ended/read-only rooms
    allowedRoles: ["owner", "editor", "viewer", "interviewer", "candidate"],
    handler: async (ctx) => {
      const roomChannel = `room:${ctx.payload.roomId}`;
      await ctx.socket.join(roomChannel);

      // Register with authoritative in-memory presence registry
      const { transition } = presenceTracker.registerSocket(
        ctx.socket as unknown as Socket,
        ctx.payload.roomId,
        ctx.member!
      );

      // Multi-tab debouncing: emit online status strictly on 0-to-1 socket transition
      if (transition === "joined") {
        emitToRoom(ctx.socket, roomChannel, "presence:status", {
          roomId: ctx.payload.roomId,
          memberId: ctx.member!.memberId,
          isOnline: true,
        });
      }

      // Initial snapshot delivered directly to the connecting socket
      const onlineMembers = presenceTracker.getOnlineMembers(ctx.payload.roomId);
      emitDirect(ctx.socket, "presence:snapshot", {
        roomId: ctx.payload.roomId,
        members: onlineMembers,
      });

      // Track disconnect once per socket
      ctx.socket.once("disconnect", () => {
        const { isLastSocket, memberInfo } = presenceTracker.unregisterSocket(
          ctx.socket.id
        );
        // Multi-tab debouncing: emit offline status strictly on 1-to-0 socket transition
        if (isLastSocket && memberInfo) {
          emitToRoom(ctx.socket, roomChannel, "presence:status", {
            roomId: ctx.payload.roomId,
            memberId: memberInfo.memberId,
            isOnline: false,
          });
        }
      });

      return {
        roomId: ctx.payload.roomId,
        role: ctx.member!.role,
        status: ctx.room!.status,
      };
    },
  });

  // 2. room:leave — Leave room events channel
  registerEventHandler<RoomLeavePayload, RoomLeaveAckData>(socket, {
    name: ClientEventName.ROOM_LEAVE,
    schema: RoomLeavePayloadSchema,
    requireAuth: true,
    requireRoomAuth: false, // Leaving channel does not require active room state
    handler: async (ctx) => {
      const roomChannel = `room:${ctx.payload.roomId}`;
      await ctx.socket.leave(roomChannel);

      const { isLastSocket, memberInfo } = presenceTracker.unregisterSocket(
        ctx.socket.id
      );
      if (isLastSocket && memberInfo) {
        emitToRoom(ctx.socket, roomChannel, "presence:status", {
          roomId: ctx.payload.roomId,
          memberId: memberInfo.memberId,
          isOnline: false,
        });
      }

      return {
        roomId: ctx.payload.roomId,
        left: true,
      };
    },
  });

  // 3. chat:send — Send message in room chat
  registerEventHandler<ChatSendPayload, ChatSendAckData>(socket, {
    name: ClientEventName.CHAT_SEND,
    schema: ChatSendPayloadSchema,
    requireAuth: true,
    requireRoomAuth: true,
    requireWritable: true, // Ended and archived rooms are read-only and reject chat sends
    allowedRoles: ["owner", "editor", "viewer", "interviewer", "candidate"], // Viewers CAN chat!
    handler: async (ctx) => {
      const roomChannel = `room:${ctx.payload.roomId}`;

      // 1. Enforce AD-7 Rate Limiting: 20 msgs/10s user, 100 msgs/10s IP
      const clientIp = resolveHandshakeIp(ctx.socket.handshake);
      const rateLimitResult = chatRateLimiter.consume(ctx.principal.id, clientIp);
      if (!rateLimitResult.allowed) {
        throw new EventError(
          EventErrorCode.RATE_LIMITED,
          "Too many messages. Please slow down.",
          rateLimitResult.retryAfter
        );
      }

      // 2. Unicode and Control Code Sanitization
      const sanitizedText = sanitizeChatText(ctx.payload.text);
      if (sanitizedText.length === 0) {
        throw new EventError(
          EventErrorCode.VALIDATION_ERROR,
          "Message cannot be empty after trimming"
        );
      }
      if (sanitizedText.length > 1000) {
        throw new EventError(
          EventErrorCode.VALIDATION_ERROR,
          "Message text cannot exceed 1,000 characters"
        );
      }

      // 3. Coordinate persistence under room mutation admission barrier (H-1)
      return await roomMutationBarrier.withAdmission(ctx.payload.roomId, async () => {
        // Monotonic Sequence Allocation via Atomic $inc on Room
        const seq = await roomRepo.allocateMessageSeq(ctx.payload.roomId);

        // Message Persistence (with partial unique idempotency on clientMsgId)
        const message = await messageRepo.createMessage({
          roomId: ctx.payload.roomId,
          seq,
          authorId: ctx.member!.memberId,
          authorName: ctx.member!.displayName,
          clientMsgId: ctx.payload.clientMsgId,
          text: sanitizedText,
          kind: "user",
        });

        // Real-Time Broadcast to Room (including sender for echo-before-ack deduplication)
        emitToRoomIncludeSender(ctx.socket, roomChannel, "chat:message", {
          roomId: ctx.payload.roomId,
          message: toMessageDto(message),
        });

        // Return Typed Acknowledgement
        return {
          messageId: String(message._id),
          seq: message.seq,
          ts: typeof message.ts === "string" ? message.ts : message.ts.toISOString(),
        };
      });
    },
  });
}
