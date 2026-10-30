import { z } from "zod";

/**
 * Basic Ping/Status schema used for initial monorepo wiring validation
 */
export const PingResponseSchema = z.object({
  status: z.literal("ok"),
  message: z.string(),
  timestamp: z.string(),
  environment: z.enum(["development", "production", "test"]),
});

export type PingResponse = z.infer<typeof PingResponseSchema>;

/**
 * PRD 8.4 / OBS-4 & T03: Health endpoint schema
 * Returns status, uptimeSec, version, and database state ("ok" | "down")
 */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  uptimeSec: z.number().nonnegative(),
  version: z.string(),
  db: z.enum(["ok", "down"]).default("ok"),
  uptime: z.number().nonnegative().optional(),
  timestamp: z.string().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * PRD 6.1 / 12: User Roles in system
 */
export const UserRoleTypeSchema = z.enum(["user", "owner-admin"]);
export type UserRoleType = z.infer<typeof UserRoleTypeSchema>;

/**
 * UserPrivateDto: includes email, used ONLY for GET /me (PRD Section 12 & T03 User Review)
 * Contains exactly: id, provider, displayName, avatarUrl, email, role, createdAt.
 */
export const UserPrivateDtoSchema = z
  .object({
    id: z.string(),
    provider: z.enum(["google", "github"]),
    displayName: z.string(),
    avatarUrl: z.string().optional(),
    email: z.string().email().nullable(),
    role: UserRoleTypeSchema,
    createdAt: z.string(),
  })
  .strict();

export type UserPrivateDto = z.infer<typeof UserPrivateDtoSchema>;

/**
 * UserPublicDto: excludes email completely, used everywhere else to prevent accidental email leaks
 */
export const UserPublicDtoSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().optional(),
    role: UserRoleTypeSchema,
    createdAt: z.string(),
  })
  .strict();

export type UserPublicDto = z.infer<typeof UserPublicDtoSchema>;

/**
 * Runtime mapping to ensure private fields (like email, providerId, disabled) are stripped
 * and only the exact private DTO fields are returned. Never serializes a Mongoose doc directly.
 */
export function toUserPrivateDto(user: {
  id?: string;
  _id?: unknown;
  provider: "google" | "github";
  displayName: string;
  avatarUrl?: string;
  email?: string | null;
  role: z.infer<typeof UserRoleTypeSchema>;
  createdAt: string | Date;
}): UserPrivateDto {
  const userId = user.id ? String(user.id) : String(user._id ?? "");
  const dto: Record<string, unknown> = {
    id: userId,
    provider: user.provider,
    displayName: user.displayName,
    email: user.email ?? null,
    role: user.role,
    createdAt:
      typeof user.createdAt === "string" ? user.createdAt : user.createdAt.toISOString(),
  };
  if (user.avatarUrl) {
    dto.avatarUrl = user.avatarUrl;
  }
  return UserPrivateDtoSchema.parse(dto);
}

/**
 * Runtime mapping to ensure private fields (like email) are stripped and never cross network boundaries.
 */
export function toUserPublicDto(user: {
  id?: string;
  _id?: unknown;
  displayName: string;
  avatarUrl?: string;
  role: z.infer<typeof UserRoleTypeSchema>;
  createdAt: string | Date;
}): UserPublicDto {
  const userId = user.id ? String(user.id) : String(user._id ?? "");
  const dto: Record<string, unknown> = {
    id: userId,
    displayName: user.displayName,
    role: user.role,
    createdAt:
      typeof user.createdAt === "string" ? user.createdAt : user.createdAt.toISOString(),
  };
  if (user.avatarUrl) {
    dto.avatarUrl = user.avatarUrl;
  }
  return UserPublicDtoSchema.parse(dto);
}

/**
 * Strips control and formatting characters (\p{Cc}\p{Cf}), applies Unicode NFC normalization, and trims whitespace.
 */
export function sanitizeDisplayName(val: string): string {
  return val
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
}

/**
 * PRD 6.1 AUTH-5 / T04: Display Name update schema
 * Display name 1 to 40 code points after trimming, strip control characters, reject empty, strict mode.
 */
