import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { Socket as NetSocket } from "node:net";
import crypto from "node:crypto";
import WebSocket from "ws";
import type session from "express-session";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { UserModel } from "../../models/users.js";
import { userRepo } from "../../repos/userRepo.js";
import { guestRepo } from "../../repos/guestRepo.js";
import { config } from "../../config.js";
import * as sessionPrincipal from "../../auth/sessionPrincipal.js";
import {
  attachSocketServer,
  type SocketServerInstance,
  type SocketAuthErrorData,
} from "../../events/socketServer.js";
import {
  SocketHandshakeRateLimiter,
  resolveHandshakeIp,
} from "../../events/rateLimiter.js";
import { compileTrustFunction } from "../../config/proxyTrust.js";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";

import { signGuestCookie, GUEST_COOKIE_NAME } from "../../middleware/identity.js";
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

describe("T09 Phase 0 — Socket.IO Foundation Spike", () => {
  let httpServer: HttpServer | undefined;
  let socketServer: SocketServerInstance | undefined;
  let syncServer: SyncServerInstance | undefined;
  const activeClients: ClientSocket[] = [];
  let dbAvailable = false;

  beforeAll(async () => {
    (config as { SESSION_SECRET?: string }).SESSION_SECRET =
      config.SESSION_SECRET || "test_session_secret_at_least_32_characters_long";

    try {
      await setupTestDb("socket_foundation_spike");
      dbAvailable = true;
    } catch {
      // MongoDB unreachable outside CI/Docker - fall back to resolver spying for principal resolution
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await teardownTestDb();
    }
  });

  beforeEach(async () => {
    if (dbAvailable) {
      await clearTestDb();
    }
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Teardown any connected test clients
    for (const client of activeClients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    activeClients.length = 0;

    if (socketServer) {
      await socketServer.close();
      socketServer = undefined;
    }
    if (syncServer) {
      await syncServer.destroy();
      syncServer = undefined;
    }
    if (httpServer && httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = undefined;
    }
  });

  /**
   * Helper to start the HTTP server with Socket.IO attached.
   */
  async function startServer(): Promise<number> {
    httpServer = createServer();
    socketServer = attachSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
    return (httpServer.address() as { port: number }).port;
  }

  /**
   * Helper to seed a valid user session or configure resolver response.
   */
  async function seedUserSession(overrides?: { disabled?: boolean }): Promise<{
    userId: string;
    cookieHeader: string;
  }> {
    const rawSid = `sid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const cookieVal = signExpressSessionCookie(rawSid, config.SESSION_SECRET!);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieVal}`;

    if (dbAvailable) {
      const user = await userRepo.upsertUser({
        provider: "google",
        providerId: `user_${Date.now()}_${Math.random()}`,
        displayName: "Spike User",
        email: `spike_${Date.now()}@example.com`,
      });

      if (overrides?.disabled) {
        await UserModel.findByIdAndUpdate(user.id, { $set: { disabled: true } });
      }

      const store = getSessionStore();
      expect(store).not.toBeNull();

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

      return { userId: user.id, cookieHeader };
    }

    // Mock resolution when standalone MongoDB is not running
    const fakeUserId = "507f1f77bcf86cd799439011";
    if (overrides?.disabled) {
      vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
        success: false,
        reason: "disabled",
      });
    } else {
      vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
        success: true,
        principal: {
          type: "user",
          id: fakeUserId,
          displayName: "Spike User",
          role: "user",
          user: {
            id: fakeUserId,
            displayName: "Spike User",
            disabled: false,
            role: "user",
          } as unknown as import("../../models/users.js").IUser,
        },
      });
    }

    return { userId: fakeUserId, cookieHeader };
  }

  it("1. Allowed Origin and valid cookie connect successfully", async () => {
    const port = await startServer();
    const { userId, cookieHeader } = await seedUserSession();

    let serverPrincipalReceived: unknown;
    socketServer!.io.on("connection", (socket) => {
      serverPrincipalReceived = socket.data.principal;
    });

    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        origin: "http://localhost:3000",
        cookie: cookieHeader,
      },
    });
    activeClients.push(client);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timed out")), 5000);
      client.on("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      client.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(client.connected).toBe(true);
    expect(serverPrincipalReceived).toBeDefined();
    expect((serverPrincipalReceived as { id: string }).id).toBe(userId);
    expect((serverPrincipalReceived as { type: string }).type).toBe("user");
  });

  it("2. Disallowed Origin is rejected at admission layer", async () => {
    const port = await startServer();
    const { cookieHeader } = await seedUserSession();

    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        origin: "http://untrusted-evil.com",
        cookie: cookieHeader,
      },
    });
    activeClients.push(client);

    const error = await new Promise<Error>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Expected rejection timed out")),
        5000
      );
      client.on("connect", () => {
        clearTimeout(timeout);
        reject(new Error("Unexpected successful connection from disallowed origin"));
      });
      client.on("connect_error", (err) => {
        clearTimeout(timeout);
        resolve(err);
      });
    });

    expect(client.connected).toBe(false);
    expect(error.message).toMatch(/websocket error/i);
  });

  it("3. Missing Origin is rejected at admission layer", async () => {
    const port = await startServer();
    const { cookieHeader } = await seedUserSession();

    // Node.js client does not send Origin header unless explicitly specified in extraHeaders
    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        cookie: cookieHeader,
      },
    });
    activeClients.push(client);

    const error = await new Promise<Error>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Expected rejection timed out")),
        5000
      );
      client.on("connect", () => {
        clearTimeout(timeout);
        reject(new Error("Unexpected successful connection without Origin"));
      });
      client.on("connect_error", (err) => {
        clearTimeout(timeout);
        resolve(err);
      });
    });

    expect(client.connected).toBe(false);
    expect(error.message).toMatch(/websocket error/i);
  });

  describe("4. Authentication rejection via io.use middleware", () => {
    it("rejects connection with missing cookie as UNAUTHORIZED", async () => {
      const port = await startServer();

      const client = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
        },
      });
      activeClients.push(client);

      const error = await new Promise<Error & { data?: SocketAuthErrorData }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Expected rejection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            reject(new Error("Unexpected connection without cookie"));
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            resolve(err as Error & { data?: SocketAuthErrorData });
          });
        }
      );

      expect(client.connected).toBe(false);
      expect(error.message).toBe("Authentication required");
      expect(error.data).toEqual({
        code: "UNAUTHORIZED",
        reason: "unauthenticated",
      });
    });

    it("rejects connection with invalid signed session cookie as UNAUTHORIZED", async () => {
      const port = await startServer();

      if (!dbAvailable) {
        vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
          success: false,
          reason: "unauthenticated",
        });
      }

      const client = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
          cookie: `${SESSION_COOKIE_NAME}=s%3Afake_session_id.invalid_hmac_signature`,
        },
      });
      activeClients.push(client);

      const error = await new Promise<Error & { data?: SocketAuthErrorData }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Expected rejection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            reject(new Error("Unexpected connection with invalid cookie"));
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            resolve(err as Error & { data?: SocketAuthErrorData });
          });
        }
      );

      expect(client.connected).toBe(false);
      expect(error.message).toBe("Authentication required");
      expect(error.data).toEqual({
        code: "UNAUTHORIZED",
        reason: "unauthenticated",
      });
    });

    it("rejects connection as DB_UNAVAILABLE when database is down", async () => {
      const port = await startServer();

      vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
        success: false,
        reason: "db_unavailable",
      });

      const client = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
          cookie: `${SESSION_COOKIE_NAME}=some_cookie`,
        },
      });
      activeClients.push(client);

      const error = await new Promise<Error & { data?: SocketAuthErrorData }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Expected rejection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            reject(new Error("Unexpected connection when DB is unavailable"));
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            resolve(err as Error & { data?: SocketAuthErrorData });
          });
        }
      );

      expect(client.connected).toBe(false);
      expect(error.message).toBe("Database unavailable");
      expect(error.data).toEqual({
        code: "DB_UNAVAILABLE",
        reason: "db_unavailable",
      });
    });

    it("rejects connection for disabled user as ACCOUNT_DISABLED", async () => {
      const port = await startServer();
      const { cookieHeader } = await seedUserSession({ disabled: true });

      const client = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
          cookie: cookieHeader,
        },
      });
      activeClients.push(client);

      const error = await new Promise<Error & { data?: SocketAuthErrorData }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Expected rejection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            reject(new Error("Unexpected connection for disabled user"));
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            resolve(err as Error & { data?: SocketAuthErrorData });
          });
        }
      );

      expect(client.connected).toBe(false);
      expect(error.message).toBe("Account disabled");
      expect(error.data).toEqual({
        code: "ACCOUNT_DISABLED",
        reason: "disabled",
      });
    });

    it("authenticates valid guest cookie and attaches GuestPrincipal", async () => {
      const port = await startServer();
      const roomId = `room_spike_${Date.now()}`;
      const fakeGuestId = "607f1f77bcf86cd799439022";
      const rawGuestCookie = signGuestCookie(fakeGuestId);
      const cookieHeader = `${GUEST_COOKIE_NAME}=${rawGuestCookie}`;

      if (dbAvailable) {
        const guest = await guestRepo.createGuest("Guest Tester", roomId);
        const liveGuestCookie = signGuestCookie(guest.id);
        const liveCookieHeader = `${GUEST_COOKIE_NAME}=${liveGuestCookie}`;

        let serverPrincipalReceived: unknown;
        socketServer!.io.on("connection", (socket) => {
          serverPrincipalReceived = socket.data.principal;
        });

        const client = ioClient(`http://127.0.0.1:${port}`, {
          path: "/socket.io",
          transports: ["websocket"],
          auth: { roomId },
          extraHeaders: {
            origin: "http://localhost:3000",
            cookie: liveCookieHeader,
          },
        });
        activeClients.push(client);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Connection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            resolve();
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        expect(client.connected).toBe(true);
        expect(serverPrincipalReceived).toBeDefined();
        expect((serverPrincipalReceived as { type: string }).type).toBe("guest");
        expect((serverPrincipalReceived as { id: string }).id).toBe(guest.id);
        expect((serverPrincipalReceived as { roomId: string }).roomId).toBe(roomId);
      } else {
        vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
          success: true,
          principal: {
            type: "guest",
            id: fakeGuestId,
            displayName: "Guest Tester",
            roomId,
            guest: {
              id: fakeGuestId,
              displayName: "Guest Tester",
              roomId,
              expiresAt: new Date(Date.now() + 86400000),
            } as unknown as import("../../models/guests.js").IGuest,
          },
        });

        let serverPrincipalReceived: unknown;
        socketServer!.io.on("connection", (socket) => {
          serverPrincipalReceived = socket.data.principal;
        });

        const client = ioClient(`http://127.0.0.1:${port}`, {
          path: "/socket.io",
          transports: ["websocket"],
          auth: { roomId },
          extraHeaders: {
            origin: "http://localhost:3000",
            cookie: cookieHeader,
          },
        });
        activeClients.push(client);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Connection timed out")),
            5000
          );
          client.on("connect", () => {
            clearTimeout(timeout);
            resolve();
          });
          client.on("connect_error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        expect(client.connected).toBe(true);
        expect(serverPrincipalReceived).toBeDefined();
        expect((serverPrincipalReceived as { type: string }).type).toBe("guest");
        expect((serverPrincipalReceived as { id: string }).id).toBe(fakeGuestId);
        expect((serverPrincipalReceived as { roomId: string }).roomId).toBe(roomId);
      }
    });
  });

  it("5. Client and server close cleanly without hanging handles", async () => {
    const port = await startServer();
    const { cookieHeader } = await seedUserSession();

    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        origin: "http://localhost:3000",
        cookie: cookieHeader,
      },
    });
    activeClients.push(client);

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", reject);
    });

    expect(client.connected).toBe(true);

    // Clean client disconnect
    client.disconnect();
    expect(client.connected).toBe(false);

    // Clean server close
    await socketServer!.close();
    socketServer = undefined;

    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
    });
    expect(httpServer!.listening).toBe(false);
    httpServer = undefined;
  });

  it("6. Socket.IO does not interfere with the existing /sync upgrade handler", async () => {
    httpServer = createServer();
    // Attach both Hocuspocus /sync server AND Socket.IO /socket.io server to the SAME HTTP server
    syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));
    socketServer = attachSocketServer(httpServer);

    await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
    const port = (httpServer.address() as { port: number }).port;

    // 1. Verify Hocuspocus /sync continues to work
    const syncWs = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
      headers: {
        origin: "http://localhost:3000",
      },
    });

    const syncConnected = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Sync connection timed out")),
        5000
      );
      syncWs.on("open", () => {
        clearTimeout(timeout);
        resolve(true);
      });
      syncWs.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    expect(syncConnected).toBe(true);
    syncWs.close();

    // 2. Verify Socket.IO /socket.io continues to work on the same port
    const { cookieHeader } = await seedUserSession();
    const socketClient = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        origin: "http://localhost:3000",
        cookie: cookieHeader,
      },
    });
    activeClients.push(socketClient);

    const socketConnected = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Socket.IO connection timed out")),
        5000
      );
      socketClient.on("connect", () => {
        clearTimeout(timeout);
        resolve(true);
      });
      socketClient.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    expect(socketConnected).toBe(true);
  });

  describe("7. Handshake Admission Rate Limiting (IP-based, 60/min)", () => {
    function createMockRequest(options: {
      remoteAddress?: string;
      headers?: Record<string, string>;
    }): IncomingMessage {
      const socket = {
        remoteAddress: options.remoteAddress,
      } as unknown as NetSocket;

      return {
        socket,
        connection: socket,
        headers: options.headers ?? {},
      } as unknown as IncomingMessage;
    }

    it("Scenario 1: First handshake attempt is accepted", () => {
      const limiter = new SocketHandshakeRateLimiter();
      expect(limiter.consume("192.0.2.1")).toBe(true);
      expect(limiter.getRemainingAttempts("192.0.2.1")).toBe(59);
      expect(limiter.isRateLimited("192.0.2.1")).toBe(false);
    });

    it("Scenario 2: Requests below the limit (attempts 1 to 59) are accepted", () => {
      const limiter = new SocketHandshakeRateLimiter();
      for (let i = 1; i <= 59; i++) {
        expect(limiter.consume("192.0.2.2")).toBe(true);
        expect(limiter.getRemainingAttempts("192.0.2.2")).toBe(60 - i);
      }
      expect(limiter.isRateLimited("192.0.2.2")).toBe(false);
    });

    it("Scenario 3: Exactly 60 attempts are handled according to documented counting policy", () => {
      const limiter = new SocketHandshakeRateLimiter();
      for (let i = 1; i <= 60; i++) {
        expect(limiter.consume("192.0.2.3")).toBe(true);
      }
      expect(limiter.getRemainingAttempts("192.0.2.3")).toBe(0);
      expect(limiter.isRateLimited("192.0.2.3")).toBe(true);
    });

    it("Scenario 4: Attempt 61 is rejected within the same window", () => {
      const limiter = new SocketHandshakeRateLimiter();
      for (let i = 1; i <= 60; i++) {
        limiter.consume("192.0.2.4");
      }
      // Attempt 61 rejected
      expect(limiter.consume("192.0.2.4")).toBe(false);
      expect(limiter.getRemainingAttempts("192.0.2.4")).toBe(0);
      expect(limiter.isRateLimited("192.0.2.4")).toBe(true);
    });

    it("Scenario 5: Counter expiration after 60s permits new attempts", () => {
      const limiter = new SocketHandshakeRateLimiter({ windowMs: 60_000 });
      const t0 = 1_000_000;
      for (let i = 1; i <= 60; i++) {
        expect(limiter.consume("192.0.2.5", t0)).toBe(true);
      }
      expect(limiter.consume("192.0.2.5", t0 + 30_000)).toBe(false);

      // Window expires at t0 + 60_001 ms
      const tAfter = t0 + 60_001;
      expect(limiter.isRateLimited("192.0.2.5", tAfter)).toBe(false);
      expect(limiter.consume("192.0.2.5", tAfter)).toBe(true);
      expect(limiter.getRemainingAttempts("192.0.2.5", tAfter)).toBe(59);
    });

    it("Scenario 6: Separate IP addresses have independent counters", () => {
      const limiter = new SocketHandshakeRateLimiter();
      const ipA = "192.0.2.10";
      const ipB = "198.51.100.20";

      // Exhaust IP A
      for (let i = 1; i <= 60; i++) {
        limiter.consume(ipA);
      }
      expect(limiter.consume(ipA)).toBe(false);
      expect(limiter.isRateLimited(ipA)).toBe(true);

      // IP B remains unaffected
      expect(limiter.isRateLimited(ipB)).toBe(false);
      expect(limiter.getRemainingAttempts(ipB)).toBe(60);
      expect(limiter.consume(ipB)).toBe(true);
      expect(limiter.getRemainingAttempts(ipB)).toBe(59);
    });

    it("Scenario 7: Concurrent attempts cannot bypass the limit", async () => {
      const limiter = new SocketHandshakeRateLimiter();
      const ip = "203.0.113.50";

      // Fire 100 concurrent requests
      const results = await Promise.all(
        Array.from({ length: 100 }).map(() => Promise.resolve(limiter.consume(ip)))
      );

      const accepted = results.filter((r) => r === true).length;
      const rejected = results.filter((r) => r === false).length;

      expect(accepted).toBe(60);
      expect(rejected).toBe(40);
      expect(limiter.isRateLimited(ip)).toBe(true);
    });

    it("Scenario 8: Missing IP behavior is safe", () => {
      const limiter = new SocketHandshakeRateLimiter();

      // resolveHandshakeIp handles undefined/null safely
      expect(resolveHandshakeIp(undefined)).toBe("unknown");
      expect(resolveHandshakeIp(null)).toBe("unknown");

      // Limiter handles undefined/null safely without throwing
      expect(limiter.consume(undefined)).toBe(true);
      expect(limiter.consume(null)).toBe(true);
      expect(limiter.getTrackedIpCount()).toBe(1);
    });

    it("Scenario 9: Invalid/malformed IP behavior is safe", () => {
      const limiter = new SocketHandshakeRateLimiter();

      // Malformed request with invalid remoteAddress safely falls back
      const malformedReq = createMockRequest({ remoteAddress: "invalid-not-an-ip" });
      const resolved = resolveHandshakeIp(malformedReq);
      expect(resolved).toBe("127.0.0.1");

      // Limiter handles malformed string safely
      expect(limiter.consume("invalid-ip-string-###")).toBe(true);
      expect(limiter.isRateLimited("invalid-ip-string-###")).toBe(false);
    });

    it("Scenario 10: Trusted proxy configuration is respected", () => {
      const trustLoopback = compileTrustFunction(["127.0.0.1"]);
      const req = createMockRequest({
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": "203.0.113.195",
        },
      });

      const clientIp = resolveHandshakeIp(req, trustLoopback);
      expect(clientIp).toBe("203.0.113.195");
    });

    it("Scenario 11: Untrusted forwarded headers cannot spoof client IP", () => {
      const trustLoopback = compileTrustFunction(["127.0.0.1"]);
      // Connection directly from untrusted public IP 198.51.100.1 with spoofed header
      const req = createMockRequest({
        remoteAddress: "198.51.100.1",
        headers: {
          "x-forwarded-for": "203.0.113.195",
        },
      });

      const clientIp = resolveHandshakeIp(req, trustLoopback);
      expect(clientIp).toBe("198.51.100.1");
    });

    it("Scenario 12: Rejected handshakes do not reach Socket.IO connection handlers or middleware", async () => {
      const customLimiter = new SocketHandshakeRateLimiter({ maxAttempts: 1 });
      httpServer = createServer();
      socketServer = attachSocketServer(httpServer, { rateLimiter: customLimiter });
      await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
      const port = (httpServer.address() as { port: number }).port;

      const { cookieHeader } = await seedUserSession();

      let middlewareCalls = 0;
      let connectionCalls = 0;

      socketServer.io.use((_socket, next) => {
        middlewareCalls++;
        next();
      });

      socketServer.io.on("connection", () => {
        connectionCalls++;
      });

      // Attempt 1: Should succeed (under limit 1)
      const client1 = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
          cookie: cookieHeader,
        },
      });
      activeClients.push(client1);

      await new Promise<void>((resolve, reject) => {
        client1.on("connect", resolve);
        client1.on("connect_error", reject);
      });

      expect(client1.connected).toBe(true);
      expect(middlewareCalls).toBe(1);
      expect(connectionCalls).toBe(1);

      // Attempt 2: Exceeds rate limit (attempt 2 > maxAttempts 1)
      const client2 = ioClient(`http://127.0.0.1:${port}`, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: {
          origin: "http://localhost:3000",
          cookie: cookieHeader,
        },
      });
      activeClients.push(client2);

      const err = await new Promise<Error>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Expected rate limit rejection timed out")),
          5000
        );
        client2.on("connect", () => {
          clearTimeout(timeout);
          reject(new Error("Unexpected successful connection beyond rate limit"));
        });
        client2.on("connect_error", (error) => {
          clearTimeout(timeout);
          resolve(error);
        });
      });

      expect(client2.connected).toBe(false);
      expect(err.message).toMatch(/websocket error/i);

      // Middleware and connection handler must NOT have been called for rejected attempt 2!
      expect(middlewareCalls).toBe(1);
      expect(connectionCalls).toBe(1);
    });

    it("Memory bounds: Enforces maxEntries limit with LRU eviction and expiration pruning", () => {
      const limiter = new SocketHandshakeRateLimiter({
        maxAttempts: 10,
        maxEntries: 5,
        windowMs: 60_000,
      });

      const t0 = 100_000;
      // Add 5 distinct IPs
      for (let i = 1; i <= 5; i++) {
        limiter.consume(`10.0.0.${i}`, t0);
      }
      expect(limiter.getTrackedIpCount()).toBe(5);

      // Advance time so that entries expire
      const t1 = t0 + 60_001;
      // Add a 6th IP at t1; expired entries are pruned, keeping entry count bounded
      limiter.consume("10.0.0.6", t1);
      expect(limiter.getTrackedIpCount()).toBeLessThanOrEqual(5);
    });
  });
});
