import { Request, Response } from "express";
import crypto from "node:crypto";
import { RequestWithId } from "./logger.js";

/**
 * 404 Handler for unmatched routes.
 * Returns standard unified error shape:
 * { "error": { "code": "NOT_FOUND", "message": "...", "requestId": "..." } }
 */
export function notFoundHandler(req: Request, res: Response): void {
  const reqWithId = req as RequestWithId;
  const requestId =
    reqWithId.id || (res.getHeader("X-Request-Id") as string) || crypto.randomUUID();

  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl || req.url}`,
      requestId,
    },
  });
}
