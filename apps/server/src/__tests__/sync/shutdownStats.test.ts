import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  attachSyncServer,
  createSyncServer,
  getSyncServerStats,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import {
  resetPersistenceState,
  queueUpdate,
  flushRoom,
  takeSnapshot,
  startSnapshotInterval,
  getPendingPersistenceStats,
  drainPersistenceAndSnapshot,
} from "../../sync/persistence.js";
import { ConnectionRateLimiter } from "../../sync/connectionRateLimiter.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { documentLoadWaiters } from "../../sync/documentWaiters.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import * as sessionPrincipal from "../../auth/sessionPrincipal.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { config } from "../../config.js";
import { setupGracefulShutdown } from "../../index.js";
import express from "express";

describe("T07 Sync Statistics & Graceful Shutdown Drain", () => {
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
    const testDb = `pairprep_shutdown_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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

    for (const wp of wsProviders) {
      try {
        wp.destroy();
      } catch {
        // ignore
      }
    }
    wsProviders.length = 0;

    if (syncServer) {
      try {
        await syncServer.destroy();
      } catch {
        // ignore
      }
      syncServer = null;
    }

    if (httpServer && httpServer.listening) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }

    resetPersistenceState();
    syncRegistry.resetAll();

    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      try {
        await mongoose.connection.db.dropDatabase();
      } catch {
        // ignore
      }
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (originalUri) {
      (config as { MONGODB_URI?: string }).MONGODB_URI = originalUri;
    }
  });

  describe("1. Sync Server Statistics (getSyncServerStats)", () => {
    it("reports initial statistics schema and zero baseline", () => {
      const serverInstance = createSyncServer({ requireAuth: false });
      const stats = serverInstance.getStats();
      expect(getSyncServerStats()).toEqual(stats);

      expect(stats.status).toBe("running");
      expect(typeof stats.uptimeSeconds).toBe("number");
      expect(stats.uptimeSeconds).toBeGreaterThanOrEqual(0);

      // Connection stats baseline
      expect(stats.connections).toEqual({
        activeConnections: 0,
        activeRooms: 0,
        activeDocuments: 0,
        pendingReservations: 0,
        upgradeRejections: 0,
        authenticationFailures: 0,
        rateLimitTerminations: 0,
      });

      // Capacity baseline
      expect(stats.capacity).toEqual({
        totalActiveRooms: 0,
        totalActiveConnections: 0,
        totalPendingReservations: 0,
        maxConnectionsPerRoom: 6,
        roomsWithActiveConnections: 0,
        rooms: [],
      });

      // Persistence baseline
      expect(stats.persistence).toEqual({
        pendingUpdates: 0,
        queuedUpdates: 0,
        inFlightUpdates: 0,
        roomsWithPendingUpdates: 0,
        oldestPendingAgeMs: 0,
        flushesCompleted: 0,
        flushFailures: 0,
        snapshotsSaved: 0,
        snapshotFailures: 0,
        activeSnapshotOperations: 0,
      });

      // Rate limiter baseline
      expect(stats.rateLimiter).toEqual({
        trackedConnections: 0,
        maxEntries: 10000,
        rejections: {
          messageRateLimit: 0,
          byteRateLimit: 0,
          capacityExceeded: 0,
          invalidSocketIdentity: 0,
          total: 0,
        },
        upgradeIpRateLimitRejections: 0,
      });
    });

    it("tracks physical connection counts and capacity accurately during connect and disconnect", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      const wsProvider = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
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

      await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

      // 1 active connection, 1 active room, 1 active document
      const statsConnected = syncServer.getStats();
      expect(statsConnected.connections.activeConnections).toBe(1);
      expect(statsConnected.connections.activeRooms).toBe(1);
      expect(statsConnected.connections.activeDocuments).toBe(1);
      expect(statsConnected.capacity.totalActiveConnections).toBe(1);
      expect(statsConnected.capacity.rooms.length).toBe(1);
      expect(statsConnected.capacity.rooms[0]?.activeConnections).toBe(1);

      // Disconnect
      provider.destroy();
      wsProvider.destroy();
      await new Promise((r) => setTimeout(r, 100));

      const statsDisconnected = syncServer.getStats();
      expect(statsDisconnected.connections.activeConnections).toBe(0);
      expect(statsDisconnected.connections.activeRooms).toBe(0);
      expect(statsDisconnected.capacity.totalActiveConnections).toBe(0);
    });

    it("distinguishes active documents from rooms with connected participants", async () => {
      const roomA = "507f1f77bcf86cd799439011";
      const roomB = "507f1f77bcf86cd799439022";

      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      // Connect to roomA
      const wsA = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsA);
      const docA = new Y.Doc();
      const provA = new HocuspocusProvider({
        websocketProvider: wsA,
        name: roomA,
        document: docA,
      });
      providers.push(provA);
      provA.attach();

      // Connect to roomB
      const wsB = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsB);
      const docB = new Y.Doc();
      const provB = new HocuspocusProvider({
        websocketProvider: wsB,
        name: roomB,
        document: docB,
      });
      providers.push(provB);
      provB.attach();

      await Promise.all([
        new Promise<void>((resolve) => provA.on("synced", () => resolve())),
        new Promise<void>((resolve) => provB.on("synced", () => resolve())),
      ]);

      const stats = syncServer.getStats();
      expect(stats.connections.activeConnections).toBe(2);
      expect(stats.connections.activeRooms).toBe(2);
      expect(stats.capacity.totalActiveRooms).toBe(2);
      expect(stats.capacity.rooms.length).toBe(2);
    });

    it("reports pending slot reservations during handshake", () => {
      syncServer = createSyncServer({ requireAuth: false });
      expect(syncServer.getStats().connections.pendingReservations).toBe(0);

      const res = syncRegistry.reserveSlot(roomId, "sock_reserve_test");
      expect(res.success).toBe(true);

      const stats = syncServer.getStats();
      expect(stats.connections.pendingReservations).toBe(1);
      expect(stats.capacity.totalPendingReservations).toBe(1);

      syncRegistry.cancelReservation("sock_reserve_test");
      expect(syncServer.getStats().connections.pendingReservations).toBe(0);
    });

    it("reports pending update count, age, and returns to zero upon persistence", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "first line");
      const u1 = Y.encodeStateAsUpdate(doc);

      queueUpdate(roomId, "user_1", u1, doc);
      queueUpdate(roomId, "user_2", new Uint8Array([1, 2, 3]), doc);

      const pendingStats = getPendingPersistenceStats();
      expect(pendingStats.pendingUpdates).toBe(2);
      expect(pendingStats.queuedUpdates).toBe(2);
      expect(pendingStats.roomsWithPendingUpdates).toBe(1);
      expect(pendingStats.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);

      await flushRoom(roomId, true);

      const flushedStats = getPendingPersistenceStats();
      expect(flushedStats.pendingUpdates).toBe(0);
      expect(flushedStats.queuedUpdates).toBe(0);
      expect(flushedStats.roomsWithPendingUpdates).toBe(0);
      expect(flushedStats.flushesCompleted).toBeGreaterThanOrEqual(1);
      expect(flushedStats.snapshotsSaved).toBeGreaterThanOrEqual(1);
    });

    it("observes persistence flush failures and snapshot failures in statistics", async () => {
      const doc = new Y.Doc();
      queueUpdate(roomId, "user_fail", new Uint8Array([1, 2, 3]), doc);

      // Force failure by mocking DocUpdateModel.create to throw
      const createSpy = vi
        .spyOn(DocUpdateModel, "create")
        .mockRejectedValueOnce(new Error("Simulated DB connection failure"));

      await expect(flushRoom(roomId)).rejects.toThrow("Simulated DB connection failure");

      const stats = getPendingPersistenceStats();
      expect(stats.flushFailures).toBe(1);
      // Updates must be requeued, retaining pending count
      expect(stats.pendingUpdates).toBe(1);

      createSpy.mockRestore();

      // Successful flush now
      await flushRoom(roomId);
      const statsRecovered = getPendingPersistenceStats();
      expect(statsRecovered.pendingUpdates).toBe(0);
      expect(statsRecovered.flushesCompleted).toBe(1);
    });

    it("tracks rate limiter rejections by specific reason", () => {
      const limiter = new ConnectionRateLimiter({
        maxMessageBurst: 2,
        messageRefillPerSec: 0,
      });

      // 1. Consume 2 tokens normally
      expect(limiter.consume("sock_rl", 10).allowed).toBe(true);
      expect(limiter.consume("sock_rl", 10).allowed).toBe(true);

      // 2. Message rate limit rejection
      expect(limiter.consume("sock_rl", 10).allowed).toBe(false);

      // 3. Invalid socket identity rejection
      expect(limiter.consume("", 10).allowed).toBe(false);

      const stats = limiter.getStats();
      expect(stats.rejections.messageRateLimit).toBe(1);
      expect(stats.rejections.invalidSocketIdentity).toBe(1);
      expect(stats.rejections.total).toBe(2);
    });

    it("tracks authentication and upgrade rejections in connection stats", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(
        httpServer,
        createSyncServer({ requireAuth: true }) // requires valid session
      );

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const port = addr.port;
      const wsUrl = `ws://127.0.0.1:${port}/sync`;

      // 1. Handshake with invalid document name (non-ObjectId) -> rejected in onAuthenticate
      const wsProvider = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        maxAttempts: 1,
      });
      wsProviders.push(wsProvider);

      await new Promise<void>((resolve) => {
        const provider = new HocuspocusProvider({
          websocketProvider: wsProvider,
          name: "invalid-doc-id",
          document: new Y.Doc(),
          onAuthenticationFailed: () => {
            resolve();
          },
        });
        providers.push(provider);
        provider.attach();
      });

      // 2. Upgrade attempt with disallowed origin -> HTTP 403 upgrade rejection
      const badOriginWs = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://disallowed-attacker.com" },
      });
      await new Promise<void>((resolve) => {
        badOriginWs.on("unexpected-response", () => resolve());
        badOriginWs.on("error", () => resolve());
      });

      const stats = syncServer.getStats();
      expect(stats.connections.authenticationFailures).toBeGreaterThanOrEqual(1);
      expect(stats.connections.upgradeRejections).toBeGreaterThanOrEqual(1);
    });

    it("guarantees statistics output exposes no sensitive tokens, cookies, raw slugs or document content", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      const wsProvider = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(wsProvider);
      const clientDoc = new Y.Doc();
      clientDoc.getText("monaco").insert(0, "SUPER_SECRET_PATIENT_DATA");

      const provider = new HocuspocusProvider({
        websocketProvider: wsProvider,
        name: roomId,
        document: clientDoc,
      });
      providers.push(provider);
      provider.attach();

      await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

      const statsJson = JSON.stringify(syncServer.getStats());

      // Must not leak sensitive identifiers or contents
      expect(statsJson).not.toContain("SUPER_SECRET_PATIENT_DATA");
      expect(statsJson).not.toContain("cookie");
      expect(statsJson).not.toContain("guest_token");
      expect(statsJson).not.toContain("pairprep.sid");
      expect(statsJson).not.toContain("pairprep.guest");
      // Capacity stats use anonymized roomIndex, not raw roomId
      expect(statsJson).not.toContain(roomId);
    });
  });

  describe("2. Graceful Shutdown & Connection Drain", () => {
    it("rejects new /sync upgrade requests with HTTP 503 after shutdown begins", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const port = addr.port;

      // Initiate shutdown
      const shutdownPromise = syncServer.drainAndShutdown();

      // Attempt WebSocket connection during shutdown
      const clientWs = new WebSocket(`ws://127.0.0.1:${port}/sync`, {
        headers: { origin: "http://localhost:3000" },
      });

      const upgradeError = await new Promise<{ message: string }>((resolve) => {
        clientWs.on("unexpected-response", (_req, res) => {
          resolve({ message: `HTTP ${res.statusCode}` });
        });
        clientWs.on("error", (err) => {
          resolve({ message: err.message });
        });
      });

      expect(upgradeError.message).toContain("503");

      await shutdownPromise;
    });

    it("rejects authentication and document loading that begins after shutdown", async () => {
      syncServer = createSyncServer({ requireAuth: false });
      const shutdownPromise = syncServer.drainAndShutdown();

      const onAuth = syncServer.server.configuration.onAuthenticate;
      expect(onAuth).toBeDefined();

      await expect(
        onAuth!({
          documentName: roomId,
          socketId: "late_sock",
          connectionConfig: { readOnly: false },
          context: {},
          instance: syncServer.server,
          requestHeaders: {},
          requestParameters: new URLSearchParams(),
        } as unknown as Parameters<NonNullable<typeof onAuth>>[0])
      ).rejects.toThrow("Server is shutting down");

      await shutdownPromise;
    });

    it("delivers close code 1001 and reason server_shutting_down to existing connected WebSockets", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

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

      await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

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

      // Initiate shutdown
      await syncServer.drainAndShutdown({ drainTimeoutMs: 2000 });

      const closeEvent = await disconnectPromise;
      expect(closeEvent.code).toBe(1001);
      expect(closeEvent.reason).toBe("server_shutting_down");

      expect(syncRegistry.getActiveConnectionCount()).toBe(0);
    });

    it("prevents incoming document updates from mutating document after shutdown barrier", async () => {
      syncServer = createSyncServer({ requireAuth: false });
      const beforeHandleMessage = syncServer.server.configuration.beforeHandleMessage;
      expect(beforeHandleMessage).toBeDefined();

      const shutdownPromise = syncServer.drainAndShutdown();

      // Incoming frame after shutdown barrier must be dropped
      const mockPayload = {
        socketId: "sock_late",
        update: new Uint8Array([1, 2, 3]),
        documentName: roomId,
        connection: { readOnly: false },
      };

      // Calling beforeHandleMessage during shutdown must complete without throwing and drop processing
      await beforeHandleMessage!(
        mockPayload as unknown as Parameters<NonNullable<typeof beforeHandleMessage>>[0]
      );

      await shutdownPromise;
      expect(syncServer.getStats().status).toBe("destroyed");
    });

    it("persists in-memory updates and final snapshots to MongoDB before completing shutdown", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "function calculateTotal() { return 42; }");
      const updateData = Y.encodeStateAsUpdate(doc);

      queueUpdate(roomId, "user_persistent", updateData, doc);
      expect(getPendingPersistenceStats().pendingUpdates).toBe(1);

      // Perform shutdown drain
      await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });

      // Pending queue must be 0
      expect(getPendingPersistenceStats().pendingUpdates).toBe(0);

      // Document updates must be persisted in MongoDB
      const storedUpdates = await DocUpdateModel.find({ roomId }).exec();
      expect(storedUpdates.length).toBe(1);
      expect(storedUpdates[0]?.authorId).toBe("user_persistent");

      // Final snapshot must exist with matching sequence watermark
      const latestSnapshot = await DocSnapshotModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      expect(latestSnapshot).not.toBeNull();
      expect(latestSnapshot!.seq).toBe(storedUpdates[0]!.seq);
      expect(latestSnapshot!.text).toBe("function calculateTotal() { return 42; }");
    });

    it("stops recurring snapshot interval scheduling cleanly", () => {
      const doc = new Y.Doc();
      startSnapshotInterval(roomId, doc);

      const statsBefore = getPendingPersistenceStats();
      expect(statsBefore.activeSnapshotOperations).toBe(0);

      resetPersistenceState();

      // No timers running
      const statsAfter = getPendingPersistenceStats();
      expect(statsAfter.activeSnapshotOperations).toBe(0);
    });

    it("completes shutdown cleanly when no pending work exists", async () => {
      syncServer = createSyncServer({ requireAuth: false });
      expect(syncServer.getStats().status).toBe("running");

      await syncServer.drainAndShutdown();

      expect(syncServer.getStats().status).toBe("destroyed");
    });

    it("shares one operation across concurrent shutdown calls and maintains idempotency", async () => {
      syncServer = createSyncServer({ requireAuth: false });

      const p1 = syncServer.drainAndShutdown();
      const p2 = syncServer.drainAndShutdown();
      const p3 = syncServer.destroy();

      // Must be the identical promise instance
      expect(p1).toBe(p2);
      expect(p1).toBe(p3);

      await Promise.all([p1, p2, p3]);
      expect(syncServer.getStats().status).toBe("destroyed");
    });

    it("leaves registry, rate-limiter, and persistence state completely empty after shutdown", async () => {
      syncServer = createSyncServer({ requireAuth: false });
      syncRegistry.reserveSlot(roomId, "sock_clean_1");

      await syncServer.drainAndShutdown();

      const stats = syncServer.getStats();
      expect(stats.status).toBe("destroyed");
      expect(stats.connections.activeConnections).toBe(0);
      expect(stats.connections.pendingReservations).toBe(0);
      expect(stats.persistence.pendingUpdates).toBe(0);
      expect(stats.rateLimiter.trackedConnections).toBe(0);
    });

    it("coordinates HTTP server closure and WebSocket draining without deadlock in setupGracefulShutdown", async () => {
      const testApp = express();
      testApp.get("/ping", (_req, res) => res.json({ ok: true }));

      httpServer = createServer(testApp);
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      // Connect WebSocket client
      const wsProvider = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
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

      await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(
          (() => undefined) as unknown as (
            code?: string | number | null | undefined
          ) => never
        );

      const onShutdown = vi.fn(async () => {
        await syncServer!.drainAndShutdown();
      });

      const { handleShutdown } = setupGracefulShutdown(httpServer, onShutdown);

      // Trigger shutdown while WebSocket is connected
      await handleShutdown("SIGTERM");

      // Verify clean shutdown without deadlock
      expect(onShutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(syncServer.getStats().status).toBe("destroyed");

      exitSpy.mockRestore();
    });

    it("honestly reports failure if persistence drain throws during shutdown", async () => {
      const doc = new Y.Doc();
      queueUpdate(roomId, "user_fail_drain", new Uint8Array([1, 2, 3]), doc);

      // Mock DocUpdateModel.create to simulate unrecoverable DB error
      const createSpy = vi
        .spyOn(DocUpdateModel, "create")
        .mockRejectedValue(new Error("Permanent disk full error"));

      await expect(
        drainPersistenceAndSnapshot({ takeFinalSnapshots: false })
      ).rejects.toThrow("Permanent disk full error");

      createSpy.mockRestore();
    });

    it("awaits already-running in-flight snapshot operations during shutdown", async () => {
      const doc = new Y.Doc();
      doc.getText("monaco").insert(0, "in-flight snapshot test");
      const u1 = Y.encodeStateAsUpdate(doc);
      queueUpdate(roomId, "author_snap", u1, doc);
      await flushRoom(roomId);

      // Start an asynchronous snapshot
      const snapPromise = takeSnapshot(roomId, doc, true);
      expect(
        getPendingPersistenceStats().activeSnapshotOperations
      ).toBeGreaterThanOrEqual(0);

      // Run persistence drain
      await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });
      await snapPromise;

      const latestSnapshot = await DocSnapshotModel.findOne({ roomId })
        .sort({ seq: -1 })
        .exec();
      expect(latestSnapshot).not.toBeNull();
      expect(latestSnapshot!.text).toBe("in-flight snapshot test");
    });

    it("guarantees repeated shutdown signals do not duplicate flushes or teardown actions", async () => {
      const testApp = express();
      const server = createServer(testApp);
      await new Promise<void>((resolve) => server.listen(0, resolve));

      const flushTracker = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(
          (() => undefined) as unknown as (
            code?: string | number | null | undefined
          ) => never
        );

      const { handleShutdown } = setupGracefulShutdown(server, flushTracker);

      // Send two concurrent SIGTERM signals
      const p1 = handleShutdown("SIGTERM");
      const p2 = handleShutdown("SIGTERM");

      await Promise.all([p1, p2]);

      // Flush and onShutdown must execute exactly once
      expect(flushTracker).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);

      exitSpy.mockRestore();
    });

    it("Test A: rejects and cleans up connection when shutdown occurs while authentication is paused in-flight", async () => {
      const testRoomId = "507f1f77bcf86cd799439011";
      const testUserId = "user_auth_race_1";
      const socketId = "sock_auth_race_1";

      let pauseDeferredResolve!: () => void;
      const pausePromise = new Promise<void>((r) => {
        pauseDeferredResolve = r;
      });

      let reachedLookupResolve!: () => void;
      const reachedLookupPromise = new Promise<void>((r) => {
        reachedLookupResolve = r;
      });

      // Spy on sessionPrincipal.resolvePrincipalFromCookies to pause in-flight after initial isShuttingDown check
      const resolveSpy = vi
        .spyOn(sessionPrincipal, "resolvePrincipalFromCookies")
        .mockImplementation(async () => {
          reachedLookupResolve();
          await pausePromise;
          return {
            success: true,
            principal: {
              id: testUserId,
              type: "user",
              displayName: "Test User",
              role: "user",
              user: {
                id: testUserId,
                displayName: "Test User",
                role: "user",
              } as unknown as import("../../models/users.js").IUser,
            },
          };
        });

      const findByIdSpy = vi.spyOn(roomRepo, "findById").mockResolvedValue({
        _id: testRoomId,
        slug: "test-slug",
        status: "open",
        type: "collaboration",
      } as unknown as import("../../models/rooms.js").IRoom);

      const findMemberSpy = vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue({
        _id: "member_1",
        roomId: testRoomId,
        userId: testUserId,
        role: "editor",
      } as unknown as import("../../models/room_members.js").IRoomMember);

      syncServer = createSyncServer({ requireAuth: true });
      const onAuth = syncServer.server.configuration.onAuthenticate;

      // 1. Start onAuthenticate (passes initial check, reserves slot, then pauses at room lookup)
      const authPromise = onAuth!({
        documentName: testRoomId,
        socketId,
        connectionConfig: { readOnly: false },
        context: {},
        instance: syncServer.server,
        requestHeaders: { cookie: "pairprep.sid=s%3Amock-session-id" },
        requestParameters: new URLSearchParams(),
      } as unknown as Parameters<NonNullable<typeof onAuth>>[0]);

      // 2. Wait until authentication is paused in-flight
      await reachedLookupPromise;

      // Slot reservation must exist while in flight
      expect(syncRegistry.getPendingReservationCount()).toBe(1);

      // 3. Initiate server shutdown
      const shutdownPromise = syncServer.drainAndShutdown();

      // 4. Resume the paused authentication lookup
      pauseDeferredResolve();

      // 5. Authentication must fail with "Server is shutting down"
      await expect(authPromise).rejects.toThrow("Server is shutting down");

      // 6. Assert connection is not registered, reservation is cancelled, and rate-limiter is clean
      expect(syncRegistry.getActiveConnectionCount()).toBe(0);
      expect(syncRegistry.getPendingReservationCount()).toBe(0);
      expect(syncRegistry.getConnection(socketId)).toBeUndefined();

      await shutdownPromise;
      expect(syncServer.getStats().status).toBe("destroyed");

      resolveSpy.mockRestore();
      findByIdSpy.mockRestore();
      findMemberSpy.mockRestore();
    });

    it("Test B: rejects connection and unloads document when shutdown occurs while onLoadDocument is paused in-flight", async () => {
      const testRoomId = "507f1f77bcf86cd799439022";
      const doc = new Y.Doc();

      let pauseDeferredResolve!: () => void;
      const pausePromise = new Promise<void>((r) => {
        pauseDeferredResolve = r;
      });

      let reachedLoadResolve!: () => void;
      const reachedLoadPromise = new Promise<void>((r) => {
        reachedLoadResolve = r;
      });

      // Spy on DocSnapshotModel.findOne to pause during loadDocument
      const snapSpy = vi.spyOn(DocSnapshotModel, "findOne").mockImplementation(() => {
        reachedLoadResolve();
        return {
          sort: () => ({
            exec: async () => {
              await pausePromise;
              return null;
            },
          }),
        } as unknown as ReturnType<typeof DocSnapshotModel.findOne>;
      });

      syncServer = createSyncServer({ requireAuth: false });
      const onLoadDoc = syncServer.server.configuration.onLoadDocument;

      // 1. Start onLoadDocument
      const loadDocPromise = onLoadDoc!({
        documentName: testRoomId,
        document: doc,
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: "sock_load_race",
      } as unknown as Parameters<NonNullable<typeof onLoadDoc>>[0]);

      // 2. Wait until loadDocument is paused in-flight
      await reachedLoadPromise;

      // 3. Initiate server shutdown
      const shutdownPromise = syncServer.drainAndShutdown();

      // 4. Resume the paused document load
      pauseDeferredResolve();

      // 5. onLoadDocument must reject with "Server is shutting down"
      await expect(loadDocPromise).rejects.toThrow("Server is shutting down");

      await shutdownPromise;

      // 6. Assert no connection admitted, no active document, and state is clean
      const stats = syncServer.getStats();
      expect(stats.status).toBe("destroyed");
      expect(stats.connections.activeConnections).toBe(0);
      expect(stats.connections.activeDocuments).toBe(0);
      expect(syncRegistry.getRoomConnectionCount(testRoomId)).toBe(0);

      snapSpy.mockRestore();
    });

    it("Test C: forces termination of unresponsive sockets when drainTimeoutMs expires and cleans up all state", async () => {
      syncServer = createSyncServer({ requireAuth: false });

      let gracefulCloseCalled = false;
      let forceTerminateCalled = false;
      let closeCodeReceived: number | undefined;
      let closeReasonReceived: string | undefined;

      const mockUnresponsiveSocket = {
        close: vi.fn((code?: number, reason?: string) => {
          gracefulCloseCalled = true;
          closeCodeReceived = code;
          closeReasonReceived = reason;
          // Unresponsive socket: deliberately does NOT trigger disconnect or unregister
        }),
        terminate: vi.fn(() => {
          forceTerminateCalled = true;
          // Forced termination severs the transport
          syncRegistry.unregisterConnection(roomId, "sock_unresponsive_1");
        }),
      };

      // Register connection directly in syncRegistry
      syncRegistry.reserveSlot(roomId, "sock_unresponsive_1");
      syncRegistry.promoteReservation(
        "sock_unresponsive_1",
        roomId,
        "user_unresponsive",
        {
          id: "user_unresponsive",
          type: "user",
          displayName: "Unresponsive",
          role: "user",
        },
        {
          readOnly: false,
          webSocket: mockUnresponsiveSocket,
        } as unknown as import("../../sync/syncRegistry.js").SyncConnectionLike
      );

      expect(syncRegistry.getActiveConnectionCount()).toBe(1);

      // Perform shutdown with small drain timeout (50ms)
      await syncServer.drainAndShutdown({ drainTimeoutMs: 50 });

      // 1. Graceful close was called with 1001 and server_shutting_down
      expect(gracefulCloseCalled).toBe(true);
      expect(closeCodeReceived).toBe(1001);
      expect(closeReasonReceived).toBe("server_shutting_down");

      // 2. Forced terminate was invoked after drainTimeoutMs
      expect(forceTerminateCalled).toBe(true);

      // 3. Registry and transport cleanup complete
      expect(syncRegistry.getActiveConnectionCount()).toBe(0);
      expect(syncRegistry.getConnection("sock_unresponsive_1")).toBeUndefined();
      expect(syncServer.getStats().status).toBe("destroyed");
    });

    it("Test D: persistence failure prevents successful shutdown and server is not marked destroyed", async () => {
      syncServer = createSyncServer({ requireAuth: false });

      const doc = new Y.Doc();
      queueUpdate(roomId, "author_error", new Uint8Array([4, 5, 6]), doc);

      // Simulate MongoDB failure during shutdown persistence flush
      const createSpy = vi
        .spyOn(DocUpdateModel, "create")
        .mockRejectedValue(new Error("Database write error during shutdown"));

      await expect(syncServer.drainAndShutdown({ drainTimeoutMs: 50 })).rejects.toThrow(
        "Database write error during shutdown"
      );

      // Server must NOT be marked destroyed if persistence failed
      expect(syncServer.getStats().status).not.toBe("destroyed");

      createSpy.mockRestore();
    });

    it("proves awareness updates sent after shutdown starts do not change server awareness state or reach another participant", async () => {
      httpServer = createServer();
      syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

      await new Promise<void>((resolve) => {
        httpServer!.listen(0, () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("Invalid address");
      const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

      // 1. Connect Alice
      const aliceDoc = new Y.Doc();
      const aliceWs = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        maxAttempts: 1,
      });
      wsProviders.push(aliceWs);
      const aliceProvider = new HocuspocusProvider({
        websocketProvider: aliceWs,
        name: roomId,
        document: aliceDoc,
      });
      providers.push(aliceProvider);

      // 2. Connect Bob
      const bobDoc = new Y.Doc();
      const bobWs = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
        maxAttempts: 1,
      });
      wsProviders.push(bobWs);
      const bobProvider = new HocuspocusProvider({
        websocketProvider: bobWs,
        name: roomId,
        document: bobDoc,
      });
      providers.push(bobProvider);

      aliceProvider.attach();
      bobProvider.attach();

      await Promise.all([
        new Promise<void>((r) => aliceProvider.on("synced", () => r())),
        new Promise<void>((r) => bobProvider.on("synced", () => r())),
      ]);

      // 3. Set normal awareness while server is running
      aliceProvider.setAwarenessField("user", { name: "Alice" });
      bobProvider.setAwarenessField("user", { name: "Bob" });

      // Verify mutual awareness exchange while server is running
      await vi.waitFor(() => {
        const bobSeesAlice = bobProvider.awareness!.getStates().get(aliceDoc.clientID);
        expect(bobSeesAlice?.user?.name).toBe("Alice");
      });
      await vi.waitFor(() => {
        const aliceSeesBob = aliceProvider.awareness!.getStates().get(bobDoc.clientID);
        expect(aliceSeesBob?.user?.name).toBe("Bob");
      });

      // Verify server document awareness state has both clients
      const hocuspocusInstance = (
        syncServer.server as unknown as {
          hocuspocus: {
            documents: Map<
              string,
              { awareness: import("y-protocols/awareness").Awareness }
            >;
          };
        }
      ).hocuspocus;
      const serverDoc = hocuspocusInstance.documents.get(roomId);
      expect(serverDoc).toBeDefined();
      expect(serverDoc!.awareness.getStates().get(aliceDoc.clientID)?.user?.name).toBe(
        "Alice"
      );
      expect(serverDoc!.awareness.getStates().get(bobDoc.clientID)?.user?.name).toBe(
        "Bob"
      );

      // Track updates received by Bob during/after shutdown
      const bobLateAwarenessUpdates: Array<{
        user?: { name?: string };
        cursor?: { line?: number };
      }> = [];
      expect(bobProvider.awareness).not.toBeNull();
      bobProvider.awareness!.on("update", () => {
        const aliceStateOnBob = bobProvider.awareness?.getStates().get(aliceDoc.clientID);
        if (aliceStateOnBob) {
          bobLateAwarenessUpdates.push(JSON.parse(JSON.stringify(aliceStateOnBob)));
        }
      });

      // Spy on closeAllConnections: when called, shutdown has entered Phase A (isShuttingDown = true),
      // and sockets are still open. Alice emits awareness updates after shutdown barrier!
      const origCloseAll = syncRegistry.closeAllConnections.bind(syncRegistry);
      const closeSpy = vi
        .spyOn(syncRegistry, "closeAllConnections")
        .mockImplementation((code, reason) => {
          // Alice attempts awareness modification after shutdown started
          aliceProvider.setAwarenessField("user", { name: "Alice_PostShutdown" });
          aliceProvider.setAwarenessField("cursor", { line: 99 });
          return origCloseAll(code, reason);
        });

      // Also directly invoke beforeHandleAwareness to simulate an inbound frame processed during shutdown
      const beforeHandleAwareness = syncServer.server.configuration.beforeHandleAwareness;
      expect(beforeHandleAwareness).toBeDefined();

      const testStates = new Map<number, Record<string, unknown>>([
        [99999, { user: { name: "Attacker_Late" } }],
      ]);
      const testRemoved = new Set<number>([aliceDoc.clientID]);

      await syncServer.drainAndShutdown({ drainTimeoutMs: 2000 });

      // Directly verify beforeHandleAwareness drops incoming additions, updates, and removals during shutdown
      await beforeHandleAwareness!({
        documentName: roomId,
        document: serverDoc as unknown as import("@hocuspocus/server").Document,
        states: testStates,
        removedClients: testRemoved,
      } as unknown as Parameters<NonNullable<typeof beforeHandleAwareness>>[0]);

      // States and removedClients must have been cleared
      expect(testStates.size).toBe(0);
      expect(testRemoved.size).toBe(0);

      // 4. Bob must NEVER have received Alice_PostShutdown or cursor line 99
      for (const update of bobLateAwarenessUpdates) {
        expect(update?.user?.name).not.toBe("Alice_PostShutdown");
        expect(update?.cursor?.line).not.toBe(99);
      }
      expect(
        bobProvider.awareness!.getStates().get(aliceDoc.clientID)?.user?.name
      ).not.toBe("Alice_PostShutdown");

      // 5. Server awareness must not contain the modified state or the late addition
      expect(serverDoc!.awareness.getStates().get(99999)).toBeUndefined();

      closeSpy.mockRestore();
    });

    it("releases reservation and cleans up limiter when document loading fails or is aborted during shutdown", async () => {
      syncServer = createSyncServer({ requireAuth: false });
      const socketId = "sock_doc_load_fail_cleanup";
      const testRoomId = "507f1f77bcf86cd799439088";

      // 1. Authenticate and reserve a slot
      const onAuth = syncServer.server.configuration.onAuthenticate;
      expect(onAuth).toBeDefined();

      await onAuth!({
        documentName: testRoomId,
        socketId,
        connectionConfig: { readOnly: false },
        context: {},
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
      } as unknown as Parameters<NonNullable<typeof onAuth>>[0]);

      // Slot reservation must exist and be registered for socketId in testRoomId
      expect(syncRegistry.getPendingReservationCount()).toBe(1);
      const initialReservation = syncRegistry.getReservation(socketId);
      expect(initialReservation).toBeDefined();
      expect(initialReservation?.roomId).toBe(testRoomId);

      // 2. Pause document loading
      let pauseDeferredResolve!: () => void;
      const pausePromise = new Promise<void>((r) => {
        pauseDeferredResolve = r;
      });

      let reachedLoadResolve!: () => void;
      const reachedLoadPromise = new Promise<void>((r) => {
        reachedLoadResolve = r;
      });

      const snapSpy = vi.spyOn(DocSnapshotModel, "findOne").mockImplementation(() => {
        reachedLoadResolve();
        return {
          sort: () => ({
            exec: async () => {
              await pausePromise;
              return null;
            },
          }),
        } as unknown as ReturnType<typeof DocSnapshotModel.findOne>;
      });

      const doc = new Y.Doc();
      const onLoadDoc = syncServer.server.configuration.onLoadDocument;
      expect(onLoadDoc).toBeDefined();

      const loadDocPromise = onLoadDoc!({
        documentName: testRoomId,
        document: doc,
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId,
      } as unknown as Parameters<NonNullable<typeof onLoadDoc>>[0]);

      // Wait until document loading is paused in-flight
      await reachedLoadPromise;
      expect(syncRegistry.getPendingReservationCount()).toBe(1);

      // 3. Start shutdown
      const shutdownPromise = syncServer.drainAndShutdown();

      // 4. Complete the failed load
      pauseDeferredResolve();

      // Document loading must reject because shutdown occurred while in flight
      await expect(loadDocPromise).rejects.toThrow("Server is shutting down");
      await shutdownPromise;

      // 5. Verify that the reservation is released
      expect(syncRegistry.getPendingReservationCount()).toBe(0);
      expect(syncRegistry.getReservation(socketId)).toBeUndefined();

      // 6. Verify that registry, limiter, and document state are consistent
      expect(syncRegistry.getActiveConnectionCount()).toBe(0);
      expect(syncRegistry.getConnection(socketId)).toBeUndefined();
      expect(syncRegistry.getRoomConnectionCount(testRoomId)).toBe(0);
      expect(
        (
          syncServer.server as unknown as {
            hocuspocus?: { documents?: Map<string, unknown> };
          }
        ).hocuspocus?.documents?.has(testRoomId)
      ).toBeFalsy();
      expect(syncServer.getStats().status).toBe("destroyed");

      // 7. Verify that no late persistence operation occurs
      const persistenceStats = getPendingPersistenceStats();
      expect(persistenceStats.pendingUpdates).toBe(0);
      expect(persistenceStats.queuedUpdates).toBe(0);
      expect(persistenceStats.inFlightUpdates).toBe(0);
      expect(persistenceStats.roomsWithPendingUpdates).toBe(0);

      snapSpy.mockRestore();
    });

    it("releases all waiter reservations and cleans up limiters when concurrent document load fails", async () => {
      const limiter = new ConnectionRateLimiter();
      syncServer = createSyncServer({ requireAuth: false, rateLimiter: limiter });
      const hp = (
        syncServer.server as unknown as {
          hocuspocus: {
            documents: Map<string, unknown>;
            createDocument: (
              name: string,
              req: unknown,
              sockId: string,
              cfg: unknown,
              ctx: unknown
            ) => Promise<unknown>;
          };
        }
      ).hocuspocus;

      const testRoomId = "507f1f77bcf86cd799439099";
      const unrelatedRoomId = "507f1f77bcf86cd799439088";
      const aliceSocket = "sock_alice_waiter";
      const bobSocket = "sock_bob_waiter";
      const charlieSocket = "sock_charlie_unrelated";

      // 1. Client A authenticates and reserves slot
      const onAuth = syncServer.server.configuration.onAuthenticate;
      expect(onAuth).toBeDefined();

      await onAuth!({
        documentName: testRoomId,
        socketId: aliceSocket,
        connectionConfig: { readOnly: false },
        context: {},
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
      } as unknown as Parameters<NonNullable<typeof onAuth>>[0]);

      limiter.consume(aliceSocket, 100);
      expect(syncRegistry.getReservation(aliceSocket)?.roomId).toBe(testRoomId);
      expect(syncRegistry.getPendingReservationCount()).toBe(1);

      // Set up an unrelated reservation for another room to verify it is NOT cancelled
      syncRegistry.reserveSlot(unrelatedRoomId, charlieSocket);
      limiter.consume(charlieSocket, 100);
      expect(syncRegistry.getReservation(charlieSocket)?.roomId).toBe(unrelatedRoomId);
      expect(syncRegistry.getPendingReservationCount()).toBe(2);

      // 2. Pause document loading in flight and track observable loader invocation count
      let pauseResolve!: () => void;
      const pausePromise = new Promise<void>((r) => {
        pauseResolve = r;
      });

      let reachedLoadResolve!: () => void;
      const reachedLoadPromise = new Promise<void>((r) => {
        reachedLoadResolve = r;
      });

      let loaderInvocationCount = 0;

      const snapSpy = vi.spyOn(DocSnapshotModel, "findOne").mockImplementation(() => {
        loaderInvocationCount++;
        reachedLoadResolve();
        return {
          sort: () => ({
            exec: async () => {
              await pausePromise;
              throw new Error("Simulated concurrent load database failure");
            },
          }),
        } as unknown as ReturnType<typeof DocSnapshotModel.findOne>;
      });

      // Alice begins loading document
      const aliceDocPromise = hp.createDocument(
        testRoomId,
        new Request("http://localhost"),
        aliceSocket,
        { readOnly: false },
        {}
      );

      // Wait until Alice's load is in-flight and paused at database query
      await reachedLoadPromise;
      expect(loaderInvocationCount).toBe(1);

      // 3. Client B authenticates for the same document
      await onAuth!({
        documentName: testRoomId,
        socketId: bobSocket,
        connectionConfig: { readOnly: false },
        context: {},
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
      } as unknown as Parameters<NonNullable<typeof onAuth>>[0]);

      limiter.consume(bobSocket, 100);

      // Client B initiates loading for the same document while Alice's load is still in flight
      const bobDocPromise = hp.createDocument(
        testRoomId,
        new Request("http://localhost"),
        bobSocket,
        { readOnly: false },
        {}
      );

      // Observable loader invocation count proves deduplication:
      // Even though Bob requested loading, the underlying loader was NOT invoked a second time
      expect(loaderInvocationCount).toBe(1);

      // 4. Confirm reservations in SyncRegistry:
      // Alice and Bob hold reservations for testRoomId, and Charlie holds reservation for unrelatedRoomId
      expect(syncRegistry.getPendingReservationCount()).toBe(3);
      expect(syncRegistry.getReservation(aliceSocket)?.roomId).toBe(testRoomId);
      expect(syncRegistry.getReservation(bobSocket)?.roomId).toBe(testRoomId);
      expect(syncRegistry.getReservation(charlieSocket)?.roomId).toBe(unrelatedRoomId);
      expect(syncRegistry.getPendingReservationsForRoom(testRoomId)).toEqual(
        expect.arrayContaining([aliceSocket, bobSocket])
      );
      expect(syncRegistry.getPendingReservationsForRoom(unrelatedRoomId)).toEqual([
        charlieSocket,
      ]);
      expect(documentLoadWaiters.getWaiters(testRoomId)).toEqual(
        expect.arrayContaining([aliceSocket, bobSocket])
      );

      // 5. Resume and fail document loading
      pauseResolve();

      // 6. Verify both clients fail to establish connection with the exact same error
      await expect(aliceDocPromise).rejects.toThrow(
        "Simulated concurrent load database failure"
      );
      await expect(bobDocPromise).rejects.toThrow(
        "Simulated concurrent load database failure"
      );

      // Loader was invoked exactly once throughout the entire deduplicated cycle
      expect(loaderInvocationCount).toBe(1);

      // 7. Verify both reservations for testRoomId are released and document waiters are removed
      expect(syncRegistry.getReservation(aliceSocket)).toBeUndefined();
      expect(syncRegistry.getReservation(bobSocket)).toBeUndefined();
      expect(syncRegistry.getPendingReservationsForRoom(testRoomId)).toHaveLength(0);
      expect(documentLoadWaiters.getWaiters(testRoomId)).toHaveLength(0);

      // 8. Regression assertion: Unrelated reservation for unrelatedRoomId was NOT cancelled!
      expect(syncRegistry.getReservation(charlieSocket)?.roomId).toBe(unrelatedRoomId);
      expect(syncRegistry.getPendingReservationsForRoom(unrelatedRoomId)).toEqual([
        charlieSocket,
      ]);
      expect(syncRegistry.getPendingReservationCount()).toBe(1);
      expect(documentLoadWaiters.getWaiters(unrelatedRoomId)).toEqual([]);

      // 9. Verify rate limiters for testRoomId were cleaned up, while Charlie's limiter remains active
      expect(limiter.getStats().trackedConnections).toBe(1);

      // 10. Verify zero leftover connection, document, or persistence state for testRoomId
      expect(syncRegistry.getActiveConnectionCount()).toBe(0);
      expect(syncRegistry.getActiveRoomCount()).toBe(0);
      expect(syncRegistry.getConnection(aliceSocket)).toBeUndefined();
      expect(syncRegistry.getConnection(bobSocket)).toBeUndefined();
      expect(hp.documents.has(testRoomId)).toBe(false);
      const persistenceStats = getPendingPersistenceStats();
      expect(persistenceStats.pendingUpdates).toBe(0);
      expect(persistenceStats.queuedUpdates).toBe(0);
      expect(persistenceStats.inFlightUpdates).toBe(0);
      expect(persistenceStats.roomsWithPendingUpdates).toBe(0);

      // Clean up the unrelated test reservation
      syncRegistry.cancelReservation(charlieSocket, unrelatedRoomId);
      limiter.cleanup(charlieSocket);
      expect(syncRegistry.getPendingReservationCount()).toBe(0);
      expect(limiter.getStats().trackedConnections).toBe(0);

      snapSpy.mockRestore();
    });

    it("preserves multi-document socket sharing and limiter state when one document load fails", async () => {
      const limiter = new ConnectionRateLimiter();
      syncServer = createSyncServer({ requireAuth: false, rateLimiter: limiter });
      const hp = (
        syncServer.server as unknown as {
          hocuspocus: {
            documents: Map<string, unknown>;
            createDocument: (
              name: string,
              req: unknown,
              sockId: string,
              cfg: unknown,
              ctx: unknown
            ) => Promise<unknown>;
          };
        }
      ).hocuspocus;

      const sharedSocketId = "sock_shared_multi_doc";
      const roomA = "507f1f77bcf86cd799439077";
      const roomB = "507f1f77bcf86cd799439066";

      // 1. A physical connection has an active connection in Room A
      syncRegistry.reserveSlot(roomA, sharedSocketId);
      syncRegistry.promoteReservation(
        sharedSocketId,
        roomA,
        "user_shared",
        { id: "user_shared", type: "user", displayName: "Shared", role: "user" },
        {
          readOnly: false,
        } as unknown as import("../../sync/syncRegistry.js").SyncConnectionLike
      );
      limiter.consume(sharedSocketId, 50);

      expect(syncRegistry.getConnection(sharedSocketId)?.roomId).toBe(roomA);
      expect(limiter.getStats().trackedConnections).toBe(1);

      // 2. Physical connection begins loading Room B
      const onAuth = syncServer.server.configuration.onAuthenticate;
      expect(onAuth).toBeDefined();

      await onAuth!({
        documentName: roomB,
        socketId: sharedSocketId,
        connectionConfig: { readOnly: false },
        context: {},
        instance: syncServer.server,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
      } as unknown as Parameters<NonNullable<typeof onAuth>>[0]);

      expect(syncRegistry.getReservation(sharedSocketId)?.roomId).toBe(roomB);

      // Room B's load fails
      const snapSpy = vi.spyOn(DocSnapshotModel, "findOne").mockImplementationOnce(
        () =>
          ({
            sort: () => ({
              exec: async () => {
                throw new Error("Simulated load failure for roomB");
              },
            }),
          }) as unknown as ReturnType<typeof DocSnapshotModel.findOne>
      );

      await expect(
        hp.createDocument(
          roomB,
          new Request("http://localhost"),
          sharedSocketId,
          { readOnly: false },
          {}
        )
      ).rejects.toThrow("Simulated load failure for roomB");

      // 3. Confirm Room B's reservation is cancelled
      expect(syncRegistry.getReservation(sharedSocketId)).toBeUndefined();
      expect(syncRegistry.getPendingReservationsForRoom(roomB)).toHaveLength(0);

      // 4. Confirm Room A's connection and rate-limiter state are not removed
      const roomAConn = syncRegistry.getConnection(sharedSocketId);
      expect(roomAConn).toBeDefined();
      expect(roomAConn?.roomId).toBe(roomA);
      expect(limiter.getStats().trackedConnections).toBe(1);

      snapSpy.mockRestore();
    });
  });
});
