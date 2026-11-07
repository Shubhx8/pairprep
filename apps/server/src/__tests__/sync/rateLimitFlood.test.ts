import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { resetPersistenceState } from "../../sync/persistence.js";
import {
  ConnectionRateLimiter,
  RateLimitError,
} from "../../sync/connectionRateLimiter.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { config } from "../../config.js";

describe("T07 WebSocket Message Rate Limiting & Flood Defense", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let originalUri: string | undefined;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];
  const roomId = "507f1f77bcf86cd799439011";

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

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_ratelimit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
  });

  afterEach(async () => {
    for (const p of providers) {
      try {
        p.destroy();
      } catch {
        // ignore
      }
    }
    providers.length = 0;

    for (const wsp of wsProviders) {
      try {
        wsp.destroy();
      } catch {
        // ignore
      }
    }
    wsProviders.length = 0;

    // Allow in-flight disconnect and persistence hooks to settle
    await new Promise((r) => setTimeout(r, 100));

    if (syncServer) {
      try {
        await syncServer.destroy();
      } catch {
        // ignore
      }
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

  it("permits initial synchronization and normal collaborative typing without throttling", async () => {
    const rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 50,
      messageRefillPerSec: 25,
      maxByteBurst: 1024 * 1024,
      byteRefillPerSec: 512 * 1024,
    });

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const wsProvider = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProvider);

    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    providers.push(provider);
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Simulate normal collaborative typing (5 distinct typing events)
    for (let i = 0; i < 5; i++) {
      const len = clientDoc.getText("monaco").length;
      clientDoc.getText("monaco").insert(len, `char_${i} `);
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify document content was preserved and connection remains alive
    expect(clientDoc.getText("monaco").toString()).toBe(
      "char_0 char_1 char_2 char_3 char_4 "
    );
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);
    expect(rateLimiter.size).toBe(1);
  });

  it("terminates connection with close code 4029 when message flood exceeds burst capacity", async () => {
    // Low burst limit of 6 messages, 0 refill
    const rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 6,
      messageRefillPerSec: 0,
    });

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const wsProvider = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProvider);

    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    providers.push(provider);
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Capture disconnect event with code and reason
    const disconnectPromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        wsProvider.on(
          "disconnect",
          ({ event }: { event: { code: number; reason: string } }) => {
            resolve({
              code: event?.code,
              reason: typeof event?.reason === "string" ? event.reason : "",
            });
          }
        );
      }
    );

    // Flood the connection with rapid updates exceeding remaining tokens
    for (let i = 0; i < 20; i++) {
      clientDoc.getText("monaco").insert(0, `flood_${i}`);
    }

    const result = await disconnectPromise;
    expect(result.code).toBe(4029);
    expect(result.reason).toBe("message_rate_limit_exceeded");
  });

  it("terminates connection with code 4029 when awareness frame flood exceeds message rate limit", async () => {
    // Low burst limit of 6 messages
    const rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 6,
      messageRefillPerSec: 0,
    });

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const wsProvider = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProvider);

    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    providers.push(provider);
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const disconnectPromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        wsProvider.on(
          "disconnect",
          ({ event }: { event: { code: number; reason: string } }) => {
            resolve({
              code: event?.code,
              reason: typeof event?.reason === "string" ? event.reason : "",
            });
          }
        );
      }
    );

    // Flood awareness frames
    for (let i = 0; i < 20; i++) {
      provider.setAwarenessField("cursor", { x: i, y: i * 2, timestamp: Date.now() });
    }

    const result = await disconnectPromise;
    expect(result.code).toBe(4029);
    expect(result.reason).toBe("message_rate_limit_exceeded");
  });

  it("terminates connection with code 4029 when byte volume flood exceeds byte burst capacity", async () => {
    // Low byte burst capacity of 10 KB (10,240 bytes)
    const rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 100,
      messageRefillPerSec: 50,
      maxByteBurst: 10_240,
      byteRefillPerSec: 0,
    });

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const wsProvider = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProvider);

    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    providers.push(provider);
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const disconnectPromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        wsProvider.on(
          "disconnect",
          ({ event }: { event: { code: number; reason: string } }) => {
            resolve({
              code: event?.code,
              reason: typeof event?.reason === "string" ? event.reason : "",
            });
          }
        );
      }
    );

    // Send a large text insertion of ~15 KB (exceeding 10 KB byte burst capacity)
    const largePayload = "X".repeat(15_000);
    clientDoc.getText("monaco").insert(0, largePayload);

    const result = await disconnectPromise;
    expect(result.code).toBe(4029);
    expect(result.reason).toBe("byte_rate_limit_exceeded");
  });

  it("guarantees rejected flood messages do not mutate document or broadcast to peers", async () => {
    // Burst allows initial sync for both clients, but Client A flood will be rejected
    const rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 8,
      messageRefillPerSec: 0,
    });

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    // Client A (attacker)
    const wsProviderA = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProviderA);
    const docA = new Y.Doc();
    const providerA = new HocuspocusProvider({
      websocketProvider: wsProviderA,
      name: roomId,
      document: docA,
    });
    providers.push(providerA);
    providerA.attach();

    // Client B (innocent peer)
    const wsProviderB = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProviderB);
    const docB = new Y.Doc();
    const providerB = new HocuspocusProvider({
      websocketProvider: wsProviderB,
      name: roomId,
      document: docB,
    });
    providers.push(providerB);
    providerB.attach();

    await Promise.all([
      new Promise<void>((resolve) => providerA.on("synced", () => resolve())),
      new Promise<void>((resolve) => providerB.on("synced", () => resolve())),
    ]);

    // Initial valid edit from Client B
    docB.getText("monaco").insert(0, "legitimate_base_state;");
    await new Promise((r) => setTimeout(r, 100));

    expect(docA.getText("monaco").toString()).toBe("legitimate_base_state;");
    expect(docB.getText("monaco").toString()).toBe("legitimate_base_state;");

    const disconnectA = new Promise<{ code: number; reason: string }>((resolve) => {
      wsProviderA.on(
        "disconnect",
        ({ event }: { event: { code: number; reason: string } }) => {
          resolve({
            code: event?.code,
            reason: typeof event?.reason === "string" ? event.reason : "",
          });
        }
      );
    });

    // Client A floods
    for (let i = 0; i < 30; i++) {
      docA.getText("monaco").insert(0, `MALICIOUS_FLOOD_${i}_`);
    }

    const closeResult = await disconnectA;
    expect(closeResult.code).toBe(4029);

    // Wait to ensure no broadcast reached Client B
    await new Promise((r) => setTimeout(r, 200));

    // Client B should remain connected and unaffected
    expect(docB.getText("monaco").toString()).not.toContain("MALICIOUS_FLOOD_29");
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);
  });

  it("cleans up connection rate limiter state on disconnect", async () => {
    const rateLimiter = new ConnectionRateLimiter();

    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const wsProvider = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      maxAttempts: 1,
    });
    wsProviders.push(wsProvider);

    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    providers.push(provider);
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // State exists while connected
    expect(rateLimiter.size).toBe(1);

    // Disconnect
    provider.destroy();
    wsProvider.destroy();

    // Wait for onDisconnect hook to run
    await new Promise((r) => setTimeout(r, 200));

    // Rate limiter state is cleaned up
    expect(rateLimiter.size).toBe(0);
  });

  describe("ConnectionRateLimiter unit behavior", () => {
    it("refills message and byte tokens over time according to configured rates", () => {
      const limiter = new ConnectionRateLimiter({
        maxMessageBurst: 10,
        messageRefillPerSec: 5,
        maxByteBurst: 1000,
        byteRefillPerSec: 500,
      });

      const t0 = 1_000_000;
      // Consume 10 messages and 1000 bytes at t0
      for (let i = 0; i < 10; i++) {
        const res = limiter.consume("sock_1", 100, t0);
        expect(res.allowed).toBe(true);
      }

      // Next message at t0 should be rejected
      const rejectedAtT0 = limiter.consume("sock_1", 10, t0);
      expect(rejectedAtT0.allowed).toBe(false);

      // Advance time by 1 second (1000 ms) -> refills 5 messages and 500 bytes
      const t1 = t0 + 1000;
      const resAtT1 = limiter.consume("sock_1", 200, t1);
      expect(resAtT1.allowed).toBe(true);

      const state = limiter.get("sock_1");
      expect(state).toBeDefined();
      expect(state!.messageTokens).toBe(4); // 5 refilled - 1 consumed = 4
      expect(state!.byteTokens).toBe(300); // 500 refilled - 200 consumed = 300
    });

    it("prunes expired connections past entryTtlMs", () => {
      const limiter = new ConnectionRateLimiter({
        entryTtlMs: 5000,
      });

      const now = Date.now();
      limiter.consume("active_sock", 100, now);
      limiter.consume("idle_sock", 100, now - 6000);

      expect(limiter.size).toBe(2);

      const pruned = limiter.prune(now);
      expect(pruned).toBe(1);
      expect(limiter.has("active_sock")).toBe(true);
      expect(limiter.has("idle_sock")).toBe(false);
    });

    it("enforces maxEntries bound to prevent memory exhaustion", () => {
      const limiter = new ConnectionRateLimiter({
        maxEntries: 3,
        entryTtlMs: 100_000,
      });

      limiter.consume("sock_1", 10, 1000);
      limiter.consume("sock_2", 10, 1001);
      limiter.consume("sock_3", 10, 1002);
      expect(limiter.size).toBe(3);

      // 4th connection should evict oldest
      limiter.consume("sock_4", 10, 1003);
      expect(limiter.size).toBe(3);
      expect(limiter.has("sock_1")).toBe(false);
      expect(limiter.has("sock_4")).toBe(true);
    });

    it("creates RateLimitError with correct code and properties", () => {
      const err = new RateLimitError("message_rate_limit_exceeded");
      expect(err.code).toBe(4029);
      expect(err.reason).toBe("message_rate_limit_exceeded");
      expect(err.name).toBe("RateLimitError");
      expect(err.message).toContain("message_rate_limit_exceeded");
    });
  });
});
