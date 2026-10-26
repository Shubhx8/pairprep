import rateLimit from "express-rate-limit";
import { Request, Response } from "express";

/**
 * PRD SEC-1 & T05: Rate limiter for room creation.
 * 10 requests per hour per authenticated user (or per IP fallback).
 */
export const roomCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req: Request) => req.principal?.id || req.ip || "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many room creation requests, please try again later",
        requestId,
      },
    });
  },
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
});

/**
 * PRD SEC-1 & T05: Rate limiter for room joins and slug lookups.
 * 60 requests per minute per IP.
 * skipSuccessfulRequests: true prevents blocking valid campus NAT users when joins/lookups succeed.
 */
export const roomJoinLookupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyGenerator: (req: Request) => req.ip || "unknown",
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests, please try again later",
        requestId,
      },
    });
  },
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
});