export const UpdateProfileDtoSchema = z
  .object({
    displayName: z
      .string()
      .transform(sanitizeDisplayName)
      .refine((val) => [...val].length >= 1 && [...val].length <= 40, {
        message: "Display name must be between 1 and 40 characters after trimming",
      }),
  })
  .strict();

export type UpdateProfileDto = z.infer<typeof UpdateProfileDtoSchema>;

/**
 * PRD 6.2 / 12: Supported Room Member Roles
 */
export const UserRoleSchema = z.enum([
  "owner",
  "interviewer",
  "candidate",
  "editor",
  "viewer",
]);

export type UserRole = z.infer<typeof UserRoleSchema>;

/**
 * PRD 6.4: Supported Execution Languages
 */
export const SupportedLanguageSchema = z.enum(["python", "cpp", "javascript"]);

export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

/**
 * PRD 6.2 / 12: Room Type and Lifecycle Status
 */
export const RoomTypeSchema = z.enum(["practice", "interview"]);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const RoomStatusSchema = z.enum(["open", "live", "ended", "archived"]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

/**
 * PRD 6.7 / 7.6: Color-blind-safe palette for participants and cursors (max 6)
 * Note: Colors are ephemeral UI/awareness state in Yjs, not persisted in the database model.
 */
export const PARTICIPANT_PALETTE = [
  "#3B82F6", // Blue
  "#10B981", // Emerald
  "#F59E0B", // Amber
  "#8B5CF6", // Purple
  "#EC4899", // Pink
  "#14B8A6", // Teal
] as const;

/**
 * PRD 6.2 / 12: Room Member Schema (UI representation)
 */
export const RoomMemberSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(40),
  role: UserRoleSchema,
  color: z.string().optional(), // Ephemeral presentation only; not in DB model
  isGuest: z.boolean(),
  joinedAt: z.string(),
  lastSeenAt: z.string().optional(),
});

export type RoomMember = z.infer<typeof RoomMemberSchema>;

/**
 * Database / API DTO for Room Member (strictly excludes color per T03)
 */
export const RoomMemberDtoSchema = z.object({
  roomId: z.string(),
  memberId: z.string(),
  displayName: z.string(),
  role: UserRoleSchema,
  isGuest: z.boolean(),
  joinedAt: z.string(),
  lastSeenAt: z.string().optional(),
});

export type RoomMemberDto = z.infer<typeof RoomMemberDtoSchema>;

/**
 * PRD 6.2 / 12: Full Room Model Schema
 */
export const RoomSchema = z.object({
  id: z.string(),
  slug: z.string().min(16), // At least 128-bit unguessable slug (PRD ROOM-1)
  title: z.string().min(1).max(100),
  type: RoomTypeSchema,
  language: SupportedLanguageSchema,
  status: RoomStatusSchema,
  ownerId: z.string(),
  timeLimitSec: z.number().min(300).max(7200).optional(),
  members: z.array(RoomMemberSchema).max(6), // PRD ROOM-4: max 6 participants
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export type Room = z.infer<typeof RoomSchema>;

/**
 * PRD 12: Guest DTO Schema (auto-expires after 7 days)
 */
export const GuestDtoSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(40),
  roomId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type GuestDto = z.infer<typeof GuestDtoSchema>;

/**
 * PRD 12: Document Update DTO Schema (append-only log)
 */
export const DocUpdateDtoSchema = z.object({
  roomId: z.string(),
  seq: z.number().int().nonnegative(),
  authorId: z.string(),
  ts: z.string(),
  size: z.number().int().nonnegative(),
});

export type DocUpdateDto = z.infer<typeof DocUpdateDtoSchema>;

/**
 * PRD 12: Document Snapshot DTO Schema
 */
export const DocSnapshotDtoSchema = z.object({
  roomId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  text: z.string(),
});

export type DocSnapshotDto = z.infer<typeof DocSnapshotDtoSchema>;

/**
 * PRD 12: Room Message DTO Schema (max 1000 characters)
 */
export const MessageDtoSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  authorId: z.string(),
  text: z.string().max(1000),
  ts: z.string(),
  kind: z.enum(["user", "system"]),
});

