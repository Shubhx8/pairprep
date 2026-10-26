import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { config } from "../config.js";
import { IUser } from "../models/users.js";
import { IGuest } from "../models/guests.js";
import { guestRepo } from "../repos/guestRepo.js";

export const GUEST_COOKIE_NAME = "pairprep.guest";

export type UserPrincipal = {
  type: "user";
  id: string;
  displayName: string;
  avatarUrl?: string;
  role: "user" | "owner-admin";
  user: IUser;
};

export type GuestPrincipal = {
  type: "guest";
  id: string;
  displayName: string;
  roomId: string;
  guest: IGuest;
};

export type Principal = UserPrincipal | GuestPrincipal;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      user?: IUser;
      userId?: string;
      isGuest?: boolean;
    }
  }
}

/**
 * Derives a dedicated 256-bit HMAC signing key from SESSION_SECRET with domain separation.
 */
function getGuestSigningKey(): Buffer {
  const secret =
    config.SESSION_SECRET || "fallback_secret_must_be_at_least_32_characters_long";
  return crypto
    .createHmac("sha256", secret)
    .update("pairprep.guest-cookie-signing-v1")
    .digest();
}

/**
 * Signs a guestId producing a cookie value formatted as `<guestId>.<base64url_signature>`
 */
export function signGuestCookie(guestId: string): string {
  const key = getGuestSigningKey();
  const signature = crypto.createHmac("sha256", key).update(guestId).digest("base64url");
  return `${guestId}.${signature}`;
}

/**
 * Verifies a signed guest cookie using constant-time comparison.
 * Returns verified guestId or null if tampered/invalid.
 */
export function verifyGuestCookie(cookieValue: string): string | null {
  if (!cookieValue || typeof cookieValue !== "string") return null;

  const dotIndex = cookieValue.indexOf(".");
  if (dotIndex === -1) return null;

  const guestId = cookieValue.substring(0, dotIndex);
  const signature = cookieValue.substring(dotIndex + 1);

  if (!guestId || !signature) return null;

  const key = getGuestSigningKey();
  const expectedSig = crypto
    .createHmac("sha256", key)
    .update(guestId)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature, "utf-8");
  const expectedBuffer = Buffer.from(expectedSig, "utf-8");

  if (sigBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  return guestId;
}

/**
 * Sets the signed pairprep.guest cookie on the HTTP response.
 */
export function setGuestCookie(res: Response, guestId: string): void {
  const cookieValue = signGuestCookie(guestId);
  res.cookie(GUEST_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
  });
}

/**
 * Clears the pairprep.guest cookie.
 */
export function clearGuestCookie(res: Response): void {
  res.clearCookie(GUEST_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: "/",
  });
}

/**
 * Identity middleware: Mounted after passport session.
 * 1. A signed-in user session (req.user) strictly takes precedence over any guest cookie.
 * 2. If no user session, verifies the pairprep.guest cookie.
 * 3. If cookie is tampered or guest is expired/non-existent, clears the cookie and sets anonymous.
 * 4. Populates req.principal, req.userId, and req.isGuest.
 */
export async function identify(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const passportUser = req.user as IUser | undefined;

  if (passportUser && !passportUser.disabled) {
    req.principal = {
      type: "user",
      id: passportUser.id,
      displayName: passportUser.displayName,
      avatarUrl: passportUser.avatarUrl,
      role: passportUser.role,
      user: passportUser,
    };
    req.userId = passportUser.id;
    req.isGuest = false;
    return next();
  }

  const rawGuestCookie = req.cookies?.[GUEST_COOKIE_NAME] as string | undefined;

  if (!rawGuestCookie) {
    req.principal = undefined;
    req.userId = undefined;
    req.isGuest = true;
    return next();
  }

  const verifiedGuestId = verifyGuestCookie(rawGuestCookie);
  if (!verifiedGuestId) {
    clearGuestCookie(res);
    req.principal = undefined;
    req.userId = undefined;
    req.isGuest = true;
    return next();
  }

  try {
    const guestDoc = await guestRepo.findById(verifiedGuestId);
    if (!guestDoc || guestDoc.expiresAt.getTime() <= Date.now()) {
      clearGuestCookie(res);
      req.principal = undefined;
      req.userId = undefined;
      req.isGuest = true;
      return next();
    }

    req.principal = {
      type: "guest",
      id: guestDoc.id,
      displayName: guestDoc.displayName,
      roomId: guestDoc.roomId,
      guest: guestDoc,
    };
    req.userId = guestDoc.id;
    req.isGuest = true;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Guard requiring a principal (signed-in user OR verified guest).
 */
export function requirePrincipal(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal) {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        requestId,
      },
    });
    return;
  }
  next();
}

/**
 * Guard requiring an authenticated user (rejects guests with 401).
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal || req.principal.type !== "user") {
    const requestId =
      (res.getHeader("X-Request-Id") as string) ||
      (req.headers["x-request-id"] as string) ||
      "";
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        requestId,
      },
    });
    return;
  }
  next();
}
