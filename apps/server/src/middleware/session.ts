import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "../config.js";

export const SESSION_COOKIE_NAME = "pairprep.sid";

/**
 * PRD 6.1 AUTH-4 / T04: Session middleware with MongoDB store (connect-mongo)
 * - Cookie: pairprep.sid, httpOnly, secure in production, SameSite=Lax, 7 days idle expiry (rolling)
 * - Stores sessions in MongoDB 'sessions' collection using the single Mongoose connection
 * - Uses strictly config.SESSION_SECRET with NO fallback string
 * - Returns standard 503 DATABASE_UNAVAILABLE if session store / database fails
 */
export function createSessionMiddleware(): RequestHandler {
  if (!config.SESSION_SECRET) {
    throw new Error(
      "SESSION_SECRET is required to initialize session middleware (min 32 characters)"
    );
  }

  let sessionHandler: RequestHandler | null = null;

  function getSessionHandler(): RequestHandler {
    if (!sessionHandler) {
      sessionHandler = session({
        name: SESSION_COOKIE_NAME,
        secret: config.SESSION_SECRET!,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        store: MongoStore.create({
          clientPromise: Promise.resolve(mongoose.connection.getClient()),
          collectionName: "sessions",
          ttl: 7 * 24 * 60 * 60, // 7 days in seconds
          autoRemove: "native",
          touchAfter: 24 * 3600,
        }),
        cookie: {
          httpOnly: true,
          secure: config.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
          path: "/",
        },
      });
    }
    return sessionHandler;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    // Fast 503 without hang if MONGODB_URI is unset or DB is not connected / disconnected
    if (!config.MONGODB_URI || mongoose.connection.readyState !== 1) {
      sessionHandler = null;
      const requestId =
        (res.getHeader("X-Request-Id") as string) ||
        (req.headers["x-request-id"] as string) ||
        "";
      res.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Session service temporarily unavailable",
          requestId,
        },
      });
      return;
    }

    try {
      const handler = getSessionHandler();
      handler(req, res, (err) => {
        if (err) {
          sessionHandler = null;
          const requestId =
            (res.getHeader("X-Request-Id") as string) ||
            (req.headers["x-request-id"] as string) ||
            "";
          res.status(503).json({
            error: {
              code: "DATABASE_UNAVAILABLE",
              message: "Session service temporarily unavailable",
              requestId,
            },
          });
          return;
        }
        next();
      });
    } catch {
      sessionHandler = null;
      const requestId =
        (res.getHeader("X-Request-Id") as string) ||
        (req.headers["x-request-id"] as string) ||
        "";
      res.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Session service temporarily unavailable",
          requestId,
        },
      });
    }
  };
}
