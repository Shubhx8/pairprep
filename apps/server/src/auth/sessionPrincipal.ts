import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, fetchSessionData } from "../middleware/session.js";
import {
  GUEST_COOKIE_NAME,
  verifyGuestCookie,
  type Principal,
  type UserPrincipal,
  type GuestPrincipal,
} from "../middleware/identity.js";
import { userRepo } from "../repos/userRepo.js";
import { guestRepo } from "../repos/guestRepo.js";

export type SessionResolutionResult =
  | { success: true; principal: Principal }
  | {
      success: false;
      reason: "unauthenticated" | "disabled" | "db_unavailable" | "invalid_guest";
    };

/**
 * Standard RFC 6265 cookie header string parser.
 */
export function parseCookieString(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;

  const pairs = cookieHeader.split(";");
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]?.trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    let val = pair.slice(eqIdx + 1).trim();
    if (val && val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Resolves Principal from a raw Cookie header string or parsed cookies.
 * Shared between HTTP identify middleware and WebSocket handshake.
 * Rejects disabled users with reason: 'disabled'.
 */
export async function resolvePrincipalFromCookies(
  cookieHeader?: string,
  targetRoomId?: string
): Promise<SessionResolutionResult> {
  if (!cookieHeader) {
    return { success: false, reason: "unauthenticated" };
  }

  // Fast check for active database connection
  if (mongoose.connection.readyState !== 1) {
    return { success: false, reason: "db_unavailable" };
  }

  const rawCookies = parseCookieString(cookieHeader);

  // 1. User session cookie: pairprep.sid
  const rawSidCookie = rawCookies[SESSION_COOKIE_NAME];
  if (rawSidCookie && config.SESSION_SECRET) {
    const sid = cookieParser.signedCookie(rawSidCookie, config.SESSION_SECRET);
    if (sid && typeof sid === "string") {
      const sessionData = await fetchSessionData(sid);
      const passportData = sessionData?.passport as { user?: unknown } | undefined;
      const userId = passportData?.user;

      if (
        userId &&
        typeof userId === "string" &&
        mongoose.Types.ObjectId.isValid(userId)
      ) {
        const userDoc = await userRepo.findById(userId);
        if (userDoc) {
          if (userDoc.disabled) {
            return { success: false, reason: "disabled" };
          }
          const principal: UserPrincipal = {
            type: "user",
            id: userDoc.id,
            displayName: userDoc.displayName,
            avatarUrl: userDoc.avatarUrl,
            role: userDoc.role,
            user: userDoc,
          };
          return { success: true, principal };
        }
      }
    }
  }

  // 2. Guest cookie: pairprep.guest
  const rawGuestCookie = rawCookies[GUEST_COOKIE_NAME];
  if (rawGuestCookie) {
    const verifiedGuestId = verifyGuestCookie(rawGuestCookie);
    if (verifiedGuestId) {
      const guestDoc = await guestRepo.findById(verifiedGuestId);
      if (guestDoc && guestDoc.expiresAt.getTime() > Date.now()) {
        // If targetRoomId is supplied, verify guest matches room
        if (targetRoomId && guestDoc.roomId !== targetRoomId) {
          return { success: false, reason: "invalid_guest" };
        }
        const principal: GuestPrincipal = {
          type: "guest",
          id: guestDoc.id,
          displayName: guestDoc.displayName,
          roomId: guestDoc.roomId,
          guest: guestDoc,
        };
        return { success: true, principal };
      }
    }
  }

  return { success: false, reason: "unauthenticated" };
}
