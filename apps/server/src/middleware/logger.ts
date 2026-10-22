import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import pino, { DestinationStream, Logger } from "pino";

export interface RequestWithId extends Request {
  id?: string;
  log?: Logger;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns true if the string is a valid UUID format (v1-v5).
 */
export function isValidUUID(id?: string): boolean {
  return typeof id === "string" && UUID_REGEX.test(id);
}

/**
 * Creates a configured Pino logger instance with strict redaction of sensitive credentials.
 */
export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: process.env["LOG_LEVEL"] || "info",
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.headers['set-cookie']",
          "req.headers.set-cookie",
          "headers.cookie",
          "headers.authorization",
          "headers['set-cookie']",
          "headers.set-cookie",
          "cookie",
          "authorization",
          "set-cookie",
          "Set-Cookie",
        ],
        censor: "[REDACTED]",
      },
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination
  );
}

// Default global logger instance
export const rootLogger = createLogger();

/**
 * Express middleware that:
 * 1. Validates incoming X-Request-Id as a strict UUID. Rejects & overwrites spoofed/invalid IDs.
 * 2. Attaches child logger tagged with requestId.
 * 3. Records completed HTTP requests as structured JSON lines.
 * 4. Logs paths WITHOUT query strings to prevent OAuth/token leaks.
 * 5. Strictly never logs request bodies, code, or chat text per PRD OBS-1.
 */
export function requestLogger(
  req: RequestWithId,
  res: Response,
  next: NextFunction
): void {
  const start = performance.now();
  const incomingId = req.headers["x-request-id"] as string | undefined;

  // Validate strict UUID format. If invalid or missing, generate a new UUID.
  const requestId = isValidUUID(incomingId) ? incomingId! : crypto.randomUUID();

  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);

  // Child logger tagged with requestId for contextual logging
  req.log = rootLogger.child({ requestId });

  res.on("finish", () => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

    // Strip query string from path to prevent secret/token leaks in logs
    const rawUrl = req.originalUrl || req.url || "/";
    const pathWithoutQuery = rawUrl.split("?")[0] || "/";

    const logData = {
      requestId,
      method: req.method,
      path: pathWithoutQuery,
      statusCode,
      durationMs,
    };

    req.log?.[level](logData, "HTTP request completed");
  });

  next();
}
