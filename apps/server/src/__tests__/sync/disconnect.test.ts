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
import { syncRegistry } from "../../sync/syncRegistry.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { config } from "../../config.js";

describe("T07 Disconnect Lifecycle & Unload (PER-1)", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let originalUri: string | undefined;
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
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_disc_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await DocUpdateModel.deleteMany({ roomId });
    await DocSnapshotModel.deleteMany({ roomId });
  });

  afterEach(async () => {
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

  it("flushes pending updates, unregisters connection, snapshots, and unloads document on disconnect when clientsCount === 0", async () => {
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
    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: clientDoc,
    });
    provider.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sync timeout")), 5000);
      provider.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // 1. Verify active connection registered in syncRegistry
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);

    // 2. Client types an update
    clientDoc.getText("monaco").insert(0, "Disconnect persistence check");

    // Wait 100 ms (less than 2000 ms flush deadline, update is still pending in memory)
    await new Promise((r) => setTimeout(r, 100));

    // Verify Hocuspocus has document loaded in memory before disconnect
    const hocuspocusInstance = (
      syncServer.server as unknown as { hocuspocus: { documents: Map<string, unknown> } }
    ).hocuspocus;
    expect(hocuspocusInstance.documents.has(roomId)).toBe(true);

    // 3. Disconnect provider
    provider.destroy();
    wsProvider.destroy();

    // Wait for onDisconnect processing (flushRoom, unregisterConnection, takeSnapshot, unloadDocument)
    await new Promise((r) => setTimeout(r, 300));

    // 4. Verify unregisterConnection was called
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);

    // 5. Verify flushRoom(roomId, true) flushed the pending update to MongoDB
    const persistedUpdates = await DocUpdateModel.find({ roomId }).exec();
    expect(persistedUpdates.length).toBeGreaterThan(0);

    // 6. Verify final snapshot was saved
    const snapshots = await DocSnapshotModel.find({ roomId }).exec();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.text).toContain("Disconnect persistence check");

    // 7. Verify document was unloaded from Hocuspocus memory (clientsCount === 0)
    expect(hocuspocusInstance.documents.has(roomId)).toBe(false);
  });
});
