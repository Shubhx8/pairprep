import { Server as HocuspocusServer } from "@hocuspocus/server";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as Y from "yjs";
import mongoose from "mongoose";
import { isAllowedOrigin } from "./origin.js";
import { getClientIp, syncUpgradeRateLimiter } from "./rateLimiter.js";
import {
  ConnectionRateLimiter,
  RateLimitError,
  connectionRateLimiter,
} from "./connectionRateLimiter.js";
import { resolvePrincipalFromCookies } from "../auth/sessionPrincipal.js";
import type { Principal } from "../middleware/identity.js";
import {
  syncRegistry,
  type CapacityStats,
  type RoomCapacityStat,
} from "./syncRegistry.js";
import { documentLoadWaiters } from "./documentWaiters.js";

export type { RoomCapacityStat };
export { documentLoadWaiters };
import {
  loadDocument,
  queueUpdate,
  flushRoom,
  takeSnapshot,
  startSnapshotInterval,
  stopSnapshotInterval,
  stopAllSnapshotIntervals,
  drainPersistenceAndSnapshot,
  getPendingPersistenceStats,
  type PersistenceStats,
} from "./persistence.js";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { clientMapRepo } from "../repos/clientMapRepo.js";
import { rootLogger } from "../middleware/logger.js";
import type { IRoom } from "../models/rooms.js";
import type { IRoomMember } from "../models/room_members.js";
import type { RateLimiterStats } from "./connectionRateLimiter.js";

export interface ConnectionStats {
  /** Total physical active WebSocket connections across all rooms */
  activeConnections: number;
  /** Total active rooms with at least one connection */
  activeRooms: number;
  /** Total loaded Yjs documents in memory */
  activeDocuments: number;
  /** Total pending slot reservations during handshake */
  pendingReservations: number;
  /** Cumulative count of upgrade handshakes rejected (bad origin, IP limited, shutting down) */
  upgradeRejections: number;
  /** Cumulative count of onAuthenticate failures (capacity, invalid doc, auth error, shutting down) */
  authenticationFailures: number;
  /** Cumulative count of connections terminated due to rate limit violation */
  rateLimitTerminations: number;
}

export interface SyncServerStats {
  /** Server lifecycle status: 'running' | 'shutting_down' | 'drained' | 'destroyed' */
  status: "running" | "shutting_down" | "drained" | "destroyed";
  /** System uptime of the sync server in seconds */
  uptimeSeconds: number;
  /** Connection metrics */
  connections: ConnectionStats;
  /** Room capacity utilization across active rooms */
  capacity: CapacityStats;
  /** Persistence queue and database durability health */
  persistence: PersistenceStats;
  /** Rate limiter operational metrics */
  rateLimiter: RateLimiterStats & { upgradeIpRateLimitRejections: number };
}

