import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { isAllowedOrigin } from "../sync/origin.js";
import {
  resolvePrincipalFromCookies,
  type SessionResolutionResult,
} from "../auth/sessionPrincipal.js";
import type { Principal } from "../middleware/identity.js";
import { rootLogger } from "../middleware/logger.js";
import {
  SocketHandshakeRateLimiter,
  resolveHandshakeIp,
  type SocketHandshakeRateLimiterOptions,
} from "./rateLimiter.js";
import { attachRoomEventHandlers } from "./roomEvents.js";

export interface SocketData {
  principal?: Principal;
}

export interface SocketServerOptions {
  rateLimiter?: SocketHandshakeRateLimiter;
  rateLimiterOptions?: SocketHandshakeRateLimiterOptions;
}

export type EventsMap = Record<string, unknown>;

export interface SocketServerInstance {
  io: Server<EventsMap, EventsMap, EventsMap, SocketData>;
  close: () => Promise<void>;
  rateLimiter: SocketHandshakeRateLimiter;
}

export type SocketAuthErrorCode =
  | "UNAUTHORIZED"
  | "ACCOUNT_DISABLED"
  | "DB_UNAVAILABLE"
  | "INVALID_GUEST"
  | "INTERNAL_ERROR";

export type SessionResolutionFailureReason = Extract<
  SessionResolutionResult,
  { success: false }
>["reason"];

export type SocketAuthErrorReason = SessionResolutionFailureReason | "unexpected";

export interface SocketAuthErrorData {
  code: SocketAuthErrorCode;
  reason: SocketAuthErrorReason;
}

let activeSocketServer: Server<EventsMap, EventsMap, EventsMap, SocketData> | undefined;

export function getSocketServer():
  Server<EventsMap, EventsMap, EventsMap, SocketData> | undefined {
  return activeSocketServer;
}

export function setSocketServer(
  server: Server<EventsMap, EventsMap, EventsMap, SocketData> | undefined
): void {
  activeSocketServer = server;
}

/**
 * Attaches the Socket.IO room events server to an existing Node.js HTTP server.
 * Implements strict WebSocket-only transport, IP-based handshake rate limiting (60/min),
 * Origin admission via existing origin helper, and session-based authentication middleware
 * using resolvePrincipalFromCookies.
 */
export function attachSocketServer(
  httpServer: HttpServer,
  options?: SocketServerOptions
): SocketServerInstance {
  const rateLimiter =
    options?.rateLimiter ?? new SocketHandshakeRateLimiter(options?.rateLimiterOptions);

  const io = new Server<EventsMap, EventsMap, EventsMap, SocketData>(httpServer, {
    path: "/socket.io",
    transports: ["websocket"],
    serveClient: false,
    perMessageDeflate: false,
    maxHttpBufferSize: 16384,
    pingInterval: 10000,
    pingTimeout: 5000,
    allowRequest: (req, callback) => {
      // 1. IP-based handshake admission rate limiting (max 60 attempts/min/IP)
      const clientIp = resolveHandshakeIp(req);
      if (!rateLimiter.consume(clientIp)) {
        return callback("RATE_LIMITED", false);
      }

      // 2. Strict Origin validation via centralized helper
      const origin = req.headers.origin;
      if (!origin || !isAllowedOrigin(origin)) {
        return callback("ORIGIN_FORBIDDEN", false);
      }

      callback(null, true);
    },
  });

  io.use(async (socket: Socket<EventsMap, EventsMap, EventsMap, SocketData>, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const targetRoomId =
        (typeof socket.handshake.auth?.roomId === "string"
          ? socket.handshake.auth.roomId
          : undefined) ??
        (typeof socket.handshake.query?.roomId === "string"
          ? socket.handshake.query.roomId
          : undefined);

      const authResult = await resolvePrincipalFromCookies(cookieHeader, targetRoomId);

      if (!authResult.success) {
        const { reason } = authResult;
        const message =
          reason === "disabled"
            ? "Account disabled"
            : reason === "db_unavailable"
              ? "Database unavailable"
              : reason === "invalid_guest"
                ? "Invalid guest credentials"
                : "Authentication required";

        const err = new Error(message);
        const errorData: SocketAuthErrorData = {
          code:
            reason === "disabled"
              ? "ACCOUNT_DISABLED"
              : reason === "db_unavailable"
                ? "DB_UNAVAILABLE"
                : reason === "invalid_guest"
                  ? "INVALID_GUEST"
                  : "UNAUTHORIZED",
          reason,
        };
        (err as unknown as { data: SocketAuthErrorData }).data = errorData;
        return next(err);
      }

      socket.data.principal = authResult.principal;
      return next();
    } catch (unexpectedError) {
      rootLogger.error(
        { err: unexpectedError },
        "Unexpected error during Socket.IO connection authentication"
      );
      const err = new Error("Authentication failure");
      const errorData: SocketAuthErrorData = {
        code: "INTERNAL_ERROR",
        reason: "unexpected",
      };
      (err as unknown as { data: SocketAuthErrorData }).data = errorData;
      return next(err);
    }
  });

  activeSocketServer = io;

  io.on("connection", (socket) => {
    attachRoomEventHandlers(socket);
  });

  const close = async (): Promise<void> => {
    if (activeSocketServer === io) {
      activeSocketServer = undefined;
    }
    rateLimiter.reset();
    io.disconnectSockets(true);
    io.engine.close();
  };

  return { io, close, rateLimiter };
}
