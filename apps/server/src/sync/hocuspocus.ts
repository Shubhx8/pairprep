import { Server as HocuspocusServer } from "@hocuspocus/server";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isAllowedOrigin } from "./origin.js";
import { getClientIp, syncUpgradeRateLimiter } from "./rateLimiter.js";
import { resolvePrincipalFromCookies } from "../auth/sessionPrincipal.js";
import type { Principal } from "../middleware/identity.js";
import { syncRegistry } from "./syncRegistry.js";
import {
  loadDocument,
  queueUpdate,
  flushAllPending,
} from "./persistence.js";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import type { IRoom } from "../models/rooms.js";
import type { IRoomMember } from "../models/room_members.js";

export interface SyncServerInstance {
  server: HocuspocusServer;
  destroy: () => Promise<void>;
}

export interface CreateSyncServerOptions {
  requireAuth?: boolean;
}

export interface SyncConnectionContext {
  principal?: Principal;
  member?: IRoomMember;
  room?: IRoom;
  readOnly?: boolean;
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
      // 1. Validate documentName is a valid 24-character hex MongoDB ObjectId
      if (!/^[0-9a-fA-F]{24}$/.test(data.documentName)) {
        throw new Error("Invalid room document id");
      }

      const roomId = data.documentName;

      // 2. Synchronous per-room capacity reservation (ROOM-4: max 6 active connections)
      const reservation = syncRegistry.reserveSlot(roomId, data.socketId);
      if (!reservation.success) {
        const err = new Error(
          "Room capacity exceeded: maximum 6 active connections"
        );
        (err as unknown as { reason: string }).reason = "room_capacity_exceeded";
        throw err;
      }

      try {
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
            roomId
          );

          if (!authResult.success) {
            const err = new Error(
              `Authentication failed: ${authResult.reason}`
            );
            (err as unknown as { reason: string }).reason = authResult.reason;
            throw err;
          }

          const principal = authResult.principal;

          // Verify room exists in database
          const room = await roomRepo.findById(roomId);
          if (!room) {
            const err = new Error("Room not found");
            (err as unknown as { reason: string }).reason = "room_not_found";
            throw err;
          }

          // Verify member is part of the room
          const member = await roomMemberRepo.findMember(roomId, principal.id);
          if (!member) {
            const err = new Error("Forbidden: not a member of this room");
            (err as unknown as { reason: string }).reason = "not_room_member";
            throw err;
          }

          // 3a. Distinct member limit (ROOM-4: max 6 distinct members)
          if (!syncRegistry.checkDistinctMemberLimit(roomId, principal.id)) {
            const err = new Error(
              "Room member limit exceeded: maximum 6 distinct members"
            );
            (err as unknown as { reason: string }).reason =
              "room_member_limit_exceeded";
            throw err;
          }

          // 3b. Per-member connection limit (max 3 connections per member in this room)
          if (!syncRegistry.checkMemberLimit(roomId, principal.id)) {
            const err = new Error(
              "Member connection limit exceeded: maximum 3 connections per member"
            );
            (err as unknown as { reason: string }).reason =
              "member_connection_limit_exceeded";
            throw err;
          }

          // Associate member with this reservation
          syncRegistry.assignMemberToReservation(data.socketId, principal.id);

          // 4. Server-enforced read-only check
          let isReadOnly =
            syncRegistry.isRoomReadOnly(roomId) ||
            room.status === "ended" ||
            room.status === "archived" ||
            member.role === "viewer";

          // In interview room, candidate is read-only before the interview starts (PRD 13.2)
          if (
            room.type === "interview" &&
            member.role === "candidate" &&
            (!room.startedAt || room.status !== "live")
          ) {
            isReadOnly = true;
          }

          if (isReadOnly) {
            data.connectionConfig.readOnly = true;
          }

          const context = data.context as SyncConnectionContext;
          context.principal = principal;
          context.member = member;
          context.room = room;
          context.readOnly = isReadOnly;
        } else {
          // If auth is disabled (e.g. mock/spike/test), assign mock principal
          const mockMemberId = `anon_${data.socketId}`;
          syncRegistry.assignMemberToReservation(data.socketId, mockMemberId);
          const context = data.context as SyncConnectionContext;
          context.principal = {
            type: "user",
            id: mockMemberId,
            displayName: "Anonymous Test",
            role: "user",
            user: {
              id: mockMemberId,
              displayName: "Anonymous Test",
              role: "user",
            } as unknown as import("../models/users.js").IUser,
          };
          if (syncRegistry.isRoomReadOnly(roomId)) {
            data.connectionConfig.readOnly = true;
            context.readOnly = true;
          }
        }
      } catch (err) {
        // Guarantee slot reservation is released on every error/failure path
        syncRegistry.cancelReservation(data.socketId);
        throw err;
      }
    },
    async connected(data) {
      const context = data.context as SyncConnectionContext;
      const memberId = context.principal?.id ?? `anon_${data.socketId}`;
      const principal = context.principal ?? {
        type: "user",
        id: memberId,
        displayName: "Anonymous",
        role: "user",
        user: {
          id: memberId,
          displayName: "Anonymous",
          role: "user",
        } as unknown as import("../models/users.js").IUser,
      };
      syncRegistry.promoteReservation(
        data.socketId,
        data.documentName,
        memberId,
        principal,
        data.connection
      );
    },
    async onDisconnect(data) {
      syncRegistry.unregisterConnection(data.documentName, data.socketId);
    },
    async onLoadDocument(data) {
      await loadDocument(data.documentName, data.document);
      return data.document;
    },
    async onChange(data) {
      const context = data.context as SyncConnectionContext;
      const authorId = context?.principal?.id ?? data.socketId ?? "anonymous";
      queueUpdate(data.documentName, authorId, data.update, data.document);
    },
    async beforeHandleMessage(data) {
      if (data.update.byteLength > 1048576) {
        throw new Error("Update frame size exceeds 1 MB limit");
      }
      if (
        data.connection.readOnly ||
        syncRegistry.isRoomReadOnly(data.documentName)
      ) {
        throw new Error("Cannot edit in read-only mode");
      }
    },
  });

  return {
    server,
    destroy: async () => {
      await flushAllPending();
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
