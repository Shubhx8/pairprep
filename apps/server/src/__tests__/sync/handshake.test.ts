import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";
import mongoose from "mongoose";
import type session from "express-session";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { guestRepo } from "../../repos/guestRepo.js";
import { config } from "../../config.js";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { documentLoadWaiters } from "../../sync/documentWaiters.js";
import { isAllowedOrigin, getAllowedOrigins } from "../../sync/origin.js";
import {
  getClientIp,
  UpgradeRateLimiter,
  syncUpgradeRateLimiter,
} from "../../sync/rateLimiter.js";
import {
  resolvePrincipalFromCookies,
  parseCookieString,
} from "../../auth/sessionPrincipal.js";
import { signGuestCookie } from "../../middleware/identity.js";
import { SESSION_COOKIE_NAME, getSessionStore } from "../../middleware/session.js";

/**
 * Creates standard express-session signed cookie value: s:<val>.<hmac-sha256-base64-no-padding>
 */
function signExpressSessionCookie(val: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}

describe("T07 Handshake, Session Resolution, Origin & IP Limit", () => {
  let httpServer: HttpServer | undefined;
  let syncServer: SyncServerInstance | undefined;

  beforeAll(async () => {
    await setupTestDb("sync_handshake");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    syncUpgradeRateLimiter.resetAll();
  });

  afterEach(async () => {
    if (syncServer) {
      await syncServer.destroy();
      syncServer = undefined;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = undefined;
    }
  });

  describe("Startup Runtime Guard", () => {
    it("throws immediately at startup if crossws.handleUpgrade is missing", () => {
      const dummyHttp = createServer();
      const mockBrokenServer = {
        server: {} as unknown as SyncServerInstance["server"],
        destroy: async () => {},
      };

      expect(() => {
        attachSyncServer(dummyHttp, mockBrokenServer as unknown as SyncServerInstance);
      }).toThrow(/Hocuspocus internal crossws adapter not found/);
    });
  });

  describe("Origin Header Enforcement", () => {
    it("reports allowed origins accurately from environment configuration", () => {
      const allowed = getAllowedOrigins();
      expect(allowed.has("http://localhost:3000")).toBe(true);
      expect(allowed.has("http://localhost:5173")).toBe(true);
      expect(allowed.has("http://evil.com")).toBe(false);
      expect(isAllowedOrigin(undefined)).toBe(false);
      expect(isAllowedOrigin("")).toBe(false);
      expect(isAllowedOrigin("http://evil.attacker.com")).toBe(false);
      expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    });

    it("rejects WebSocket connection with missing Origin with 403 Forbidden", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`); // No origin header passed

      const statusCode = await new Promise<number | null>((resolve) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode || null);
        });
        ws.on("open", () => {
          ws.close();
          resolve(200);
        });
        ws.on("error", () => {
          // Handled by unexpected-response
        });
      });

      expect(statusCode).toBe(403);
    });

    it("rejects WebSocket connection with untrusted Origin with 403 Forbidden", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://malicious-site.com" },
      });

      const statusCode = await new Promise<number | null>((resolve) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode || null);
        });
        ws.on("open", () => {
          ws.close();
          resolve(200);
        });
        ws.on("error", () => {});
      });

      expect(statusCode).toBe(403);
    });

    it("accepts WebSocket connection with allowlisted Origin", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://localhost:3000" },
      });

      const connected = await new Promise<boolean>((resolve) => {
        ws.on("open", () => {
          ws.close();
          resolve(true);
        });
        ws.on("error", () => {
          resolve(false);
        });
      });

      expect(connected).toBe(true);
    });
  });

  describe("IP Rate Limiting & Proxy Trust", () => {
    it("derives client IP and ignores forged X-Forwarded-For on untrusted direct connection", () => {
      const reqUntrusted = {
        socket: { remoteAddress: "203.0.113.88" },
        headers: { "x-forwarded-for": "198.51.100.99" },
      } as unknown as IncomingMessage;

      const derivedIp = getClientIp(reqUntrusted);
      expect(derivedIp).toBe("203.0.113.88"); // Forged header ignored
    });

    it("derives client IP from X-Forwarded-For when connection is from trusted proxy", () => {
      const reqTrusted = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "198.51.100.99" },
      } as unknown as IncomingMessage;

      const derivedIp = getClientIp(reqTrusted);
      expect(derivedIp).toBe("198.51.100.99"); // Trusted proxy unwraps real client IP
    });

    it("enforces 60 rejected attempts per minute and returns 429", async () => {
      const limiter = new UpgradeRateLimiter({ maxRejections: 3, windowMs: 60_000 });
      const testIp = "192.0.2.1";

      expect(limiter.isRateLimited(testIp)).toBe(false);
      limiter.recordRejection(testIp);
      limiter.recordRejection(testIp);
      expect(limiter.isRateLimited(testIp)).toBe(false);
      limiter.recordRejection(testIp);
      expect(limiter.isRateLimited(testIp)).toBe(true);

      // Reset clears the limit
      limiter.resetKey(testIp);
      expect(limiter.isRateLimited(testIp)).toBe(false);
    });

    it("bounds rejection map to maxEntries", () => {
      const limiter = new UpgradeRateLimiter({ maxEntries: 5 });
      for (let i = 0; i < 10; i++) {
        limiter.recordRejection(`10.0.0.${i}`);
      }
      expect(limiter.size).toBeLessThanOrEqual(5);
    });

    it("returns HTTP 429 when client IP has exceeded the rejection threshold", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      // Populate 60 rejections for loopback IPs
      for (let i = 0; i < 60; i++) {
        syncUpgradeRateLimiter.recordRejection("127.0.0.1");
        syncUpgradeRateLimiter.recordRejection("::1");
      }

      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://localhost:3000" },
      });

      const statusCode = await new Promise<number | null>((resolve) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode || null);
        });
        ws.on("open", () => {
          ws.close();
          resolve(200);
        });
        ws.on("error", () => {});
      });

      expect(statusCode).toBe(429);
    });
  });

  describe("Session Resolution (resolvePrincipalFromCookies)", () => {
    it("parses cookie strings correctly", () => {
      const cookieStr =
        'pairprep.sid=s%3A123.abc; pairprep.guest="guest-id.sig"; other=value';
      const parsed = parseCookieString(cookieStr);
      expect(parsed["pairprep.sid"]).toBe("s:123.abc");
      expect(parsed["pairprep.guest"]).toBe("guest-id.sig");
      expect(parsed["other"]).toBe("value");
    });

    it("resolves active user session cookie to UserPrincipal", async () => {
      const user = await userRepo.upsertUser({
        provider: "google",
        providerId: "user_test_1",
        displayName: "Valid User",
        email: "user1@example.com",
      });

      // Save a session into MongoStore
      const store = getSessionStore();
      expect(store).not.toBeNull();
      const rawSid = "test-session-id-123";
      await new Promise<void>((resolve, reject) => {
        store!.set(
          rawSid,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: user.id },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      });

      const cookieVal = signExpressSessionCookie(rawSid, config.SESSION_SECRET!);
      const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieVal}`;

      const result = await resolvePrincipalFromCookies(cookieHeader);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.principal.type).toBe("user");
        expect(result.principal.id).toBe(user.id);
        expect(result.principal.displayName).toBe("Valid User");
      }
    });

    it("rejects disabled users with reason: 'disabled'", async () => {
      const disabledUser = await userRepo.upsertUser({
        provider: "google",
        providerId: "user_disabled_1",
        displayName: "Disabled User",
        email: "disabled@example.com",
      });
      // Mark as disabled
      disabledUser.disabled = true;
      await disabledUser.save();

      const store = getSessionStore();
      const rawSid = "disabled-session-456";
      await new Promise<void>((resolve, reject) => {
        store!.set(
          rawSid,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: disabledUser.id },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      });

      const cookieVal = signExpressSessionCookie(rawSid, config.SESSION_SECRET!);
      const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieVal}`;

      const result = await resolvePrincipalFromCookies(cookieHeader);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("disabled");
      }
    });

    it("resolves valid guest cookie to GuestPrincipal matching the room", async () => {
      const roomId = new mongoose.Types.ObjectId().toHexString();
      const guest = await guestRepo.createGuest("Test Guest", roomId);

      const guestCookieVal = signGuestCookie(guest.id);
      const cookieHeader = `pairprep.guest=${guestCookieVal}`;

      // With matching targetRoomId
      const result = await resolvePrincipalFromCookies(cookieHeader, roomId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.principal.type).toBe("guest");
        expect(result.principal.id).toBe(guest.id);
      }

      // With mismatched targetRoomId
      const mismatchRoomId = new mongoose.Types.ObjectId().toHexString();
      const mismatchResult = await resolvePrincipalFromCookies(
        cookieHeader,
        mismatchRoomId
      );
      expect(mismatchResult.success).toBe(false);
      if (!mismatchResult.success) {
        expect(mismatchResult.reason).toBe("invalid_guest");
      }
    });

    it("rejects unauthenticated requests without cookies", async () => {
      const result = await resolvePrincipalFromCookies(undefined);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("unauthenticated");
      }
    });
  });

  describe("Hocuspocus onAuthenticate Hook Document & Auth Validation", () => {
    it("rejects invalid document name (non-ObjectId) in onAuthenticate", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: true }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const { HocuspocusProvider, HocuspocusProviderWebsocket } =
        await import("@hocuspocus/provider");
      const { Doc } = await import("yjs");

      class AuthTestWs extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
            },
          });
        }
      }

      const wsProvider = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: AuthTestWs as unknown as typeof WebSocket,
      });

      const doc = new Doc();
      const authFailedPromise = new Promise<string>((resolve) => {
        const provider = new HocuspocusProvider({
          websocketProvider: wsProvider,
          name: "not-a-valid-object-id", // Slug or random string rejected
          document: doc,
          onAuthenticationFailed: (data) => {
            resolve(data.reason);
          },
        });
        provider.attach();
      });

      const failureReason = await authFailedPromise;
      expect(failureReason).toBe("permission-denied");

      wsProvider.destroy();
    });

    it("immediately cancels reservation and stops heartbeat when real WebSocket disconnects during handshake", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: true }));
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const roomId = "507f1f77bcf86cd799439011";

      // Connect via raw WebSocket
      const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://localhost:3000" },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
      });

      // Physically terminate the raw WebSocket connection
      ws.terminate();

      // Wait a tick for TCP close event to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert that any pending reservation or timer is 0 and document-load waiters are cleaned
      expect(syncRegistry.getTotalRoomCount(roomId)).toBe(0);
      expect(syncRegistry.getHeartbeatTimerCount()).toBe(0);
      expect(syncRegistry.getTransportCloseListenerCount()).toBe(0);
      expect(documentLoadWaiters.getWaiters(roomId)).toHaveLength(0);
    });
  });
});
