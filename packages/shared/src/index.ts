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
 * PRD 8.4 / OBS-4: Health endpoint schema
 */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  uptime: z.number().nonnegative(),
  timestamp: z.string(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * PRD 6.2 / 12: Supported User Roles in PairPrep rooms
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
 * PRD 6.2 / 12: Room Member Schema
 */
export const RoomMemberSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(32),
  role: UserRoleSchema,
  color: z.string(),
  isGuest: z.boolean(),
  joinedAt: z.string(),
});

export type RoomMember = z.infer<typeof RoomMemberSchema>;

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
 * PRD 13.1: API Request & Response Schemas
 */
export const CreateRoomRequestSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100),
  type: RoomTypeSchema.default("practice"),
  language: SupportedLanguageSchema.default("python"),
  timeLimitSec: z.number().min(300).max(7200).optional(),
  ownerName: z.string().trim().min(1).max(32).default("Anonymous Host"),
});

export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const JoinRoomRequestSchema = z.object({
  displayName: z.string().trim().min(1, "Display name is required").max(32),
  role: UserRoleSchema.optional(),
});

export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: UserRoleSchema,
});

export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

export const RoomResponseSchema = z.object({
  room: RoomSchema,
  currentMember: RoomMemberSchema.optional(),
});

export type RoomResponse = z.infer<typeof RoomResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