export type MessageDto = z.infer<typeof MessageDtoSchema>;

/**
 * PRD 12: Client Map DTO Schema (Yjs clientId mapping)
 */
export const ClientMapDtoSchema = z.object({
  roomId: z.string(),
  clientId: z.number().int(),
  actorId: z.string(),
  connectedAt: z.string(),
});

export type ClientMapDto = z.infer<typeof ClientMapDtoSchema>;

/**
 * PRD 12: Event Log DTO Schema
 */
export const EventDtoSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  userId: z.string(),
  type: z.string(),
  payload: z.record(z.unknown()).optional(),
  ts: z.string(),
});

export type EventDto = z.infer<typeof EventDtoSchema>;

/**
 * PRD 6.6 / 12 & AD-3: Idempotency Key DTO Schema
 */
export const IdempotencyDtoSchema = z.object({
  key: z.string(),
  actorId: z.string(),
  route: z.string(),
  createdAt: z.string(),
});

export type IdempotencyDto = z.infer<typeof IdempotencyDtoSchema>;

/**
 * Strips control and formatting characters (\p{Cc}\p{Cf}), applies Unicode NFC normalization, and trims whitespace.
 */
export function sanitizeTitle(val: string): string {
  return val
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
}

/**
 * PRD 13.1: API Request & Response Schemas
 */
export const CreateRoomRequestSchema = z.object({
  title: z
    .string()
    .transform(sanitizeTitle)
    .refine((val) => val.length >= 1 && val.length <= 100, {
      message: "Title must be between 1 and 100 characters after trimming",
    }),
  type: z.literal("practice").default("practice"),
  language: SupportedLanguageSchema.default("python"),
  timeLimitSec: z.number().min(300).max(7200).optional(),
  ownerName: z.string().trim().min(1).max(40).default("Anonymous Host"),
});

export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const JoinRoomRequestSchema = z.object({
  displayName: z
    .string()
    .transform(sanitizeDisplayName)
    .refine((val) => [...val].length >= 1 && [...val].length <= 40, {
      message: "Display name must be between 1 and 40 characters after trimming",
    }),
  role: z.enum(["editor", "viewer"]).optional(),
});

export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(["editor", "viewer"]),
});

export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

export const RoomMemberDetailDtoSchema = z
  .object({
    id: z.string(), // membership document _id
    displayName: z.string(),
    role: UserRoleSchema,
    isGuest: z.boolean(),
    joinedAt: z.string(),
    lastSeenAt: z.string().optional(),
  })
  .strict();

export type RoomMemberDetailDto = z.infer<typeof RoomMemberDetailDtoSchema>;

export const RoomDtoSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    type: RoomTypeSchema,
    language: SupportedLanguageSchema,
    status: RoomStatusSchema,
    ownerId: z.string(),
    timeLimitSec: z.number().optional(),
    memberCount: z.number().int().min(1).max(6),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    lastActivityAt: z.string().optional(),
  })
  .strict();

export type RoomDto = z.infer<typeof RoomDtoSchema>;

export const PublicRoomDtoSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    type: RoomTypeSchema,
    language: SupportedLanguageSchema,
    status: RoomStatusSchema,
    memberCount: z.number().int().min(1).max(6),
    createdAt: z.string(),
  })
  .strict();

export type PublicRoomDto = z.infer<typeof PublicRoomDtoSchema>;

export const RoomResponseSchema = z.object({
  room: RoomDtoSchema,
  currentMember: RoomMemberDetailDtoSchema.optional(),
  members: z.array(RoomMemberDetailDtoSchema).max(6).optional(),
});

export type RoomResponse = z.infer<typeof RoomResponseSchema>;

