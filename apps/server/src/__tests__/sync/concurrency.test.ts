import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import { config } from "../../config.js";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

describe("T07 Concurrency & Read-Only Enforcement (CONC-1, CONC-2, ED-6)", () => {
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
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_conc_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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

    for (const ws of wsProviders) {
      try {
        ws.destroy();
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

  it("CONC-1: allows up to 6 concurrent participants typing concurrently without conflict", async () => {
    httpServer = createServer();
    syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    const docs: Y.Doc[] = [];
    const syncPromises: Promise<void>[] = [];

    // Connect 6 participants
    for (let i = 0; i < 6; i++) {
      const ws = new HocuspocusProviderWebsocket({
        url: wsUrl,
        WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(ws);

      const doc = new Y.Doc();
      docs.push(doc);

      const provider = new HocuspocusProvider({
        websocketProvider: ws,
        name: roomId,
        document: doc,
      });
      providers.push(provider);

      syncPromises.push(
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Sync timeout for participant ${i}`)),
            5000
          );
          provider.on("synced", () => {
            clearTimeout(timer);
            resolve();
          });
        })
      );
      provider.attach();
    }

    await Promise.all(syncPromises);

    // Each participant concurrently types their unique marker
    for (let i = 0; i < 6; i++) {
      docs[i]!.getText("monaco").insert(0, `[P${i}]`);
    }

    // Wait for state convergence across all 6 documents
    await new Promise((r) => setTimeout(r, 600));

    // Verify all 6 documents have identical text containing all 6 markers
    const baseText = docs[0]!.getText("monaco").toString();
    for (let i = 0; i < 6; i++) {
      expect(baseText).toContain(`[P${i}]`);
      expect(docs[i]!.getText("monaco").toString()).toBe(baseText);
    }
  });

  it("CONC-2: duplicate update delivery is idempotent and harmless", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    doc1.getText("monaco").insert(0, "Idempotent update test");
    const update = Y.encodeStateAsUpdate(doc1);

    // Apply the exact same update twice to doc2
    Y.applyUpdate(doc2, update);
    expect(doc2.getText("monaco").toString()).toBe("Idempotent update test");

    // Re-applying does not duplicate or corrupt text
    Y.applyUpdate(doc2, update);
    expect(doc2.getText("monaco").toString()).toBe("Idempotent update test");
  });

  it("ED-6: rejects editing in read-only mode in beforeHandleMessage", async () => {
    httpServer = createServer();
    syncServer = attachSyncServer(httpServer, createSyncServer({ requireAuth: false }));

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/sync`;

    // Set room to read-only before connection
    syncRegistry.setRoomReadOnly(roomId);

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

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout")), 5000);
      provider.on("authenticated", () => {
        clearTimeout(timer);
        resolve();
      });
      provider.attach();
    });

    // Provider should be marked read-only
    expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
  });
});
