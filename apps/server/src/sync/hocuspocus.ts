import { Server as HocuspocusServer } from "@hocuspocus/server";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface SyncServerInstance {
  server: HocuspocusServer;
  destroy: () => Promise<void>;
}

/**
 * Creates a Hocuspocus server instance configured with maxPayload at the WebSocket layer.
 */
export function createSyncServer(): SyncServerInstance {
  const server = new HocuspocusServer({
    websocketOptions: {
      maxPayload: 1048576, // 1 MB WebSocket frame limit enforced by ws
    },
  });

  return {
    server,
    destroy: async () => {
      await server.destroy();
    },
  };
}

/**
 * Attaches the Hocuspocus sync server to an existing Node.js HTTP server.
 * Intercepts upgrade requests on /sync and delegates to crossws.
 */
export function attachSyncServer(
  httpServer: HttpServer,
  syncInstance: SyncServerInstance = createSyncServer()
): SyncServerInstance {
  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname === "/sync") {
        // Delegate WebSocket upgrade to Hocuspocus crossws adapter
        (syncInstance.server as unknown as {
          crossws: {
            handleUpgrade: (
              req: IncomingMessage,
              sock: Duplex,
              head: Buffer
            ) => void;
          };
        }).crossws.handleUpgrade(request, socket, head);
      }
    }
  );

  return syncInstance;
}
