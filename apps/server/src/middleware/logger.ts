import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

export interface RequestWithId extends Request {
  id?: string;
}

export function requestLogger(
  req: RequestWithId,
  res: Response,
  next: NextFunction
): void {
  const start = performance.now();
  const requestId =
    (req.headers["x-request-id"] as string | undefined) || crypto.randomUUID();
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      // Strictly avoid logging sensitive payload bodies or headers per OBS-1
    };

    // Output structured JSON line
    process.stdout.write(JSON.stringify(logEntry) + "\n");
  });

  next();
}
