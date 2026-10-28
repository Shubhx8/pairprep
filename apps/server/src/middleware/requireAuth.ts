import { Request, Response, NextFunction } from "express";
import { IUser } from "../models/users.js";

declare module "express-session" {
  interface SessionData {
    returnTo?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

/**
 * PRD 6.1 AUTH-4 / 13.1: Guard requiring an active authenticated user session.
 * Rejects unauthenticated requests with HTTP 401 and code 'UNAUTHORIZED'.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user as IUser | undefined;

  if (!user) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        requestId: (res.getHeader("X-Request-Id") as string) || "",
      },
    });
    return;
  }

  if (user.disabled) {
    req.session.destroy(() => {});
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Session is invalid or expired",
        requestId: (res.getHeader("X-Request-Id") as string) || "",
      },
    });
    return;
  }

  next();
}
