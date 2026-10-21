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
