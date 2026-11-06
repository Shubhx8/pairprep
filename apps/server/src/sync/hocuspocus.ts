import { Server as HocuspocusServer } from "@hocuspocus/server";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isAllowedOrigin } from "./origin.js";
import { getClientIp, syncUpgradeRateLimiter } from "./rateLimiter.js";
import { resolvePrincipalFromCookies } from "../auth/sessionPrincipal.js";
import type { Principal } from "../middleware/identity.js";

export interface SyncServerInstance {
  server: HocuspocusServer;
  destroy: () => Promise<void>;
}

export interface CreateSyncServerOptions {
  requireAuth?: boolean;
}

export interface SyncConnectionContext {
  principal?: Principal;
  [key: string]: unknown;
}

/**
 * Creates a Hocuspocus server instance configured with maxPayload and authentication hooks.
 */
export function createSyncServer(
  options: CreateSyncServerOptions = {}
): SyncServerInstance {
  const requireAuth = options.requireAuth ?? true;

  const server = new HocuspocusServer({
    websocketOptions: {
      maxPayload: 1048576, // 1 MB WebSocket frame limit enforced at framing layer
    },
    async onAuthenticate(data) {
      // Validate documentName is a valid 24-character hex MongoDB ObjectId
      if (!/^[0-9a-fA-F]{24}$/.test(data.documentName)) {
        throw new Error("Invalid room document id");
      }

      if (requireAuth) {
        let cookieHeader: string | undefined;

        // In Hocuspocus crossws adapter, requestHeaders may be a web standard Headers object or plain object
        if (
          data.requestHeaders &&
          typeof (data.requestHeaders as unknown as { get?: unknown }).get ===
            "function"
        ) {
          cookieHeader =
            (
              data.requestHeaders as unknown as {
                get: (name: string) => string | null;
              }
            ).get("cookie") ?? undefined;
        } else if (
          data.requestHeaders &&
          typeof data.requestHeaders === "object"
        ) {
          cookieHeader = (
            data.requestHeaders as unknown as Record<string, string | undefined>
          )["cookie"];
        }

        if (
          !cookieHeader &&
          data.request &&
          typeof data.request === "object" &&
          "headers" in data.request
        ) {
          cookieHeader = (data.request as unknown as IncomingMessage).headers[
            "cookie"
          ];
        }

        const authResult = await resolvePrincipalFromCookies(
          cookieHeader,
          data.documentName
        );

        if (!authResult.success) {
          throw new Error(`Authentication failed: ${authResult.reason}`);
        }

        const context = data.context as SyncConnectionContext;
        context.principal = authResult.principal;
      }
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
 * Intercepts upgrade requests on /sync, enforces IP rate limits and allowed origins,
 * and delegates to the crossws adapter with a startup runtime guard.
 */
export function attachSyncServer(
  httpServer: HttpServer,
  syncInstance: SyncServerInstance = createSyncServer()
): SyncServerInstance {
  // Runtime guard: Throws immediately at startup if Hocuspocus internal adapter is missing or renamed
  const crossws = (
    syncInstance.server as unknown as Record<string, unknown>
  )["crossws"] as
    | {
        handleUpgrade: (
          req: IncomingMessage,
          sock: Duplex,
          head: Buffer
        ) => void;
      }
    | undefined;

  if (!crossws?.handleUpgrade) {
    throw new Error(
      "Hocuspocus internal crossws adapter not found - check version"
    );
  }

  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname !== "/sync") {
        // Not a sync endpoint
        return;
      }

      const clientIp = getClientIp(request);

      // 1. IP rate limiter (checks rejected connection attempts)
      if (syncUpgradeRateLimiter.isRateLimited(clientIp)) {
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n"
        );
        socket.destroy();
        return;
      }

      // 2. Strict allowed Origin check
      if (!isAllowedOrigin(request.headers.origin)) {
        syncUpgradeRateLimiter.recordRejection(clientIp);
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      // Delegate WebSocket upgrade to Hocuspocus crossws adapter
      crossws.handleUpgrade(request, socket, head);
    }
  );

  return syncInstance;
}
