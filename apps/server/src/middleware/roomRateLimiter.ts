import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { Request, Response } from "express";

/**
 * PRD SEC-1 & T05: Rate limiter for room creation.
 * 10 requests per hour per authenticated user (or per IP fallback).
 */
export const roomCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  keyGenerator: (req: Request) =>
    req.principal?.id || ipKeyGenerator(req.ip || "127.0.0.1"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";

    if (!res.getHeader("Retry-After")) {
      const reqWithRateLimit = req as Request & { rateLimit?: { resetTime?: Date } };
      const resetTime = reqWithRateLimit.rateLimit?.resetTime;
      const retryAfter = resetTime
        ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
        : 3600;
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
    }

    res.status(429).json({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many room creation requests, please try again later",
        requestId,
      },
    });
  },
});

/**
 * PRD SEC-1 & T05: Rate limiter for room joins and slug lookups.
 * 60 requests per minute per IP.
 * skipSuccessfulRequests: true prevents blocking valid campus NAT users when joins/lookups succeed.
 */
export const roomJoinLookupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || "127.0.0.1"),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";

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
        message: "Too many requests, please try again later",
        requestId,
      },
    });
  },
});
