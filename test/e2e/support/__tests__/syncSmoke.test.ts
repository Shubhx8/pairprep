import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";
import mongoose from "mongoose";
import type session from "express-session";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";

// Ensure test environment variables are set before imports read config
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] =
  process.env["SESSION_SECRET"] || "test_session_secret_at_least_32_characters_long";
process.env["MONGODB_URI"] =
  process.env["MONGODB_URI"] || "mongodb://127.0.0.1:27017/pairprep_test";

import {
  setupTestDb,
  teardownTestDb,
  clearTestDb,
} from "../../../../apps/server/src/__tests__/db/testDb.js";
import { UserModel } from "../../../../apps/server/src/models/users.js";
import { RoomModel } from "../../../../apps/server/src/models/rooms.js";
import { RoomMemberModel } from "../../../../apps/server/src/models/room_members.js";
import { guestRepo } from "../../../../apps/server/src/repos/guestRepo.js";
import { signGuestCookie } from "../../../../apps/server/src/middleware/identity.js";
import {
  SESSION_COOKIE_NAME,
  getSessionStore,
} from "../../../../apps/server/src/middleware/session.js";
import { config } from "../../../../apps/server/src/config.js";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../../../apps/server/src/sync/hocuspocus.js";
import { syncRegistry } from "../../../../apps/server/src/sync/syncRegistry.js";
import { resetPersistenceState } from "../../../../apps/server/src/sync/persistence.js";
import { isValidRoomId } from "../../../../apps/web/src/lib/roomId.js";

function signExpressSessionCookie(val: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}

