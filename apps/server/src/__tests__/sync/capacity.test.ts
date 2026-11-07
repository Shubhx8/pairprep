import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";
import { userRepo } from "../../repos/userRepo.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { getSessionStore } from "../../middleware/session.js";
import { config } from "../../config.js";
import crypto from "node:crypto";

function signCookieValue(val: string, secret: string): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${hmac}`;
}

describe("T07 Capacity & Reservation Enforcement (ROOM-4)", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];

  class BrowserLikeWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[], options?: object) {
      super(url, protocols, {
        ...options,
        headers: {
          origin: "http://localhost:3000",
          ...((options as { headers?: Record<string, string> })?.headers || {}),
        },
      });
    }
  }

  let originalUri: string | undefined;

  beforeEach(async () => {
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_cap_outer_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
  });

  afterEach(async () => {
    for (const provider of providers) {
      try {
        provider.destroy();
      } catch {
        // ignore
      }
    }
    providers.length = 0;

    for (const wsProvider of wsProviders) {
      try {
        wsProvider.destroy();
      } catch {
        // ignore
      }
    }
    wsProviders.length = 0;

    if (syncServer) {
      await syncServer.destroy();
      syncServer = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db?.dropDatabase();
      } catch {
        // ignore
      }
      await mongoose.disconnect();
    }
    (config as { MONGODB_URI?: string }).MONGODB_URI = originalUri;
    syncRegistry.resetAll();
  });

  it("ROOM-4: allows exactly 6 simultaneous connections and rejects the 7th attempt", async () => {
    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Server not listening");
    const port = addr.port;
    const wsUrl = `ws://127.0.0.1:${port}/sync`;
    const roomId = "507f1f77bcf86cd799439011";

    const connectionPromises: Promise<void>[] = [];

    // Attempt 6 connections simultaneously
    for (let i = 0; i < 6; i++) {
      const wsProvider = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsProvider);

      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        websocketProvider: wsProvider,
        name: roomId,
        document: doc,
      });
      providers.push(provider);

      connectionPromises.push(
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Connection ${i + 1} timed out`)),
            3000
          );
          provider.on("authenticated", () => {
            clearTimeout(timeout);
            resolve();
          });
          provider.on("authenticationFailed", (err: { reason: string }) => {
            clearTimeout(timeout);
            reject(new Error(`Auth failed: ${err.reason}`));
          });
        })
      );
      provider.attach();
    }

    // All 6 connections must succeed
    await Promise.all(connectionPromises);
    for (let i = 0; i < 20; i++) {
      if (syncRegistry.getRoomConnectionCount(roomId) === 6) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(6);

    // Now attempt a 7th simultaneous connection to the same room
    const wsProvider7 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(wsProvider7);

    const doc7 = new Y.Doc();
    const provider7 = new HocuspocusProvider({
      websocketProvider: wsProvider7,
      name: roomId,
      document: doc7,
    });
    providers.push(provider7);

    const rejectedReason = await new Promise<string>((resolve) => {
      provider7.on("authenticationFailed", (event: { reason: string }) => {
        resolve(event.reason);
      });
      provider7.on("authenticated", () => {
        resolve("unexpectedly_authenticated");
      });
      provider7.attach();
    });

    expect(rejectedReason).toBe("room_capacity_exceeded");
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(6);

    // Now disconnect 1 active connection (connection 0)
    providers[0]!.destroy();
    wsProviders[0]!.destroy();

    // Wait briefly for unregisterConnection to process
    await new Promise((r) => setTimeout(r, 50));
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(5);

    // Now a new connection attempt must succeed
    const wsProvider8 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(wsProvider8);

    const doc8 = new Y.Doc();
    const provider8 = new HocuspocusProvider({
      websocketProvider: wsProvider8,
      name: roomId,
      document: doc8,
    });
    providers.push(provider8);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection 8 timed out")), 3000);
      provider8.on("authenticated", () => {
        clearTimeout(timeout);
        resolve();
      });
      provider8.on("authenticationFailed", (err: { reason: string }) => {
        clearTimeout(timeout);
        reject(new Error(`Connection 8 rejected: ${err.reason}`));
      });
      provider8.attach();
    });

    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(6);
  });

  describe("Authenticated Per-Member Limits & DB Failure Paths", () => {
    let testDbName: string;
    let originalUri: string | undefined;

    beforeEach(async () => {
      originalUri = config.MONGODB_URI;
      testDbName = `pairprep_cap_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const testUri = `mongodb://127.0.0.1:27017/${testDbName}`;
      (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
      await mongoose.connect(testUri);
    });

    afterEach(async () => {
      if (mongoose.connection.readyState === 1) {
        try {
          await mongoose.connection.db?.dropDatabase();
        } catch {
          // ignore
        }
        await mongoose.disconnect();
      }
      (config as { MONGODB_URI?: string }).MONGODB_URI = originalUri;
    });

    it("enforces max 3 connections per member within the room and releases slot on failed auth", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(
        httpServer,
        createSyncServer({ requireAuth: true })
      );

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Server not listening");
      const port = addr.port;
      const wsUrl = `ws://127.0.0.1:${port}/sync`;

      // 1. Create a user and a room with that user as owner/member
      const user = await userRepo.upsertUser({
        provider: "github",
        providerId: "gh_cap_1",
        displayName: "Capacity Member",
        email: "cap@example.com",
      });

      const room = await roomRepo.createRoom({
        title: "Capacity Test Room",
        type: "practice",
        language: "python",
        ownerId: user.id,
      });
      const roomId = room.id;

      // Add user as room member
      await roomMemberRepo.addMember({
        roomId,
        memberId: user.id,
        displayName: user.displayName,
        role: "owner",
      });

      // Set up valid session cookie
      const store = getSessionStore();
      const rawSid = `sid_${Date.now()}`;
      await new Promise<void>((resolve, reject) => {
        store!.set(
          rawSid,
          { passport: { user: user.id } } as unknown as import("express-session").SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      });
      const signedSid = signCookieValue(rawSid, config.SESSION_SECRET!);
      const validCookieHeader = `pairprep.sid=${signedSid}`;

      class AuthWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: validCookieHeader,
            },
          });
        }
      }

      // Connect 3 times with the same member
      for (let i = 0; i < 3; i++) {
        const wsProvider = new HocuspocusProviderWebsocket({
          url: wsUrl,
          WebSocketPolyfill: AuthWebSocket as unknown as typeof WebSocket,
        });
        wsProviders.push(wsProvider);

        const doc = new Y.Doc();
        const provider = new HocuspocusProvider({
          websocketProvider: wsProvider,
          name: roomId,
          document: doc,
        });
        providers.push(provider);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Conn ${i + 1} timed out`)), 3000);
          provider.on("authenticated", () => {
            clearTimeout(timeout);
            resolve();
          });
          provider.on("authenticationFailed", (err: { reason: string }) => {
            clearTimeout(timeout);
            reject(new Error(`Auth failed: ${err.reason}`));
          });
          provider.attach();
        });
      }

      expect(syncRegistry.getMemberConnectionCount(roomId, user.id)).toBe(3);
      expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(3);

      // 4th connection for the same member is rejected with member_connection_limit_exceeded
      const wsProvider4 = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: AuthWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsProvider4);

      const doc4 = new Y.Doc();
      const provider4 = new HocuspocusProvider({
        websocketProvider: wsProvider4,
        name: roomId,
        document: doc4,
      });
      providers.push(provider4);

      const fourthReason = await new Promise<string>((resolve) => {
        provider4.on("authenticationFailed", (err: { reason: string }) => {
          resolve(err.reason);
        });
        provider4.on("authenticated", () => {
          resolve("unexpectedly_authenticated");
        });
        provider4.attach();
      });

      expect(fourthReason).toBe("member_connection_limit_exceeded");
      expect(syncRegistry.getMemberConnectionCount(roomId, user.id)).toBe(3);
      expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(3);

      // Verify that a failed authentication attempt (e.g. invalid cookie) does NOT leak a reservation slot
      class BadAuthWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: "pairprep.sid=s:invalid.signature",
            },
          });
        }
      }

      const wsProviderBad = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BadAuthWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsProviderBad);

      const docBad = new Y.Doc();
      const providerBad = new HocuspocusProvider({
        websocketProvider: wsProviderBad,
        name: roomId,
        document: docBad,
      });
      providers.push(providerBad);

      const badReason = await new Promise<string>((resolve) => {
        providerBad.on("authenticationFailed", (err: { reason: string }) => {
          resolve(err.reason);
        });
        providerBad.on("authenticated", () => {
          resolve("unexpectedly_authenticated");
        });
        providerBad.attach();
      });

      expect(badReason).toBe("unauthenticated");
      // Reservation slot was cleanly released; total room count is still 3
      expect(syncRegistry.getTotalRoomCount(roomId)).toBe(3);
    });
  });
});