export interface ShutdownOptions {
  drainTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export interface SyncServerInstance {
  server: HocuspocusServer;
  getStats: () => SyncServerStats;
  drainAndShutdown: (options?: ShutdownOptions) => Promise<void>;
  destroy: () => Promise<void>;
  isShuttingDown: () => boolean;
  recordUpgradeRejection: () => void;
}

export interface CreateSyncServerOptions {
  requireAuth?: boolean;
  rateLimiter?: ConnectionRateLimiter;
}

export interface SyncConnectionContext {
  principal?: Principal;
  member?: IRoomMember;
  room?: IRoom;
  readOnly?: boolean;
  [key: string]: unknown;
}

let activeSyncInstance: SyncServerInstance | undefined;

/**
 * Returns operational statistics for the active sync server instance.
 * Safe for operational monitoring; never exposes credentials, tokens, or document content.
 */
export function getSyncServerStats(): SyncServerStats {
  if (activeSyncInstance) {
    return activeSyncInstance.getStats();
  }
  return {
    status: "destroyed",
    uptimeSeconds: 0,
    connections: {
      activeConnections: 0,
      activeRooms: 0,
      activeDocuments: 0,
      pendingReservations: 0,
      upgradeRejections: 0,
      authenticationFailures: 0,
      rateLimitTerminations: 0,
    },
    capacity: {
      totalActiveRooms: 0,
      totalActiveConnections: 0,
      totalPendingReservations: 0,
      maxConnectionsPerRoom: 6,
      roomsWithActiveConnections: 0,
      rooms: [],
    },
    persistence: {
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
    },
    rateLimiter: {
      trackedConnections: 0,
      maxEntries: 10_000,
      rejections: {
        messageRateLimit: 0,
        byteRateLimit: 0,
        capacityExceeded: 0,
        invalidSocketIdentity: 0,
        total: 0,
      },
      upgradeIpRateLimitRejections: 0,
    },
  };
}

/**
 * Creates a Hocuspocus server instance configured with maxPayload, authentication,
 * author attribution tracking, and persistence hooks.
 */
export function createSyncServer(
  options: CreateSyncServerOptions = {}
): SyncServerInstance {
  const requireAuth = options.requireAuth ?? true;
  const rateLimiter = options.rateLimiter ?? connectionRateLimiter;

  const startedAt = Date.now();
  let status: "running" | "shutting_down" | "drained" | "destroyed" = "running";
  let isShuttingDown = false;
  let upgradeRejections = 0;
  let authenticationFailures = 0;
  let rateLimitTerminations = 0;
  let shutdownPromise: Promise<void> | null = null;

  const server = new HocuspocusServer({
    websocketOptions: {
      maxPayload: 1048576, // 1 MB WebSocket frame limit enforced at framing layer
    },
    async onAuthenticate(data) {
      try {
        if (isShuttingDown) {
          throw new Error("Server is shutting down");
        }

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
        documentLoadWaiters.addWaiter(roomId, data.socketId);

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

          if (isShuttingDown) {
            throw new Error("Server is shutting down");
          }

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
          if (isShuttingDown) {
            throw new Error("Server is shutting down");
          }
          if (!room) {
            const err = new Error("Room not found");
            (err as unknown as { reason: string }).reason = "room_not_found";
            throw err;
          }

          // Verify member is part of the room
          const member = await roomMemberRepo.findMember(roomId, principal.id);
          if (isShuttingDown) {
            throw new Error("Server is shutting down");
          }
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

          if (isShuttingDown) {
            throw new Error("Server is shutting down");
          }

          const context = data.context as SyncConnectionContext;
          context.principal = principal;
          context.member = member;
          context.room = room;
          context.readOnly = isReadOnly;
        } else {
          if (isShuttingDown) {
            throw new Error("Server is shutting down");
          }

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
        authenticationFailures++;
        documentLoadWaiters.removeWaiter(data.documentName, data.socketId);
        // Guarantee slot reservation and rate-limiter state are released on every error/failure path
        syncRegistry.cancelReservation(data.socketId, data.documentName);
        const hasActiveConn = !!syncRegistry.getConnection(data.socketId);
        const hasOtherReservation =
          syncRegistry.getReservation(data.socketId) !== undefined;
        if (!hasActiveConn && !hasOtherReservation) {
          rateLimiter.cleanup(data.socketId);
        }
        throw err;
      }
    },
    async connected(data) {
      documentLoadWaiters.removeWaiter(data.documentName, data.socketId);

      if (isShuttingDown) {
        syncRegistry.cancelReservation(data.socketId, data.documentName);
        const hasActiveConn = !!syncRegistry.getConnection(data.socketId);
        const hasOtherReservation =
          syncRegistry.getReservation(data.socketId) !== undefined;
        if (!hasActiveConn && !hasOtherReservation) {
          rateLimiter.cleanup(data.socketId);
        }
        try {
          data.connection?.webSocket?.close(1001, "server_shutting_down");
        } catch {
          // ignore
        }
        return;
      }

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
      const memberRole = context.member?.role;
      syncRegistry.promoteReservation(
        data.socketId,
        data.documentName,
        memberId,
        principal,
        data.connection,
        memberRole
      );
    },
    async onDisconnect(data) {
      const roomId = data.documentName;

      // 1. Flush pending updates and snapshot on disconnect
      await flushRoom(roomId, true);

      // 2. Stop snapshot interval when room is empty
      if (!data.clientsCount || data.clientsCount === 0) {
        stopSnapshotInterval(roomId);
      }

      // 3. Unregister connection from sync registry and clean up rate limiter
      syncRegistry.unregisterConnection(roomId, data.socketId);
      rateLimiter.cleanup(data.socketId);

      // 4. When data.clientsCount === 0, unload the document from Hocuspocus memory
      if (data.clientsCount === 0) {
        await takeSnapshot(roomId, data.document, true);

        const hocuspocusInstance =
          (data.instance as
            | { unloadDocument?: (doc: unknown) => Promise<void> }
            | undefined) ??
          (
            server as unknown as {
              hocuspocus?: { unloadDocument?: (doc: unknown) => Promise<void> };
            }
          ).hocuspocus;

        if (
          hocuspocusInstance &&
          typeof hocuspocusInstance.unloadDocument === "function"
        ) {
          await hocuspocusInstance.unloadDocument(data.document);
        }
      }
    },
    async onLoadDocument(data) {
      const roomId = data.documentName;
      const socketId = data.socketId;

      documentLoadWaiters.addWaiter(roomId, socketId);

      const cleanupFailedLoad = () => {
        // Retrieve and clear exact socket IDs tracked as waiting for this document load
        const waiters = documentLoadWaiters.clearWaiters(roomId);
        const affectedSockets = new Set<string>([socketId, ...waiters]);

        for (const sock of affectedSockets) {
          // Cancel only this socket's reservation for roomId
          syncRegistry.cancelReservation(sock, roomId);
          const hasActiveConn = !!syncRegistry.getConnection(sock);
          const hasOtherReservation =
            syncRegistry.getReservation(sock) !== undefined;
          if (!hasActiveConn && !hasOtherReservation) {
            rateLimiter.cleanup(sock);
          }
        }
      };

      try {
        if (isShuttingDown) {
          throw new Error("Server is shutting down");
        }
        await loadDocument(roomId, data.document);
        if (isShuttingDown) {
          throw new Error("Server is shutting down");
        }
        startSnapshotInterval(roomId, data.document);
        return data.document;
      } catch (err) {
        cleanupFailedLoad();
        throw err;
      }
    },
    async onAwarenessUpdate(data) {
      const roomId = data.documentName;
      let actorId: string | undefined;

      if (data.connection) {
        const ctx = data.connection.context as SyncConnectionContext | undefined;
        actorId = ctx?.principal?.id;
        if (!actorId) {
          const connMeta = syncRegistry.getConnection(data.connection.socketId);
          actorId = connMeta?.memberId;
        }
      }

      if (actorId && mongoose.connection.readyState === 1) {
        const clientIds = new Set<number>();
        if (Array.isArray(data.added)) {
          for (const id of data.added) {
            if (typeof id === "number") clientIds.add(id);
          }
        }
        if (Array.isArray(data.states)) {
          for (const s of data.states) {
            if (typeof s?.clientId === "number") clientIds.add(s.clientId);
          }
        }

        for (const clientId of clientIds) {
          await clientMapRepo.registerClient(roomId, clientId, actorId);
        }
      }
    },
    async onChange(data) {
      const connContext = (data.connection?.context ?? data.context) as SyncConnectionContext | undefined;
      // Always populate doc_updates.authorId strictly from the authenticated connection context,
      // never trusting client-supplied identifiers (PRD ATTR-1 / Non-negotiable security rule #2)
      const authorId =
        connContext?.principal?.id ||
        (typeof data.socketId === "string" && data.socketId.trim()
          ? data.socketId
          : "anonymous");
      queueUpdate(data.documentName, authorId, data.update, data.document);

      // Register Yjs clientIds from update metadata to authenticated actorId (first claim wins)
      if (connContext?.principal?.id && mongoose.connection.readyState === 1) {
        try {
          const meta = Y.parseUpdateMeta(data.update);
          for (const clientId of meta.from.keys()) {
            if (typeof clientId === "number") {
              await clientMapRepo.registerClient(
                data.documentName,
                clientId,
                connContext.principal.id
              );
            }
          }
        } catch (err) {
          // Asynchronous client_map failures should be logged so they are observable
          rootLogger.warn(
            { err, roomId: data.documentName, authorId },
            "Failed to register client_map attribution from onChange update"
          );
        }
      }
    },
    async beforeHandleMessage(data) {
      if (isShuttingDown) {
        data.connection.readOnly = true;
        // Drop any inbound message frames during server shutdown
        return;
      }

      if (data.update.byteLength > 1048576) {
        throw new Error("Update frame size exceeds 1 MB limit");
      }

      // Enforce per-connection message rate and byte throughput limits (flood defense)
      const socketId = data.socketId;
      if (!socketId || typeof socketId !== "string" || !socketId.trim()) {
        rateLimitTerminations++;
        rootLogger.warn(
          {
            roomId: data.documentName,
            socketId,
          },
          "Missing or invalid socket identity in beforeHandleMessage; terminating connection"
        );
        try {
          data.connection?.webSocket?.close(4029, "invalid_socket_identity");
        } catch {
          // ignore already closed
        }
        throw new RateLimitError("invalid_socket_identity");
      }

      const rateCheck = rateLimiter.consume(socketId, data.update.byteLength);
      if (!rateCheck.allowed) {
        rateLimitTerminations++;
        rootLogger.warn(
          {
            socketId,
            roomId: data.documentName,
            reason: rateCheck.reason,
            byteLength: data.update.byteLength,
          },
          "WebSocket message rate/volume limit exceeded; terminating connection"
        );
        try {
          data.connection?.webSocket?.close(4029, rateCheck.reason);
        } catch {
          // ignore already closed
        }
        throw new RateLimitError(rateCheck.reason);
      }

      if (syncRegistry.isRoomReadOnly(data.documentName)) {
        data.connection.readOnly = true;
      }
    },
    async beforeHandleAwareness(data) {
      if (isShuttingDown) {
        if (data.states && typeof data.states.clear === "function") {
          data.states.clear();
        }
        if (data.removedClients && typeof data.removedClients.clear === "function") {
          data.removedClients.clear();
        }
        return;
      }
    },
  });

  const drainAndShutdown = (opts: ShutdownOptions = {}): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const drainTimeoutMs = opts.drainTimeoutMs ?? 3000;
      const startTime = Date.now();

      // Phase A: Enter shutdown (synchronous state change)
      status = "shutting_down";
      isShuttingDown = true;

      // Phase B & C: Lock edits, stop snapshot timers, drain connections
      syncRegistry.setAllRoomsReadOnly();
      stopAllSnapshotIntervals();

      // Close all active connections cleanly with 1001 server_shutting_down
      syncRegistry.closeAllConnections(1001, "server_shutting_down");

      try {
        const crossws = (server as unknown as Record<string, unknown>)["crossws"] as
          | { closeAll?: (code: number, data: string, force: boolean) => void }
          | undefined;
        if (typeof crossws?.closeAll === "function") {
          crossws.closeAll(1001, "server_shutting_down", false);
        }
      } catch {
        // ignore
      }

      // Wait up to drainTimeoutMs for connections to unregister
      while (
        syncRegistry.getActiveConnectionCount() > 0 &&
        Date.now() - startTime < drainTimeoutMs
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // If any connections remain after drain timeout, force-terminate transports
      if (syncRegistry.getActiveConnectionCount() > 0) {
        rootLogger.warn(
          { remaining: syncRegistry.getActiveConnectionCount() },
          "Forcing WebSocket termination after drain timeout"
        );
        try {
          const crossws = (server as unknown as Record<string, unknown>)["crossws"] as
            | { closeAll?: (code: number, data: string, force: boolean) => void }
            | undefined;
          if (typeof crossws?.closeAll === "function") {
            crossws.closeAll(1001, "server_shutting_down", true);
          }
        } catch {
          // ignore
        }
        syncRegistry.forceDestroyAllTransports();
      }

      status = "drained";

      // Phase D: Drain persistence and take consistent final snapshots
      await drainPersistenceAndSnapshot({ takeFinalSnapshots: true });

      // Phase E: Destroy server and reset state
      await server.destroy();
      syncRegistry.resetAll();
      rateLimiter.resetAll();
      documentLoadWaiters.resetAll();
      status = "destroyed";
    })();

