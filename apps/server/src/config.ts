import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Loads .env file into process.env if available (Node 20.6+ native loadEnvFile).
 * Searches current working directory, workspace root, and parent directories.
 */
function loadEnvFileSafely(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../.env"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        if (
          typeof (process as unknown as { loadEnvFile?: (path: string) => void })
            .loadEnvFile === "function"
        ) {
          (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(
            candidate
          );
          break;
        }
      } catch {
        // Continue searching if file load fails
      }
    }
  }
}

if (process.env["NODE_ENV"] !== "test") {
  loadEnvFileSafely();
}

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // MONGODB_URI and SESSION_SECRET optional in T01 to prevent CI deployment rollback
  MONGODB_URI: z
    .string()
    .refine((val) => val.startsWith("mongodb://") || val.startsWith("mongodb+srv://"), {
      message: "MONGODB_URI must start with mongodb:// or mongodb+srv://",
    })
    .optional(),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters")
    .optional(),
  SITE_ORIGIN: z.string().default("http://localhost:3000"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().optional(),
  RUNNER_URL: z.string().optional(),
  RUNNER_SECRET: z.string().optional(),
  GIT_SHA: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates environment variables into a typed Config object.
 * Tests can inject a mock env object rather than mutating process.env.
 * Fails fast with ONLY variable names if invalid or missing, never leaking secret values.
 */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(rawEnv);

  if (!result.success) {
    const invalidVarNames = Array.from(
      new Set(
        result.error.issues.map((issue) =>
          issue.path.length > 0 ? String(issue.path[0]) : "UNKNOWN_VARIABLE"
        )
      )
    );

    throw new Error(
      `Invalid or missing environment variables: ${invalidVarNames.join(", ")}`
    );
  }

  return result.data;
}

// Alias for backward compatibility
export const validateConfig = loadConfig;

// Default exported config initialized from process.env
export const config = loadConfig(process.env);