describe("PairPrep T08 Phase 2 — Real Hocuspocus WebSocket Connection Smoke Test", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let port: number;

  const providersToCleanup: HocuspocusProvider[] = [];
  const wsProvidersToCleanup: HocuspocusProviderWebsocket[] = [];

  beforeAll(async () => {
    (config as { SESSION_SECRET?: string }).SESSION_SECRET =
      config.SESSION_SECRET || "test_session_secret_at_least_32_characters_long";
    await setupTestDb("sync_smoke_real");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    await clearTestDb();

    // Start real T07 Hocuspocus server on dynamic port
    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer();
    attachSyncServer(httpServer, syncServer);

    port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });
  });

  afterEach(async () => {
    for (const p of providersToCleanup) {
      try {
        p.destroy();
      } catch {
        // ignore
      }
    }
    providersToCleanup.length = 0;

    for (const ws of wsProvidersToCleanup) {
      try {
        ws.destroy();
      } catch {
        // ignore
      }
    }
    wsProvidersToCleanup.length = 0;

    // Allow in-flight disconnect hooks to settle
    await new Promise((r) => setTimeout(r, 50));

    if (syncServer) {
      try {
        await syncServer.destroy();
      } catch {
        // ignore
      }
      syncServer = null;
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }

    resetPersistenceState();
    syncRegistry.resetAll();
  });

  it("successfully connects, authenticates via session cookie, synchronizes Y.Doc, and edits", async () => {
    // 1. Seed real user, room, and membership in MongoDB
    const userId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    expect(isValidRoomId(roomId)).toBe(true);

    await UserModel.create({
      _id: userId,
      email: "engineer.alice@pairprep.com",
      displayName: "Alice Engineer",
      role: "user",
      provider: "github",
      providerId: `gh_${Date.now()}`,
    });

    await RoomModel.create({
      _id: roomId,
      title: "Real Collaborative Smoke Room",
      slug: "smoke-test-room-slug",
      type: "practice",
      status: "open",
      ownerId: userId,
      language: "javascript",
    });

    await RoomMemberModel.create({
      roomId,
      memberId: userId,
      displayName: "Alice Engineer",
      role: "editor",
      joinedAt: new Date(),
    });

    // 2. Seed active express session
    const store = getSessionStore();
    expect(store).not.toBeNull();
    const rawSid = `sess_alice_${Date.now()}`;

    await new Promise<void>((resolve, reject) => {
      store!.set(
        rawSid,
        {
          cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
          passport: { user: userId },
        } as unknown as session.SessionData,
        (err) => (err ? reject(err) : resolve())
      );
    });

    const secret = config.SESSION_SECRET || process.env["SESSION_SECRET"]!;
    const cookieHeader = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
      rawSid,
      secret
    )}`;

    // 3. WebSocketPolyfill simulating browser WebSocket sending same-origin cookie & origin
    class AuthenticatedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: cookieHeader,
          },
        });
      }
    }

    // 4. Connect via HocuspocusProvider
    const doc = new Y.Doc({ gc: false });
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: AuthenticatedWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    // 5. Verify provider connects and synchronizes
    let isAuthenticated = false;
    let isSynced = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Connection and synchronization timed out")),
        5000
      );

      provider.on("authenticated", () => {
        isAuthenticated = true;
      });

      provider.on("synced", ({ state }: { state: boolean }) => {
        if (state) {
          isSynced = true;
          clearTimeout(timer);
          resolve();
        }
      });

      provider.on("authenticationFailed", (data: { reason: string }) => {
        clearTimeout(timer);
        reject(new Error(`Authentication failed unexpectedly: ${data.reason}`));
      });

      provider.attach();
    });

    expect(isAuthenticated).toBe(true);
    expect(isSynced).toBe(true);
    expect(provider.configuration.name).toBe(roomId);
    expect(wsProvider.status).toBe(WebSocketStatus.Connected);

    // 6. Test real collaborative editing
    doc.getText("code").insert(0, "function solve() { return 42; }\n");
    expect(doc.getText("code").toString()).toBe("function solve() { return 42; }\n");

    // 7. Verify capacity registered in T07 server syncRegistry
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);

    // 8. Clean up provider and verify connection count drops
    provider.destroy();
    wsProvider.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
  });

  it("successfully connects and authenticates guest via signed guest cookie", async () => {
    const ownerId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    await UserModel.create({
      _id: ownerId,
      email: "owner@pairprep.com",
      displayName: "Room Owner",
      role: "user",
      provider: "github",
      providerId: `gh_${Date.now()}`,
    });

    await RoomModel.create({
      _id: roomId,
      title: "Guest Smoke Room",
      slug: "guest-smoke-room-slug",
      type: "practice",
      status: "open",
      ownerId,
      language: "python",
    });

    const guest = await guestRepo.createGuest("Guest Candidate", roomId);
    await RoomMemberModel.create({
      roomId,
      memberId: guest.id,
      displayName: "Guest Candidate",
      role: "editor",
      joinedAt: new Date(),
    });

    const guestCookie = `pairprep.guest=${signGuestCookie(guest.id)}`;

    class GuestWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: guestCookie,
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: GuestWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Guest connection timed out")),
        5000
      );

      provider.on("authenticated", () => {
        clearTimeout(timer);
        resolve();
      });

      provider.on("authenticationFailed", (data: { reason: string }) => {
        clearTimeout(timer);
        reject(new Error(`Guest auth failed: ${data.reason}`));
      });

      provider.attach();
    });

    expect(wsProvider.status).toBe(WebSocketStatus.Connected);
  });

  it("rejects unauthenticated connection attempts and triggers authenticationFailed", async () => {
    const roomId = new mongoose.Types.ObjectId().toHexString();

    class UnauthenticatedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            // Zero authentication cookies supplied
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: UnauthenticatedWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    const failureReason = await new Promise<string>((resolve) => {
      provider.on("authenticationFailed", (data: { reason: string }) => {
        resolve(data.reason);
      });
      provider.attach();
    });

    // Server throws "Authentication failed: unauthenticated", surfaced as failure reason
    expect(failureReason).toBe("unauthenticated");
  });

  it("server rejects room slug when used as document name instead of MongoDB ObjectId", async () => {
    class SlugWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: SlugWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: "practice-round-1-slug", // Room URL slug is not a valid 24-hex ObjectId
      document: doc,
    });
    providersToCleanup.push(provider);

    const failureReason = await new Promise<string>((resolve) => {
      provider.on("authenticationFailed", (data: { reason: string }) => {
        resolve(data.reason);
      });
      provider.attach();
    });

    expect(failureReason).toBe("permission-denied");
  });
});
