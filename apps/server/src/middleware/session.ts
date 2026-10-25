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
  // PRD 6.1 AUTH-4: Reuse the single Mongoose connection established in T03 without opening a second connection
  // Waits for the connection established in T03 to be ready, then hands its client to connect-mongo
  const clientPromise = new Promise<ReturnType<typeof mongoose.connection.getClient>>(
    (resolve, reject) => {
      if (mongoose.connection.readyState === 1) {
        return resolve(mongoose.connection.getClient());
      }
      const timeout = setTimeout(() => {
        reject(new Error("Database connection timeout for session store"));
      }, 5000);
      timeout.unref();

      mongoose.connection.once("connected", () => {
        clearTimeout(timeout);
        resolve(mongoose.connection.getClient());
      });
      mongoose.connection.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    }
  ).catch((err) => {
    throw err;
  });

  if (!config.SESSION_SECRET) {
    throw new Error(
      "SESSION_SECRET is required to initialize session middleware (min 32 characters)"
    );
  }

  const sessionHandler = session({
    name: SESSION_COOKIE_NAME,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Resets 7-day expiry on user activity (PRD AUTH-4)
    store: MongoStore.create({
      clientPromise,
      collectionName: "sessions",
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
      autoRemove: "native",
      touchAfter: 24 * 3600, // Lazy session update once a day unless session data changes
    }),
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      path: "/",
    },
  });

  return (req: Request, res: Response, next: NextFunction) => {
    sessionHandler(req, res, (err) => {
      if (err) {
        res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Session service temporarily unavailable",
            requestId:
              (res.getHeader("X-Request-Id") as string) ||
              (req.headers["x-request-id"] as string) ||
              "",
          },
        });
        return;
      }
      next();
    });
  };
}
