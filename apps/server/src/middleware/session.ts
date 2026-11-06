import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "../config.js";
import { rootLogger } from "./logger.js";

export const SESSION_COOKIE_NAME = "pairprep.sid";

let memoizedStore: MongoStore | null = null;

/**
 * Returns the lazily initialized, memoized MongoStore instance.
 * Created only when Mongoose is fully connected (readyState === 1).
 * Resets to null if disconnected or if store emits an error.
 */
export function getSessionStore(): MongoStore | null {
  if (mongoose.connection.readyState !== 1) {
    memoizedStore = null;
    return null;
  }
  if (!memoizedStore) {
    memoizedStore = MongoStore.create({
      clientPromise: Promise.resolve(mongoose.connection.getClient()),
      collectionName: "sessions",
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
      autoRemove: "native",
      touchAfter: 24 * 3600,
    });
    memoizedStore.on("error", (err) => {
      const errorName =
        err && typeof err === "object" && "name" in err
          ? String((err as { name: unknown }).name)
          : "Error";
      rootLogger.error(
        { errorName },
        "MongoStore error; invalidating memoized store"
      );
      memoizedStore = null;
    });
  }
  return memoizedStore;
}

/**
 * Wraps store.get(sid, cb) in a Promise.
 * Returns null if database is down, session not found, or retrieval errors.
 */
export function fetchSessionData(
  sid: string
): Promise<Record<string, unknown> | null> {
  const store = getSessionStore();
  if (!store) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    store.get(sid, (err, sessionData) => {
      if (err || !sessionData) {
        if (err) {
          rootLogger.error({ err, sid }, "Error fetching session from store");
        }
        resolve(null);
      } else {
        resolve(sessionData as unknown as Record<string, unknown>);
      }
    });
  });
}

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
    const store = getSessionStore();
    if (!store) {
      throw new Error(
        "Cannot initialize session middleware without active database connection"
      );
    }
    if (!sessionHandler) {
      sessionHandler = session({
        name: SESSION_COOKIE_NAME,
        secret: config.SESSION_SECRET!,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        store,
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
      memoizedStore = null;
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
          memoizedStore = null;
          const errorName =
            err && typeof err === "object" && "name" in err
              ? String((err as { name: unknown }).name)
              : "Error";
          rootLogger.error({ errorName }, "Session store error");
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
    } catch (err: unknown) {
      sessionHandler = null;
      memoizedStore = null;
      const errorName =
        err && typeof err === "object" && "name" in err
          ? String((err as { name: unknown }).name)
          : "Error";
      rootLogger.error({ errorName }, "Session middleware failure");
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