    return shutdownPromise;
  };

  const syncInstance: SyncServerInstance = {
    server,
    getStats: (): SyncServerStats => {
      const capacity = syncRegistry.getCapacityStats();
      const persistence = getPendingPersistenceStats();
      const rateLimiterStats = rateLimiter.getStats();

      return {
        status,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        connections: {
          activeConnections: syncRegistry.getActiveConnectionCount(),
          activeRooms: syncRegistry.getActiveRoomCount(),
          activeDocuments:
            (server as unknown as { hocuspocus?: { getDocumentsCount?: () => number } })
              .hocuspocus?.getDocumentsCount?.() ?? 0,
          pendingReservations: syncRegistry.getPendingReservationCount(),
          upgradeRejections,
          authenticationFailures,
          rateLimitTerminations,
        },
        capacity,
        persistence,
        rateLimiter: {
          ...rateLimiterStats,
          upgradeIpRateLimitRejections: syncUpgradeRateLimiter.getTotalRejections(),
        },
      };
    },
    drainAndShutdown,
    destroy: () => drainAndShutdown(),
    isShuttingDown: () => isShuttingDown,
    recordUpgradeRejection: () => {
      upgradeRejections++;
    },
  };

  activeSyncInstance = syncInstance;
  return syncInstance;
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

      // Reject all new upgrade attempts immediately during server shutdown
      if (syncInstance.isShuttingDown()) {
        syncInstance.recordUpgradeRejection();
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\n\r\n"
        );
        socket.destroy();
        return;
      }

      const clientIp = getClientIp(request);

      // 1. IP rate limiter (checks rejected connection attempts)
      if (syncUpgradeRateLimiter.isRateLimited(clientIp)) {
        syncInstance.recordUpgradeRejection();
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n"
        );
        socket.destroy();
        return;
      }

      // 2. Strict allowed Origin check
      if (!isAllowedOrigin(request.headers.origin)) {
        syncInstance.recordUpgradeRejection();
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
