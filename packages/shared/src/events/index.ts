import { z } from "zod";
import { RoomMemberDtoSchema, MessageDtoSchema } from "../index.js";

/**
 * Standard user role schema for event authorization and payloads.
 */
export const EventUserRoleSchema = z.enum([
  "owner",
  "interviewer",
  "candidate",
  "editor",
  "viewer",
]);

/**
 * Standard room status schema for event lifecycle notifications.
 */
export const EventRoomStatusSchema = z.enum([
  "open",
  "live",
  "ended",
  "archived",
  "deleted",
]);

/**
 * Validates a standard 24-character hexadecimal MongoDB ObjectId.
 */
export const ObjectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid 24-character hexadecimal ObjectId");

/**
 * Standard event error codes for Socket.IO event processing.
 */
export const EventErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  GUEST_EXPIRED: "GUEST_EXPIRED",
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  NOT_ROOM_MEMBER: "NOT_ROOM_MEMBER",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",
  ROOM_CLOSED: "ROOM_CLOSED",
  ROOM_DELETED: "ROOM_DELETED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export const EventErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "ACCOUNT_DISABLED",
  "GUEST_EXPIRED",
  "ROOM_NOT_FOUND",
  "NOT_ROOM_MEMBER",
  "INSUFFICIENT_ROLE",
  "ROOM_CLOSED",
  "ROOM_DELETED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export type EventErrorCode = z.infer<typeof EventErrorCodeSchema>;

/**
 * Safe structured event error DTO returned in acknowledgements.
 * Strictly avoids leaking stack traces, database details, or internal identifiers.
 */
export const EventErrorDtoSchema = z
  .object({
    code: EventErrorCodeSchema,
    message: z.string().min(1).max(300),
    retryAfter: z.number().int().nonnegative().optional(),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type EventErrorDto = z.infer<typeof EventErrorDtoSchema>;

/**
 * Factory for typed successful acknowledgement schemas.
 */
export const createEventSuccessAckSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z
    .object({
      ok: z.literal(true),
      data: dataSchema,
    })
    .strict();

/**
 * Structured error acknowledgement schema.
 */
export const EventErrorAckSchema = z
  .object({
    ok: z.literal(false),
    error: EventErrorDtoSchema,
  })
  .strict();

export type EventErrorAck = z.infer<typeof EventErrorAckSchema>;

/**
 * Unified acknowledgement type for all client-to-server events.
 */
export type EventAck<T = unknown> =
  { ok: true; data: T } | { ok: false; error: EventErrorDto };

/**
 * Canonical Inbound Client Event Names.
 */
export const ClientEventName = {
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",
  CHAT_SEND: "chat:send",
  CHAT_DELIVERED: "chat:delivered",
  CHAT_READ: "chat:read",
  CHAT_READ_BATCH: "chat:read_batch",
} as const;

export type ClientEventName = (typeof ClientEventName)[keyof typeof ClientEventName];

/**
 * Canonical Outbound Server Event Names.
 */
export const ServerEventName = {
  ROOM_MEMBER_JOINED: "room:member_joined",
  ROOM_MEMBER_LEFT: "room:member_left",
  ROOM_ROLE_CHANGED: "room:role_changed",
  ROOM_STATUS_CHANGED: "room:status_changed",
  ROOM_DELETED: "room:deleted",
  CHAT_MESSAGE: "chat:message",
  CHAT_DELIVERED: "chat:delivered",
  CHAT_READ: "chat:read",
  CHAT_READ_BATCH: "chat:read_batch",
  PRESENCE_SNAPSHOT: "presence:snapshot",
  PRESENCE_STATUS: "presence:status",
  ERROR: "room:error",
} as const;

export type ServerEventName = (typeof ServerEventName)[keyof typeof ServerEventName];

// ============================================================================
// Inbound Event Payloads & Acknowledgement Schemas
// ============================================================================

/**
 * Inbound: room:join payload
 * Active in Phase 1: Client joins the room events channel.
 */
export const RoomJoinPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
  })
  .strict();

export type RoomJoinPayload = z.infer<typeof RoomJoinPayloadSchema>;

export const RoomJoinAckDataSchema = z
  .object({
    roomId: ObjectIdSchema,
    role: EventUserRoleSchema,
    status: EventRoomStatusSchema,
  })
  .strict();

export type RoomJoinAckData = z.infer<typeof RoomJoinAckDataSchema>;
export const RoomJoinAckSchema = createEventSuccessAckSchema(RoomJoinAckDataSchema);
export type RoomJoinAck = EventAck<RoomJoinAckData>;

