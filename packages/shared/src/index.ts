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
