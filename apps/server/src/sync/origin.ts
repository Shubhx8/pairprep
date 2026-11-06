import { config } from "../config.js";

/**
 * Returns the set of allowlisted origins based on environment.
 * In production: strictly config.SITE_ORIGIN.
 * In development/test: SITE_ORIGIN, CLIENT_ORIGIN, and local dev ports.
 */
export function getAllowedOrigins(): Set<string> {
  const origins =
    config.NODE_ENV === "production"
      ? [config.SITE_ORIGIN]
      : [
          config.SITE_ORIGIN,
          config.CLIENT_ORIGIN,
          "http://localhost:5173",
          "http://localhost:3000",
          "http://127.0.0.1:5173",
          "http://127.0.0.1:3000",
        ];

  return new Set(
    origins.filter((o): o is string => Boolean(o && typeof o === "string"))
  );
}

/**
 * Validates the Origin header for WebSocket upgrade requests.
 * Missing, malformed, or untrusted origins return false.
 */
export function isAllowedOrigin(originHeader?: string | string[]): boolean {
  if (!originHeader) return false;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin || typeof origin !== "string") return false;

  const allowed = getAllowedOrigins();
  return allowed.has(origin.trim());
}