/**
 * Inbound: room:leave payload
 * Defined for protocol completeness; departure semantics defer voluntary leave per CH-3 Option A.
 */
export const RoomLeavePayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
  })
  .strict();

export type RoomLeavePayload = z.infer<typeof RoomLeavePayloadSchema>;

export const RoomLeaveAckDataSchema = z
  .object({
    roomId: ObjectIdSchema,
    left: z.literal(true),
  })
  .strict();

export type RoomLeaveAckData = z.infer<typeof RoomLeaveAckDataSchema>;
export const RoomLeaveAckSchema = createEventSuccessAckSchema(RoomLeaveAckDataSchema);
export type RoomLeaveAck = EventAck<RoomLeaveAckData>;

/**
 * Inbound: chat:send payload
 * Protocol defined in Phase 1; message persistence active in Phase 2.
 */
export const ChatSendPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    text: z
      .string()
      .trim()
      .min(1, "Message cannot be empty")
      .max(1000, "Message cannot exceed 1,000 characters"),
    clientMsgId: z.string().min(1).max(64),
  })
  .strict();

export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>;

export const ChatSendAckDataSchema = z
  .object({
    messageId: ObjectIdSchema,
    seq: z.number().int().nonnegative(),
    ts: z.string().datetime(),
  })
  .strict();

export type ChatSendAckData = z.infer<typeof ChatSendAckDataSchema>;
export const ChatSendAckSchema = createEventSuccessAckSchema(ChatSendAckDataSchema);
export type ChatSendAck = EventAck<ChatSendAckData>;

/**
 * Inbound: chat:delivered payload
 * Recipient client acknowledges receipt of a specific message.
 */
export const ChatDeliveredPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    messageId: ObjectIdSchema,
    seq: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChatDeliveredPayload = z.infer<typeof ChatDeliveredPayloadSchema>;

export const ChatDeliveredAckDataSchema = z
  .object({
    messageId: ObjectIdSchema,
    delivered: z.literal(true),
  })
  .strict();

export type ChatDeliveredAckData = z.infer<typeof ChatDeliveredAckDataSchema>;
export const ChatDeliveredAckSchema = createEventSuccessAckSchema(
  ChatDeliveredAckDataSchema
);
export type ChatDeliveredAck = EventAck<ChatDeliveredAckData>;

/**
 * Inbound: chat:read payload
 * Recipient client acknowledges having viewed/read a specific message.
 */
export const ChatReadPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    messageId: ObjectIdSchema,
    seq: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChatReadPayload = z.infer<typeof ChatReadPayloadSchema>;

export const ChatReadAckDataSchema = z
  .object({
    messageId: ObjectIdSchema,
    read: z.literal(true),
  })
  .strict();

export type ChatReadAckData = z.infer<typeof ChatReadAckDataSchema>;
export const ChatReadAckSchema = createEventSuccessAckSchema(ChatReadAckDataSchema);
export type ChatReadAck = EventAck<ChatReadAckData>;

/**
 * Inbound: chat:read_batch payload
 * Recipient client acknowledges having viewed/read up to 50 messages in a single batch.
 */
export const ChatReadBatchPayloadSchema = z
  .object({
    roomId: ObjectIdSchema.optional(),
    messageIds: z
      .array(ObjectIdSchema)
      .min(1, "Batch must contain at least 1 message ID")
      .max(50, "Batch cannot exceed 50 message IDs"),
  })
  .strict();

export type ChatReadBatchPayload = z.infer<typeof ChatReadBatchPayloadSchema>;

export const ChatReadBatchAckDataSchema = z
  .object({
    messageIds: z.array(ObjectIdSchema),
    readCount: z.number().int().nonnegative(),
  })
  .strict();

export type ChatReadBatchAckData = z.infer<typeof ChatReadBatchAckDataSchema>;
export const ChatReadBatchAckSchema = createEventSuccessAckSchema(
  ChatReadBatchAckDataSchema
);
export type ChatReadBatchAck = EventAck<ChatReadBatchAckData>;

/**
 * Outbound: chat:read_batch broadcast payload
 */
export const ChatReadBatchBroadcastPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    messageIds: z.array(ObjectIdSchema),
    memberId: z.string().min(1),
    readAt: z.string().datetime(),
  })
  .strict();

export type ChatReadBatchBroadcastPayload = z.infer<
  typeof ChatReadBatchBroadcastPayloadSchema
>;

/**
 * Outbound: chat:delivered broadcast payload
 */
export const ChatDeliveredBroadcastPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    messageId: ObjectIdSchema,
    seq: z.number().int().nonnegative().optional(),
    memberId: z.string().min(1),
    deliveredAt: z.string().datetime(),
  })
  .strict();

export type ChatDeliveredBroadcastPayload = z.infer<
  typeof ChatDeliveredBroadcastPayloadSchema
>;

/**
 * Outbound: chat:read broadcast payload
 */
export const ChatReadBroadcastPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    messageId: ObjectIdSchema,
    seq: z.number().int().nonnegative().optional(),
    memberId: z.string().min(1),
    readAt: z.string().datetime(),
  })
  .strict();

export type ChatReadBroadcastPayload = z.infer<typeof ChatReadBroadcastPayloadSchema>;

// ============================================================================
// Outbound Server Event Payloads
// ============================================================================

export const RoomMemberJoinedPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    member: z.lazy(() => RoomMemberDtoSchema),
  })
  .strict();

export type RoomMemberJoinedPayload = z.infer<typeof RoomMemberJoinedPayloadSchema>;

export const RoomMemberLeftPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    memberId: z.string().min(1).max(64),
    reason: z.enum(["removed", "left", "disconnected"]).optional(),
  })
  .strict();

export type RoomMemberLeftPayload = z.infer<typeof RoomMemberLeftPayloadSchema>;

export const RoomRoleChangedPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    memberId: z.string().min(1).max(64),
    role: EventUserRoleSchema,
  })
  .strict();

export type RoomRoleChangedPayload = z.infer<typeof RoomRoleChangedPayloadSchema>;

export const RoomStatusChangedPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    status: EventRoomStatusSchema,
  })
  .strict();

export type RoomStatusChangedPayload = z.infer<typeof RoomStatusChangedPayloadSchema>;

export const RoomDeletedPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
  })
  .strict();

export type RoomDeletedPayload = z.infer<typeof RoomDeletedPayloadSchema>;

export const ChatMessagePayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    message: z.lazy(() => MessageDtoSchema),
  })
  .strict();

export type ChatMessagePayload = z.infer<typeof ChatMessagePayloadSchema>;

// ============================================================================
// Presence & History Payloads (T09 Phase 2)
// ============================================================================

export const PresenceMemberDtoSchema = z
  .object({
    memberId: z.string().min(1),
    memberDocId: z.string().optional(),
    displayName: z.string().min(1),
    role: EventUserRoleSchema,
    color: z.string().optional(),
    isOnline: z.boolean(),
  })
  .strict();

export type PresenceMemberDto = z.infer<typeof PresenceMemberDtoSchema>;

export const PresenceSnapshotPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    members: z.array(PresenceMemberDtoSchema),
  })
  .strict();

export type PresenceSnapshotPayload = z.infer<typeof PresenceSnapshotPayloadSchema>;

export const PresenceStatusPayloadSchema = z
  .object({
    roomId: ObjectIdSchema,
    memberId: z.string().min(1),
    memberDocId: z.string().optional(),
    isOnline: z.boolean(),
  })
  .strict();

export type PresenceStatusPayload = z.infer<typeof PresenceStatusPayloadSchema>;

export const ChatHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    beforeSeq: z.coerce.number().int().nonnegative().optional(),
    afterSeq: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

export const ChatHistoryResponseSchema = z
  .object({
    messages: z.lazy(() => z.array(MessageDtoSchema)),
    nextCursor: z.number().int().nonnegative().optional(),
    hasMore: z.boolean(),
    oldestSeq: z.number().int().nonnegative().optional(),
    newestSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

/**
 * Sanitizes chat text according to Phase 2 security and Unicode control rules:
 * - Normalizes to NFC
 * - Strips Byte Order Mark (BOM \uFEFF)
 * - Strips bidi overrides and embeddings ([\u202A-\u202E\u2066-\u2069])
 * - Strips C0 controls (except \t (0x09), \n (0x0A), \r (0x0D)) and C1 controls (0x80-0x9F) and DEL (0x7F)
 * - Preserves Zero-Width Joiner (\u200D) and Variation Selector 16 (\uFE0F) for emojis
 * - Trims whitespace
 */
export function sanitizeChatText(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  const normalized = raw.normalize("NFC");
  const noBom = normalized.replace(/\uFEFF/g, "");
  const noBidi = noBom.replace(/[\u202A-\u202E\u2066-\u2069]/gu, "");
  const noControl = noBidi.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/gu,
    ""
  );
  return noControl.trim();
}
