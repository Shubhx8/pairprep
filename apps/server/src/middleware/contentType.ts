import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { RequestWithId } from "./logger.js";

/**
 * Middleware that rejects requests with unsupported or unknown Content-Type on body-bearing methods.
 */
export function validateContentType(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const method = req.method.toUpperCase();
  const contentLengthStr = req.headers["content-length"];
  const contentLength =
    contentLengthStr !== undefined ? parseInt(contentLengthStr, 10) : NaN;
  const hasBody =
    ["POST", "PUT", "PATCH"].includes(method) &&
    ((!isNaN(contentLength) && contentLength > 0) ||
      req.headers["transfer-encoding"] !== undefined);

  if (hasBody) {
    const contentType = req.headers["content-type"];

    // If a body is sent, content-type must be application/json
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      const reqWithId = req as RequestWithId;
      const requestId =
        reqWithId.id || (res.getHeader("X-Request-Id") as string) || crypto.randomUUID();

      res.status(415).json({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Only application/json content type is supported",
          requestId,
        },
      });
      return;
    }
  }

  next();
}
