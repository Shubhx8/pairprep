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

  const rawUrl = req.originalUrl || req.url || "/";
  const pathWithoutQuery = rawUrl.split("?")[0] || "/";
  const sanitizedPath = pathWithoutQuery.replace(
    /(\/api\/v1\/rooms\/)[A-Za-z0-9_-]{16,}(\/|$)/g,
    "$1:slug$2"
  );

  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${sanitizedPath}`,
      requestId,
    },
  });
}
