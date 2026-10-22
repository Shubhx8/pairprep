import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";
import { RequestWithId, isValidUUID } from "./logger.js";

/**
 * Central Error Middleware enforcing standard unified error shape:
 * { "error": { "code": "STABLE_CODE", "message": "...", "requestId": "..." } }
 * Standardizes body-parser errors (PAYLOAD_TOO_LARGE, INVALID_JSON) and never exposes stack traces.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const reqWithId = req as RequestWithId;
  const headerId = res.getHeader("X-Request-Id") as string | undefined;
  const requestId = isValidUUID(reqWithId.id)
    ? reqWithId.id!
    : isValidUUID(headerId)
      ? headerId!
      : crypto.randomUUID();

  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "An internal server error occurred";
  let fields: Record<string, string> | undefined;

  const errObj =
    typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    fields = err.fields;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = "Request validation failed";
    fields = {};
    for (const issue of err.issues) {
      const fieldPath = issue.path.join(".") || "body";
      fields[fieldPath] = issue.message;
    }
  } else if (
    errObj["type"] === "entity.too.large" ||
    errObj["status"] === 413 ||
    errObj["statusCode"] === 413
  ) {
    statusCode = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Payload exceeds 100 KB limit";
  } else if (
    errObj["type"] === "entity.parse.failed" ||
    (err instanceof SyntaxError &&
      (errObj["status"] === 400 || errObj["statusCode"] === 400))
  ) {
    statusCode = 400;
    code = "INVALID_JSON";
    message = "Malformed JSON payload";
  } else if (err instanceof Error) {
    message =
      process.env["NODE_ENV"] === "production"
        ? "An internal server error occurred"
        : err.message || "An internal server error occurred";
  }

  const responseBody: {
    error: {
      code: string;
      message: string;
      requestId: string;
      fields?: Record<string, string>;
    };
  } = {
    error: {
      code,
      message,
      requestId,
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    },
  };

  res.status(statusCode).json(responseBody);
}
