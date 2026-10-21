import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      isGuest: boolean;
    }
  }
}

export const SESSION_COOKIE_NAME = "pairprep_session";

/**
 * PRD 6.1 AUTH-3 / AUTH-4: Session identification middleware
 * Extracts existing session cookie or generates a secure guest session ID.
 * Sets HttpOnly, SameSite=Lax cookie.
 */
export function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  let sessionId = req.cookies?.[SESSION_COOKIE_NAME];

  if (!sessionId || typeof sessionId !== "string") {
    // Generate a secure guest session ID
    sessionId = `guest_${crypto.randomUUID()}`;
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (PRD AUTH-4)
      path: "/",
    });
  }

  req.userId = sessionId;
  req.isGuest = sessionId.startsWith("guest_");
  next();
}
