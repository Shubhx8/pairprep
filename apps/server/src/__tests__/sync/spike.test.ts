import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import mongoose from "mongoose";
import { config } from "../../config.js";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

describe("T07 Spike: Minimal Hocuspocus Attach", () => {
  let httpServer: HttpServer | undefined;
  let syncServer: SyncServerInstance | undefined;
  let originalUri: string | undefined;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];

  class BrowserLikeWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, {
        headers: {
          origin: "http://localhost:3000",
        },
      });
    }
  }

  beforeEach(async () => {
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_spike_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
  });

  afterEach(async () => {
    for (const provider of providers) {
      provider.destroy();
    }
    providers.length = 0;

    for (const wsProvider of wsProviders) {
      wsProvider.destroy();
    }
    wsProviders.length = 0;

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

  it("attaches to HTTP server at /sync with allowed origin and syncs updates", async () => {
    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Invalid server address");
    }
    const port = addr.port;
    const wsUrl = `ws://127.0.0.1:${port}/sync`;
    const testDocId = "507f1f77bcf86cd799439011";

    const wsProvider1 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(wsProvider1);

    const doc1 = new Y.Doc();
    const provider1 = new HocuspocusProvider({
      websocketProvider: wsProvider1,
      name: testDocId,
      document: doc1,
    });
    provider1.attach();
    providers.push(provider1);

    const wsProvider2 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(wsProvider2);

    const doc2 = new Y.Doc();
    const provider2 = new HocuspocusProvider({
      websocketProvider: wsProvider2,
      name: testDocId,
      document: doc2,
    });
    provider2.attach();
    providers.push(provider2);

    // Write on doc1
    doc1.getText("default").insert(0, "Collaborative spike verified!");

    // Wait for doc2 to receive text
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for sync. Current text: "${doc2.getText("default").toString()}"`
          )
        );
      }, 5000);

      const check = () => {
        if (
          doc2.getText("default").toString() === "Collaborative spike verified!"
        ) {
          clearTimeout(timeout);
          resolve();
        }
      };

      doc2.getText("default").observe(check);
      check();
    });

    expect(doc2.getText("default").toString()).toBe(
      "Collaborative spike verified!"
    );
  });
});