export const RoomCursorSchema = z
  .string()
  .max(200)
  .refine(
    (val) => {
      try {
        const jsonStr = Buffer.from(val, "base64url").toString("utf-8");
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        return (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed["id"] === "string" &&
          typeof parsed["joinedAt"] === "string" &&
          !isNaN(Date.parse(parsed["joinedAt"] as string))
        );
      } catch {
        return false;
      }
    },
    { message: "Invalid pagination cursor" }
  );

export const RoomListQuerySchema = z.object({
  cursor: RoomCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type RoomListQuery = z.infer<typeof RoomListQuerySchema>;

export const RoomListResponseSchema = z.object({
  rooms: z.array(RoomDtoSchema).max(50),
  nextCursor: z.string().optional(),
});

export type RoomListResponse = z.infer<typeof RoomListResponseSchema>;

/**
 * Standard unified API error format:
 * { "error": { "code": "STABLE_CODE", "message": "...", "requestId": "..." } }
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    fields: z.record(z.string()).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = ApiErrorSchema;
export type ApiErrorResponse = ApiError;

export function toRoomDto(room: {
  _id?: unknown;
  id?: string;
  slug: string;
  title: string;
  type: "practice" | "interview";
  language: "python" | "cpp" | "javascript";
  status: "open" | "live" | "ended" | "archived";
  ownerId: string;
  timeLimitSec?: number;
  memberCount?: number;
  createdAt: string | Date;
  startedAt?: string | Date;
  endedAt?: string | Date;
  lastActivityAt?: string | Date;
}): RoomDto {
  const roomId = room.id ? String(room.id) : String(room._id ?? "");
  const dto: Record<string, unknown> = {
    id: roomId,
    slug: room.slug,
    title: room.title,
    type: room.type,
    language: room.language,
    status: room.status,
    ownerId: room.ownerId,
    memberCount: room.memberCount ?? 1,
    createdAt:
      typeof room.createdAt === "string" ? room.createdAt : room.createdAt.toISOString(),
  };

  if (room.timeLimitSec !== undefined) dto["timeLimitSec"] = room.timeLimitSec;
  if (room.startedAt) {
    dto["startedAt"] =
      typeof room.startedAt === "string" ? room.startedAt : room.startedAt.toISOString();
  }
  if (room.endedAt) {
    dto["endedAt"] =
      typeof room.endedAt === "string" ? room.endedAt : room.endedAt.toISOString();
  }
  if (room.lastActivityAt) {
    dto["lastActivityAt"] =
      typeof room.lastActivityAt === "string"
        ? room.lastActivityAt
        : room.lastActivityAt.toISOString();
  }

  return RoomDtoSchema.parse(dto);
}

export function toPublicRoomDto(room: {
  slug: string;
  title: string;
  type: "practice" | "interview";
  language: "python" | "cpp" | "javascript";
  status: "open" | "live" | "ended" | "archived";
  memberCount?: number;
  createdAt: string | Date;
}): PublicRoomDto {
  return PublicRoomDtoSchema.parse({
    slug: room.slug,
    title: room.title,
    type: room.type,
    language: room.language,
    status: room.status,
    memberCount: room.memberCount ?? 1,
    createdAt:
      typeof room.createdAt === "string" ? room.createdAt : room.createdAt.toISOString(),
  });
}

export function toRoomMemberDto(member: {
  _id?: unknown;
  id?: string;
  displayName: string;
  role: "owner" | "interviewer" | "candidate" | "editor" | "viewer";
  isGuest: boolean;
  joinedAt: string | Date;
  lastSeenAt?: string | Date;
}): RoomMemberDetailDto {
  const memberDocId = member._id ? String(member._id) : String(member.id ?? "");
  const dto: Record<string, unknown> = {
    id: memberDocId,
    displayName: member.displayName,
    role: member.role,
    isGuest: member.isGuest,
    joinedAt:
      typeof member.joinedAt === "string"
        ? member.joinedAt
        : member.joinedAt.toISOString(),
  };

  if (member.lastSeenAt) {
    dto["lastSeenAt"] =
      typeof member.lastSeenAt === "string"
        ? member.lastSeenAt
        : member.lastSeenAt.toISOString();
  }

  return RoomMemberDetailDtoSchema.parse(dto);
}
