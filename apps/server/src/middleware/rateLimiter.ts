import { rateLimit, Options } from "express-rate-limit";
import { Request, Response } from "express";
import crypto from "node:crypto";
import { RequestWithId, isValidUUID } from "./logger.js";
import { config } from "../config.js";

/**
 * Creates an express-rate-limit middleware with standard PairPrep error formatting.
 * Threshold is configurable for test isolation and environment overrides.
 */
export function createRateLimiter(customOptions?: Partial<Options>) {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: config.RATE_LIMIT_MAX || 100, // Configurable threshold (default 100)
    standardHeaders: true, // Return standard RateLimit headers
    legacyHeaders: true, // X-RateLimit-* headers
    handler: (req: Request, res: Response) => {
      const reqWithId = req as RequestWithId;
      const headerId = res.getHeader("X-Request-Id") as string | undefined;
      const requestId = isValidUUID(reqWithId.id)
        ? reqWithId.id!
        : isValidUUID(headerId)
          ? headerId!
          : crypto.randomUUID();

      // Ensure standard Retry-After header is explicitly set on 429 responses
      if (!res.getHeader("Retry-After")) {
        const reqWithRateLimit = req as Request & { rateLimit?: { resetTime?: Date } };
        const resetTime = reqWithRateLimit.rateLimit?.resetTime;
        const retryAfter = resetTime
          ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
          : 60;
        res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      }

      res.status(429).json({
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
          requestId,
        },
      });
    },
    ...customOptions,
  });
}

/**
 * PRD SEC-1 & T01: Standard rate limiting middleware.
 * Memory store: 100 requests per minute per IP.
 * Returns HTTP 429 with standard error shape and Retry-After header.
 */
export const apiRateLimiter = createRateLimiter();
