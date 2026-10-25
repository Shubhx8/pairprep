import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

/**
 * PRD 6.1 / T04: Strict rate limit on /auth/* routes
 * Capped at config.AUTH_RATE_LIMIT_MAX requests per minute per IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication requests. Please try again in 1 minute.",
        requestId:
          (res.getHeader("X-Request-Id") as string) ||
          (req.headers["x-request-id"] as string) ||
          (req as unknown as { id?: string }).id ||
          "",
      },
    });
  },
  validate: { xForwardedForHeader: false },
});
