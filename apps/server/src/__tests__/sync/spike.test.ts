import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { attachSyncServer, type SyncServerInstance } from "../../sync/hocuspocus.js";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

describe("T07 Spike: Minimal Hocuspocus Attach", () => {
  let httpServer: HttpServer | undefined;
  let syncServer: SyncServerInstance | undefined;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];

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
  });

  it("attaches to HTTP server at /sync and syncs document updates between two clients", async () => {
    httpServer = createServer();
    syncServer = attachSyncServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Invalid server address");
    }
    const port = addr.port;
    const wsUrl = `ws://127.0.0.1:${port}/sync`;

    const wsProvider1 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: WebSocket,
    });
    wsProviders.push(wsProvider1);

    const doc1 = new Y.Doc();
    const provider1 = new HocuspocusProvider({
      websocketProvider: wsProvider1,
      name: "spike-room",
      document: doc1,
    });
    provider1.attach();
    providers.push(provider1);

    const wsProvider2 = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: WebSocket,
    });
    wsProviders.push(wsProvider2);

    const doc2 = new Y.Doc();
    const provider2 = new HocuspocusProvider({
      websocketProvider: wsProvider2,
      name: "spike-room",
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
