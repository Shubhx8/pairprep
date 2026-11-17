import type { Socket } from "socket.io";
import {
  ClientEventName,
  EventErrorCode,
  RoomJoinPayloadSchema,
  RoomLeavePayloadSchema,
  ChatSendPayloadSchema,
  ChatDeliveredPayloadSchema,
  ChatReadPayloadSchema,
  ChatReadBatchPayloadSchema,
  toMessageDto,
  sanitizeChatText,
  type RoomJoinPayload,
  type RoomJoinAckData,
  type RoomLeavePayload,
  type RoomLeaveAckData,
  type ChatSendPayload,
  type ChatSendAckData,
  type ChatDeliveredPayload,
  type ChatDeliveredAckData,
  type ChatReadPayload,
  type ChatReadAckData,
  type ChatReadBatchPayload,
  type ChatReadBatchAckData,
} from "@pairprep/shared";
import { registerEventHandler, EventError, type TypedSocket } from "./eventDispatcher.js";
import { resolveHandshakeIp } from "./rateLimiter.js";
import { chatRateLimiter } from "./chatRateLimiter.js";
import { receiptRateLimiter } from "./receiptRateLimiter.js";
import { presenceTracker } from "./presenceTracker.js";
import { roomRepo } from "../repos/roomRepo.js";
import { messageRepo } from "../repos/messageRepo.js";
import { MessageModel } from "../models/messages.js";
import { RoomMemberModel } from "../models/room_members.js";
import { roomMutationBarrier } from "./roomMutationBarrier.js";
import { getSocketServer } from "./socketServer.js";

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
  const io = (getSocketServer() ??
    (
      socket as unknown as {
        server?: {
          to: (ch: string) => { emit: (ev: string, payload: unknown) => boolean };
        };
      }
    ).server) as unknown as
    | {
        to: (ch: string) => { emit: (ev: string, payload: unknown) => boolean };
      }
    | undefined;
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
        emitToRoomIncludeSender(ctx.socket, roomChannel, "presence:status", {
          roomId: ctx.payload.roomId,
          memberId: ctx.member!.memberId,
          memberDocId: String(ctx.member!._id ?? ctx.member!.id),
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
          emitToRoomIncludeSender(ctx.socket, roomChannel, "presence:status", {
            roomId: ctx.payload.roomId,
            memberId: memberInfo.memberId,
            memberDocId: memberInfo.memberDocId,
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
        emitToRoomIncludeSender(ctx.socket, roomChannel, "presence:status", {
          roomId: ctx.payload.roomId,
          memberId: memberInfo.memberId,
          memberDocId: memberInfo.memberDocId,
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

        // Capture eligible recipients at message creation time (Phase 3 & Phase 4)
        // Active room members at this instant excluding the sender, tombstoned members, and expired guests
        const now = new Date();
        const activeRecipients = await RoomMemberModel.find({
          roomId: ctx.payload.roomId,
          memberId: { $ne: ctx.member!.memberId },
          tombstoneOpId: { $exists: false },
          $or: [
            { guestExpiresAt: { $exists: false } },
            { guestExpiresAt: null },
            { guestExpiresAt: { $gt: now } },
          ],
        })
          .select("memberId")
          .exec();
        const recipientIds = Array.from(
          new Set(activeRecipients.map((m) => m.memberId).filter(Boolean))
        );

        // Message Persistence (with partial unique idempotency on clientMsgId)
        const message = await messageRepo.createMessage({
          roomId: ctx.payload.roomId,
          seq,
          authorId: ctx.member!.memberId,
          authorName: ctx.member!.displayName,
          clientMsgId: ctx.payload.clientMsgId,
          text: sanitizedText,
          kind: "user",
          recipientIds,
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

  // 4. chat:delivered — Acknowledge message delivery by recipient
  registerEventHandler<ChatDeliveredPayload, ChatDeliveredAckData>(socket, {
    name: ClientEventName.CHAT_DELIVERED,
    schema: ChatDeliveredPayloadSchema,
    requireAuth: true,
    requireRoomAuth: true,
    allowedRoles: ["owner", "editor", "viewer", "interviewer", "candidate"],
    handler: async (ctx) => {
      // Enforce AC-16 Token Bucket Rate Limiting (cost: 1 token)
      const rateLimitRes = receiptRateLimiter.consume(
        ctx.principal.id,
        ctx.socket.id,
        "delivered"
      );
      if (!rateLimitRes.allowed) {
        throw new EventError(
          EventErrorCode.RATE_LIMITED,
          "Too many receipt events. Please slow down.",
          rateLimitRes.retryAfter
        );
      }

      // Authoritative room context from connection with payload fallback
      const roomId = ctx.member?.roomId || ctx.payload.roomId;
      const roomChannel = `room:${roomId}`;
      const message = await MessageModel.findOne({
        _id: ctx.payload.messageId,
        roomId,
      }).exec();

      if (!message) {
        throw new EventError(
          EventErrorCode.BAD_REQUEST,
          "Message not found in this room"
        );
      }

      // Sender cannot deliver their own message (Phase 4 / Phase 7 Scenario 14)
      if (message.authorId === ctx.member!.memberId) {
        throw new EventError(
          EventErrorCode.FORBIDDEN,
          "Sender cannot acknowledge delivery of their own message"
        );
      }

      // Non-eligible participants (e.g. joined after message was sent or subsequently excluded) cannot acknowledge
      const isEligible =
        (!message.recipientIds ||
          message.recipientIds.length === 0 ||
          message.recipientIds.includes(ctx.member!.memberId)) &&
        (!message.excludedRecipientIds ||
          !message.excludedRecipientIds.includes(ctx.member!.memberId));

      if (!isEligible) {
        throw new EventError(
          EventErrorCode.FORBIDDEN,
          "User is not an eligible recipient for this message"
        );
      }

      await messageRepo.markDelivered(
        roomId,
        ctx.payload.messageId,
        ctx.member!.memberId
      );

      emitToRoomIncludeSender(ctx.socket, roomChannel, "chat:delivered", {
        roomId,
        messageId: ctx.payload.messageId,
        seq: message.seq,
        memberId: ctx.member!.memberId,
        deliveredAt: new Date().toISOString(),
      });

      return {
        messageId: ctx.payload.messageId,
        delivered: true,
      };
    },
  });

  // 5. chat:read — Acknowledge message read/viewed by recipient
  registerEventHandler<ChatReadPayload, ChatReadAckData>(socket, {
    name: ClientEventName.CHAT_READ,
    schema: ChatReadPayloadSchema,
    requireAuth: true,
    requireRoomAuth: true,
    allowedRoles: ["owner", "editor", "viewer", "interviewer", "candidate"],
    handler: async (ctx) => {
      // Enforce AC-16 Token Bucket Rate Limiting (cost: 1 token)
      const rateLimitRes = receiptRateLimiter.consume(
        ctx.principal.id,
        ctx.socket.id,
        "read"
      );
      if (!rateLimitRes.allowed) {
        throw new EventError(
          EventErrorCode.RATE_LIMITED,
          "Too many receipt events. Please slow down.",
          rateLimitRes.retryAfter
        );
      }

      // Authoritative room context from connection with payload fallback
      const roomId = ctx.member?.roomId || ctx.payload.roomId;
      const roomChannel = `room:${roomId}`;
      const message = await MessageModel.findOne({
        _id: ctx.payload.messageId,
        roomId,
      }).exec();

      if (!message) {
        throw new EventError(
          EventErrorCode.BAD_REQUEST,
          "Message not found in this room"
        );
      }

      // Sender cannot read their own message (Phase 4 / Phase 7 Scenario 14)
      if (message.authorId === ctx.member!.memberId) {
        throw new EventError(
          EventErrorCode.FORBIDDEN,
          "Sender cannot acknowledge read of their own message"
        );
      }

      // Non-eligible participants (e.g. joined after message was sent or subsequently excluded) cannot acknowledge
      const isEligible =
        (!message.recipientIds ||
          message.recipientIds.length === 0 ||
          message.recipientIds.includes(ctx.member!.memberId)) &&
        (!message.excludedRecipientIds ||
          !message.excludedRecipientIds.includes(ctx.member!.memberId));

      if (!isEligible) {
        throw new EventError(
          EventErrorCode.FORBIDDEN,
          "User is not an eligible recipient for this message"
        );
      }

      await messageRepo.markRead(roomId, ctx.payload.messageId, ctx.member!.memberId);

      emitToRoomIncludeSender(ctx.socket, roomChannel, "chat:read", {
        roomId,
        messageId: ctx.payload.messageId,
        seq: message.seq,
        memberId: ctx.member!.memberId,
        readAt: new Date().toISOString(),
      });

      return {
        messageId: ctx.payload.messageId,
        read: true,
      };
    },
  });

  // 6. chat:read_batch — Acknowledge multiple messages read/viewed in a single batch (Phase 4 / AC-14)
  registerEventHandler<ChatReadBatchPayload, ChatReadBatchAckData>(socket, {
    name: ClientEventName.CHAT_READ_BATCH,
    schema: ChatReadBatchPayloadSchema,
    requireAuth: true,
    requireRoomAuth: true,
    allowedRoles: ["owner", "editor", "viewer", "interviewer", "candidate"],
    handler: async (ctx) => {
      const roomId = ctx.member?.roomId || ctx.payload.roomId;
      if (!roomId) {
        throw new EventError(EventErrorCode.BAD_REQUEST, "Room ID is required");
      }
      const roomChannel = `room:${roomId}`;
      const rawIds = ctx.payload.messageIds;

      if (!rawIds || rawIds.length === 0) {
        throw new EventError(
          EventErrorCode.BAD_REQUEST,
          "Batch must contain at least 1 message ID"
        );
      }

      if (rawIds.length > 50) {
        throw new EventError(
          EventErrorCode.BAD_REQUEST,
          "Read receipt batch exceeds maximum limit of 50 messages"
        );
      }

      const uniqueIds = Array.from(new Set(rawIds));

      // Enforce AC-16 Token Bucket Rate Limiting (cost: 2 + floor(N/10) tokens)
      const rateLimitRes = receiptRateLimiter.consume(
        ctx.principal.id,
        ctx.socket.id,
        "read_batch",
        uniqueIds.length
      );
      if (!rateLimitRes.allowed) {
        throw new EventError(
          EventErrorCode.RATE_LIMITED,
          "Too many receipt events. Please slow down.",
          rateLimitRes.retryAfter
        );
      }

      const { updatedIds } = await messageRepo.markReadBatch(
        roomId,
        uniqueIds,
        ctx.member!.memberId
      );

      if (updatedIds.length > 0) {
        emitToRoomIncludeSender(ctx.socket, roomChannel, "chat:read_batch", {
          roomId,
          messageIds: updatedIds,
          memberId: ctx.member!.memberId,
          readAt: new Date().toISOString(),
        });
      }

      return {
        messageIds: updatedIds,
        readCount: updatedIds.length,
      };
    },
  });
}
