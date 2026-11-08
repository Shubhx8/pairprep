import type { Principal } from "../middleware/identity.js";
import type { CloseEvent } from "@hocuspocus/common";
import crypto from "node:crypto";

export const MAX_ROOM_MEMBERS = 6;
export const MAX_ROOM_CONNECTIONS = 6;
export const MAX_MEMBER_CONNECTIONS = 3;
export const RESERVATION_TTL_MS = 10_000;
export const RESERVATION_LEASE_TTL_MS = 10_000;
export const RESERVATION_HEARTBEAT_MS = 3_000;
export const MAX_HANDSHAKE_DURATION_MS = 30_000;

export interface SyncConnectionLike {
  readOnly: boolean;
  webSocket?: {
    close: (code?: number, reason?: string) => void;
  };
  close?: (event?: CloseEvent) => void;
  socketId?: string;
}

export interface RoomCapacityStat {
  roomIndex: number;
  activeConnections: number;
  pendingReservations: number;
  distinctMembers: number;
  maxConnections: number;
  isReadOnly: boolean;
}

export interface CapacityStats {
  totalActiveRooms: number;
  totalActiveConnections: number;
  totalPendingReservations: number;
  maxConnectionsPerRoom: number;
  roomsWithActiveConnections: number;
  rooms: RoomCapacityStat[];
}

export interface ConnectionReservation {
  token: string;
  socketId: string;
  roomId: string;
  memberId?: string;
  reservedAt: number;
  leaseExpiresAt: number;
  hardDeadlineAt: number;
  cancelled: boolean;
  cancellationReason?: string;
}

export interface ActiveConnection {
  socketId: string;
  roomId: string;
  memberId: string;
  principal:
    | Principal
    | { type: string; id: string; displayName: string; [key: string]: unknown };
  connection: SyncConnectionLike;
  connectedAt: number;
  memberRole?: string;
}

export type PromotionFailureReason =
  | "reservation_missing"
  | "reservation_expired"
  | "reservation_cancelled"
  | "reservation_token_mismatch"
  | "room_mismatch"
  | "identity_mismatch"
  | "server_shutting_down"
  | "room_unavailable"
  | "room_capacity_exceeded"
  | "member_capacity_exceeded"
  | "distinct_member_limit_exceeded";

export type PromotionResult =
  | { success: true }
  | { success: false; reason: PromotionFailureReason };

/**
 * PRD ROOM-4 & T07 Sync Registry
 * Enforces:
 * 1. Strict room capacity limit: at most 6 total active WebSocket connections per room.
 * 2. Per-member connection limit: at most 3 connections per member within the room.
 * 3. Synchronous reservation before async authentication, released on every error/disconnect path.
 * 4. Closing all connections for a member upon kick/leave (closeConnectionsForMember).
 * 5. Dynamic read-only locking for a room (setRoomReadOnly).
 * 6. Bounded renewable lease with heartbeat and hard handshake deadline.
 * 7. Room-scoped compound reservation identity `${roomId}:${socketId}` preventing multi-room collision.
 * 8. Atomic promotion revalidation.
 */
export class SyncRegistry {
  private reservations = new Map<string, ConnectionReservation>(); // `${roomId}:${socketId}` -> ConnectionReservation
  private heartbeatTimers = new Map<string, NodeJS.Timeout>(); // `${roomId}:${socketId}` -> Timeout
  private transportCleanupFns = new Map<string, () => void>(); // `${roomId}:${socketId}` -> cleanup callback
  private activeConnections = new Map<string, ActiveConnection>(); // `${roomId}:${socketId}` -> ActiveConnection
  private roomActiveSockets = new Map<string, Set<string>>(); // roomId -> Set<socketId>
  private memberSockets = new Map<string, Set<string>>(); // `${roomId}:${memberId}` -> Set<socketId>
  private readOnlyRooms = new Set<string>(); // roomId
  private backpressuredRooms = new Set<string>(); // roomId in persistence backpressure
  private readOnlyMembers = new Set<string>(); // `${roomId}:${memberId}`
  private deletedRooms = new Set<string>(); // roomId
  private roomMetadata = new Map<
    string,
    {
      status: "open" | "live" | "ended" | "archived";
      type?: string;
      startedAt?: Date | null;
    }
  >();
  private isShuttingDownState = false;

  private makeKey(roomId: string, socketId: string): string {
    return `${roomId}:${socketId}`;
  }

  /**
   * Prunes reservations that are cancelled, expired, or past their absolute handshake deadline.
   */
  private pruneExpiredReservations(now = Date.now()): void {
    for (const [key, res] of this.reservations.entries()) {
      if (res.cancelled || now > res.leaseExpiresAt || now >= res.hardDeadlineAt) {
        this.stopHeartbeat(res.roomId, res.socketId);
        this.reservations.delete(key);
      }
    }
  }

  /**
   * Starts an interval heartbeat that automatically renews the lease while the handshake is in flight.
   * Cancels the reservation if the absolute hard handshake deadline is reached.
   */
  startHeartbeat(roomId: string, socketId: string, token: string): void {
    const key = this.makeKey(roomId, socketId);
    this.stopHeartbeat(roomId, socketId);

    const timer = setInterval(() => {
      const now = Date.now();
      const res = this.reservations.get(key);
      if (!res || res.cancelled || res.token !== token) {
        this.stopHeartbeat(roomId, socketId);
        return;
      }

      if (now >= res.hardDeadlineAt) {
        res.cancelled = true;
        res.cancellationReason = "handshake_deadline_exceeded";
        this.stopHeartbeat(roomId, socketId);
        this.reservations.delete(key);
        return;
      }

      // Renew lease
      res.leaseExpiresAt = now + RESERVATION_LEASE_TTL_MS;
    }, RESERVATION_HEARTBEAT_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.heartbeatTimers.set(key, timer);
  }

  /**
   * Stops the lease heartbeat timer for a specific room and socket.
   */
  stopHeartbeat(roomId: string, socketId: string): void {
    const key = this.makeKey(roomId, socketId);
    const timer = this.heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(key);
    }
  }

  /**
   * Stops all active heartbeat timers across all reservations.
   */
  stopAllHeartbeats(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
  }

  /**
   * Checks whether an active heartbeat timer exists for the reservation.
   */
  hasHeartbeat(roomId: string, socketId: string): boolean {
    return this.heartbeatTimers.has(this.makeKey(roomId, socketId));
  }

  /**
   * Returns count of all active heartbeat timers.
   */
  getHeartbeatTimerCount(): number {
    return this.heartbeatTimers.size;
  }

  /**
   * Registers an early transport-level closure listener on the incoming socket or WebSocket.
   * When the physical transport terminates prior to reservation promotion, this cancels
   * the reservation and halts heartbeat renewal immediately (0 ms delay).
   */
  registerTransportCloseListener(
    roomId: string,
    socketId: string,
    token: string,
    target: {
      on?: (event: string, fn: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string, fn: (...args: unknown[]) => void) => unknown;
      off?: (event: string, fn: (...args: unknown[]) => void) => unknown;
      destroyed?: boolean;
      closed?: boolean;
      readyState?: number | string;
    },
    onAborted?: (reason: string) => void
  ): boolean {
    const key = this.makeKey(roomId, socketId);
    this.removeTransportCloseListener(roomId, socketId);

    const res = this.reservations.get(key);
    if (!res || res.cancelled || res.token !== token) {
      return false;
    }

    const isTransportClosed = (t: typeof target): boolean => {
      return Boolean(
        t.destroyed ||
        t.closed ||
        t.readyState === 2 ||
        t.readyState === 3 ||
        t.readyState === "closed"
      );
    };

    // If the socket is already destroyed or in closing/closed readyState, cancel immediately
    if (isTransportClosed(target)) {
      this.cancelReservation(socketId, roomId, "socket_closed");
      onAborted?.("socket_already_closed");
      return false;
    }

    if (typeof target.on !== "function") {
      return false;
    }

    const onClose = () => {
      const current = this.reservations.get(key);
      if (current && !current.cancelled && current.token === token) {
        this.cancelReservation(socketId, roomId, "socket_closed");
        onAborted?.("socket_closed");
      }
      this.removeTransportCloseListener(roomId, socketId);
    };

    target.on("close", onClose);
    target.on("end", onClose);
    target.on("error", onClose);

    const cleanup = () => {
      target.removeListener?.("close", onClose);
      target.removeListener?.("end", onClose);
      target.removeListener?.("error", onClose);
      target.off?.("close", onClose);
      target.off?.("end", onClose);
      target.off?.("error", onClose);
    };

    this.transportCleanupFns.set(key, cleanup);

    // Defensive post-registration check: if transport closed or destroyed during listener registration
    if (isTransportClosed(target)) {
      this.removeTransportCloseListener(roomId, socketId);
      const current = this.reservations.get(key);
      if (current && !current.cancelled && current.token === token) {
        this.cancelReservation(socketId, roomId, "socket_closed");
        onAborted?.("socket_already_closed");
      }
      return false;
    }

    return true;
  }

  /**
   * Removes and cleans up the transport close listener for a given room and socket.
   */
  removeTransportCloseListener(roomId: string, socketId: string): void {
    const key = this.makeKey(roomId, socketId);
    const cleanup = this.transportCleanupFns.get(key);
    if (cleanup) {
      try {
        cleanup();
      } catch {
        // ignore
      }
      this.transportCleanupFns.delete(key);
    }
  }

  /**
   * Cleans up and clears all transport closure listeners.
   */
  clearAllTransportCloseListeners(): void {
    for (const cleanup of this.transportCleanupFns.values()) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    this.transportCleanupFns.clear();
  }

  /**
   * Returns whether a transport closure listener is currently registered.
   */
  hasTransportCloseListener(roomId: string, socketId: string): boolean {
    return this.transportCleanupFns.has(this.makeKey(roomId, socketId));
  }

  /**
   * Returns the count of active transport closure listeners across all reservations.
   */
  getTransportCloseListenerCount(): number {
    return this.transportCleanupFns.size;
  }

  /**
   * Returns total count of active connections and valid pending reservations for a room.
   */
  getTotalRoomCount(roomId: string, now = Date.now()): number {
    this.pruneExpiredReservations(now);
    const activeCount = this.roomActiveSockets.get(roomId)?.size ?? 0;
    let reservedCount = 0;
    for (const res of this.reservations.values()) {
      if (
        res.roomId === roomId &&
        !res.cancelled &&
        now <= res.leaseExpiresAt &&
        now < res.hardDeadlineAt
      ) {
        reservedCount++;
      }
    }
    return activeCount + reservedCount;
  }

  /**
   * Returns total count of active connections and valid pending reservations for a specific member in a room.
   */
  getTotalMemberCount(
    roomId: string,
    memberId: string,
    now = Date.now(),
    excludeSocketId?: string
  ): number {
    this.pruneExpiredReservations(now);
    const memberKey = `${roomId}:${memberId}`;
    const activeCount = this.memberSockets.get(memberKey)?.size ?? 0;
    let reservedCount = 0;
    for (const res of this.reservations.values()) {
      if (
        res.roomId === roomId &&
        res.memberId === memberId &&
        res.socketId !== excludeSocketId &&
        !res.cancelled &&
        now <= res.leaseExpiresAt &&
        now < res.hardDeadlineAt
      ) {
        reservedCount++;
      }
    }
    return activeCount + reservedCount;
  }

  /**
   * Synchronously attempts to reserve a connection slot in the room.
   * Atomically verifies that total active + reserved connections is strictly below MAX_ROOM_CONNECTIONS (6).
   */
  reserveSlot(
    roomId: string,
    socketId: string,
    now = Date.now(),
    token = crypto.randomUUID()
  ):
    | { success: true; token: string }
    | {
        success: false;
        reason: "room_capacity_exceeded" | "server_shutting_down" | "room_unavailable";
      } {
    if (this.isShuttingDownState) {
      return { success: false, reason: "server_shutting_down" };
    }
    if (this.deletedRooms.has(roomId)) {
      return { success: false, reason: "room_unavailable" };
    }
    this.pruneExpiredReservations(now);
    if (this.getTotalRoomCount(roomId, now) >= MAX_ROOM_CONNECTIONS) {
      return { success: false, reason: "room_capacity_exceeded" };
    }

    const key = this.makeKey(roomId, socketId);
    this.stopHeartbeat(roomId, socketId);

    const res: ConnectionReservation = {
      token,
      socketId,
      roomId,
      reservedAt: now,
      leaseExpiresAt: now + RESERVATION_LEASE_TTL_MS,
      hardDeadlineAt: now + MAX_HANDSHAKE_DURATION_MS,
      cancelled: false,
    };
    this.reservations.set(key, res);
    this.startHeartbeat(roomId, socketId, token);
    return { success: true, token };
  }

  /**
   * Checks whether a pending reservation is still valid, unexpired, and not cancelled.
   */
  isReservationValid(
    roomId: string,
    socketId: string,
    token?: string,
    now = Date.now()
  ): boolean {
    if (this.isShuttingDownState) return false;
    if (this.deletedRooms.has(roomId)) return false;
    const res = this.reservations.get(this.makeKey(roomId, socketId));
    if (!res || res.cancelled) return false;
    if (token && res.token !== token) return false;
    if (now > res.leaseExpiresAt || now >= res.hardDeadlineAt) return false;
    return true;
  }

  /**
   * Touches/renews a reservation lease explicitly (e.g. across asynchronous boundaries).
   */
  touchReservation(
    roomId: string,
    socketId: string,
    tokenOrNow?: string | number,
    maybeNow?: number
  ): boolean {
    const key = this.makeKey(roomId, socketId);
    const res = this.reservations.get(key);
    if (!res || res.cancelled) return false;

    let token: string | undefined;
    let now = Date.now();

    if (typeof tokenOrNow === "number") {
      now = tokenOrNow;
    } else if (typeof tokenOrNow === "string") {
      token = tokenOrNow;
      if (typeof maybeNow === "number") {
        now = maybeNow;
      }
    }

    if (token && res.token !== token) return false;
    if (now >= res.hardDeadlineAt) {
      res.cancelled = true;
      res.cancellationReason = "reservation_expired";
      this.stopHeartbeat(roomId, socketId);
      return false;
    }
    res.leaseExpiresAt = now + RESERVATION_LEASE_TTL_MS;
    return true;
  }

  /**
   * Returns all distinct member IDs currently connected or holding active reservations in the room.
   */
  getDistinctMembers(roomId: string, now = Date.now()): Set<string> {
    this.pruneExpiredReservations(now);
    const members = new Set<string>();
    // 1. Members with active connections
    for (const [memberKey, sockets] of this.memberSockets.entries()) {
      if (memberKey.startsWith(`${roomId}:`) && sockets.size > 0) {
        const memberId = memberKey.slice(roomId.length + 1);
        members.add(memberId);
      }
    }
    // 2. Members with pending reservations
    for (const res of this.reservations.values()) {
      if (
        res.roomId === roomId &&
        res.memberId &&
        !res.cancelled &&
        now <= res.leaseExpiresAt &&
        now < res.hardDeadlineAt
      ) {
        members.add(res.memberId);
      }
    }
    return members;
  }

  /**
   * Returns the count of distinct members in the room.
   */
  getDistinctMemberCount(roomId: string, now = Date.now()): number {
    return this.getDistinctMembers(roomId, now).size;
  }

  /**
   * Verifies that adding a connection for memberId does not exceed the maximum of 6 distinct members.
   * If the member is already present in the room, it does not add a new distinct member.
   */
  checkDistinctMemberLimit(
    roomId: string,
    memberId: string,
    now = Date.now()
  ): boolean {
    const distinct = this.getDistinctMembers(roomId, now);
    if (distinct.has(memberId)) {
      return true;
    }
    return distinct.size < MAX_ROOM_MEMBERS;
  }

  /**
   * Checks if member has connection capacity (strictly < MAX_MEMBER_CONNECTIONS = 3).
   */
  checkMemberLimit(
    roomId: string,
    memberId: string,
    now = Date.now(),
    excludeSocketId?: string
  ): boolean {
    return (
      this.getTotalMemberCount(roomId, memberId, now, excludeSocketId) <
      MAX_MEMBER_CONNECTIONS
    );
  }

  /**
   * Associates a memberId with an active reservation once principal is resolved.
   */
  assignMemberToReservation(
    socketId: string,
    memberId: string,
    roomId?: string,
    token?: string
  ): boolean {
    if (roomId) {
      const res = this.reservations.get(this.makeKey(roomId, socketId));
      if (!res || res.cancelled || (token && res.token !== token)) return false;
      res.memberId = memberId;
      return true;
    }
    for (const res of this.reservations.values()) {
      if (
        res.socketId === socketId &&
        !res.cancelled &&
        (!token || res.token === token)
      ) {
        res.memberId = memberId;
        return true;
      }
    }
    return false;
  }

  /**
   * Cancels a pending reservation on auth failure, permission denial, failed document load, or socket error.
   * If roomId is specified, cancels only the reservation for that exact room.
   */
  cancelReservation(
    socketId: string,
    roomId?: string,
    reason = "cancelled"
  ): void {
    if (roomId) {
      const key = this.makeKey(roomId, socketId);
      const res = this.reservations.get(key);
      if (res) {
        res.cancelled = true;
        res.cancellationReason = reason;
        this.stopHeartbeat(roomId, socketId);
        this.removeTransportCloseListener(roomId, socketId);
        this.reservations.delete(key);
      }
      return;
    }
    for (const [key, res] of this.reservations.entries()) {
      if (res.socketId === socketId) {
        res.cancelled = true;
        res.cancellationReason = reason;
        this.stopHeartbeat(res.roomId, socketId);
        this.removeTransportCloseListener(res.roomId, socketId);
        this.reservations.delete(key);
      }
    }
  }

  /**
   * Returns a pending reservation by its socket ID and optional room ID.
   */
  getReservation(
    socketId: string,
    roomId?: string
  ): ConnectionReservation | undefined {
    if (roomId) {
      return this.reservations.get(this.makeKey(roomId, socketId));
    }
    for (const res of this.reservations.values()) {
      if (res.socketId === socketId && !res.cancelled) {
        return res;
      }
    }
    return undefined;
  }

  /**
   * Checks whether any valid uncancelled reservation exists for a socket ID.
   */
  hasReservationForSocket(socketId: string, roomId?: string): boolean {
    if (roomId) {
      const res = this.reservations.get(this.makeKey(roomId, socketId));
      return !!res && !res.cancelled;
    }
    for (const res of this.reservations.values()) {
      if (res.socketId === socketId && !res.cancelled) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns all socket IDs that currently hold a pending reservation for the given room.
   */
  getPendingReservationsForRoom(roomId: string, now = Date.now()): string[] {
    this.pruneExpiredReservations(now);
    const sockets: string[] = [];
    for (const res of this.reservations.values()) {
      if (
        res.roomId === roomId &&
        !res.cancelled &&
        now <= res.leaseExpiresAt &&
        now < res.hardDeadlineAt
      ) {
        sockets.push(res.socketId);
      }
    }
    return sockets;
  }

  /**
   * Atomically and synchronously promotes a reservation to an active connection once connected hook fires.
   * Revalidates reservation existence, non-expiration, room capacity, member capacity, and distinct limits.
   */
  promoteReservation(
    socketId: string,
    roomId: string,
    memberId: string,
    principal:
      | Principal
      | { type: string; id: string; displayName: string; [key: string]: unknown },
    connection: SyncConnectionLike,
    memberRole?: string,
    expectedToken?: string,
    now = Date.now()
  ): PromotionResult {
    if (this.isShuttingDownState) {
      return { success: false, reason: "server_shutting_down" };
    }
    if (this.deletedRooms.has(roomId)) {
      return { success: false, reason: "room_unavailable" };
    }

    const key = this.makeKey(roomId, socketId);
    const res = this.reservations.get(key);
    if (!res) {
      return { success: false, reason: "reservation_missing" };
    }
    if (res.cancelled) {
      return {
        success: false,
        reason:
          res.cancellationReason === "reservation_expired"
            ? "reservation_expired"
            : res.cancellationReason === "room_unavailable"
              ? "room_unavailable"
              : "reservation_cancelled",
      };
    }
    if (expectedToken && res.token !== expectedToken) {
      return { success: false, reason: "reservation_token_mismatch" };
    }
    if (res.roomId !== roomId) {
      return { success: false, reason: "room_mismatch" };
    }
    if (res.memberId && res.memberId !== memberId) {
      return { success: false, reason: "identity_mismatch" };
    }

    if (now > res.leaseExpiresAt || now >= res.hardDeadlineAt) {
      this.cancelReservation(socketId, roomId, "reservation_expired");
      return { success: false, reason: "reservation_expired" };
    }

    const activeCount = this.roomActiveSockets.get(roomId)?.size ?? 0;
    if (activeCount >= MAX_ROOM_CONNECTIONS) {
      this.cancelReservation(socketId, roomId, "room_capacity_exceeded");
      return { success: false, reason: "room_capacity_exceeded" };
    }

    const memberKey = `${roomId}:${memberId}`;
    const memberActiveCount = this.memberSockets.get(memberKey)?.size ?? 0;
    if (memberActiveCount >= MAX_MEMBER_CONNECTIONS) {
      this.cancelReservation(socketId, roomId, "member_capacity_exceeded");
      return { success: false, reason: "member_capacity_exceeded" };
    }

    if (!this.checkDistinctMemberLimit(roomId, memberId, now)) {
      this.cancelReservation(socketId, roomId, "distinct_member_limit_exceeded");
      return { success: false, reason: "distinct_member_limit_exceeded" };
    }

    // Atomic promotion success: transition from reservation to active connection
    this.stopHeartbeat(roomId, socketId);
    this.removeTransportCloseListener(roomId, socketId);
    this.reservations.delete(key);

    const activeConn: ActiveConnection = {
      socketId,
      roomId,
      memberId,
      principal,
      connection,
      memberRole,
      connectedAt: now,
    };

    this.activeConnections.set(key, activeConn);

    if (!this.roomActiveSockets.has(roomId)) {
      this.roomActiveSockets.set(roomId, new Set());
    }
    this.roomActiveSockets.get(roomId)!.add(socketId);

    if (!this.memberSockets.has(memberKey)) {
      this.memberSockets.set(memberKey, new Set());
    }
    this.memberSockets.get(memberKey)!.add(socketId);

    activeConn.connection.readOnly = this.calculateEffectiveReadOnly(activeConn);
    return { success: true };
  }

  /**
   * Returns an active connection by its socket ID and optional room ID.
   */
  getConnection(socketId: string, roomId?: string): ActiveConnection | undefined {
    if (roomId) {
      return this.activeConnections.get(this.makeKey(roomId, socketId));
    }
    for (const active of this.activeConnections.values()) {
      if (active.socketId === socketId) {
        return active;
      }
    }
    return undefined;
  }

  /**
   * Checks whether an active connection exists for the socket.
   */
  hasActiveConnection(socketId: string, roomId?: string): boolean {
    return this.getConnection(socketId, roomId) !== undefined;
  }

  /**
   * Unregisters a connection on disconnect.
   */
  unregisterConnection(roomId: string, socketId: string): void {
    const key = this.makeKey(roomId, socketId);
    this.stopHeartbeat(roomId, socketId);
    this.reservations.delete(key);

    const active = this.activeConnections.get(key);
    if (active) {
      this.activeConnections.delete(key);
      const roomSet = this.roomActiveSockets.get(roomId);
      if (roomSet) {
        roomSet.delete(socketId);
        if (roomSet.size === 0) {
          this.roomActiveSockets.delete(roomId);
        }
      }
      const memberKey = `${roomId}:${active.memberId}`;
      const memberSet = this.memberSockets.get(memberKey);
      if (memberSet) {
        memberSet.delete(socketId);
        if (memberSet.size === 0) {
          this.memberSockets.delete(memberKey);
        }
      }
    }
  }

  /**
   * Closes all active connections and cancels pending reservations for a member in a room.
   * Returns the count of closed sockets.
   */
  closeConnectionsForMember(
    roomId: string,
    memberId: string,
    code = 4000,
    reason = "removed"
  ): number {
    // 1. Cancel all matching pending reservations for this member in this room
    for (const [key, res] of this.reservations.entries()) {
      if (res.roomId === roomId && res.memberId === memberId) {
        res.cancelled = true;
        res.cancellationReason = reason;
        this.stopHeartbeat(roomId, res.socketId);
        this.removeTransportCloseListener(roomId, res.socketId);
        this.reservations.delete(key);
      }
    }

    const memberKey = `${roomId}:${memberId}`;
    const sockets = this.memberSockets.get(memberKey);
    if (!sockets || sockets.size === 0) return 0;

    let closed = 0;
    const socketIds = Array.from(sockets);
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(this.makeKey(roomId, socketId));
      if (active) {
        try {
          const conn = active.connection as {
            close?: (opts?: { code?: number; reason?: string }) => void;
            webSocket?: { close?: (code?: number, reason?: string) => void };
          };
          if (typeof conn.close === "function") {
            conn.close({ code, reason });
          } else if (
            conn.webSocket &&
            typeof conn.webSocket.close === "function"
          ) {
            conn.webSocket.close(code, reason);
          }
        } catch {
          // ignore already closed
        }
        this.unregisterConnection(roomId, socketId);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Returns active connections for a given room.
   */
  getActiveConnectionsForRoom(roomId: string): ActiveConnection[] {
    const sockets = this.roomActiveSockets.get(roomId);
    if (!sockets) return [];
    const conns: ActiveConnection[] = [];
    for (const socketId of sockets) {
      const active = this.activeConnections.get(this.makeKey(roomId, socketId));
      if (active) conns.push(active);
    }
    return conns;
  }

  /**
   * Sets member's active connections in a room to read-only or writable.
   */
  setMemberReadOnly(
    roomId: string,
    memberId: string,
    readOnly = true,
    newRole?: string
  ): number {
    const memberKey = `${roomId}:${memberId}`;
    if (readOnly) {
      this.readOnlyMembers.add(memberKey);
    } else {
      this.readOnlyMembers.delete(memberKey);
    }

    const sockets = this.memberSockets.get(memberKey);
    if (!sockets || sockets.size === 0) return 0;

    let updated = 0;
    for (const socketId of sockets) {
      const active = this.activeConnections.get(this.makeKey(roomId, socketId));
      if (active) {
        if (newRole) active.memberRole = newRole;
        active.connection.readOnly = this.calculateEffectiveReadOnly(active);
        updated++;
      }
    }
    return updated;
  }

  /**
   * Closes all active connections and cancels all pending reservations in a room.
   */
  closeAllConnectionsForRoom(
    roomId: string,
    code = 1000,
    reason = "room_closed"
  ): number {
    // 1. Cancel all matching pending reservations for this room
    for (const [key, res] of this.reservations.entries()) {
      if (res.roomId === roomId) {
        res.cancelled = true;
        res.cancellationReason = reason;
        this.stopHeartbeat(roomId, res.socketId);
        this.removeTransportCloseListener(roomId, res.socketId);
        this.reservations.delete(key);
      }
    }

    const sockets = this.roomActiveSockets.get(roomId);
    if (!sockets || sockets.size === 0) return 0;

    let closed = 0;
    const socketIds = Array.from(sockets);
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(this.makeKey(roomId, socketId));
      if (active) {
        try {
          const conn = active.connection as {
            close?: (opts?: { code?: number; reason?: string }) => void;
            webSocket?: { close?: (code?: number, reason?: string) => void };
          };
          if (typeof conn.close === "function") {
            conn.close({ code, reason });
          } else if (
            conn.webSocket &&
            typeof conn.webSocket.close === "function"
          ) {
            conn.webSocket.close(code, reason);
          }
        } catch {
          // ignore already closed
        }
        this.unregisterConnection(roomId, socketId);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Marks a room as deleted. Immediately revokes pending reservations and closes active connections.
   */
  markRoomDeleted(roomId: string): void {
    this.deletedRooms.add(roomId);
    this.closeAllConnectionsForRoom(roomId, 1000, "room_deleted");
  }

  /**
   * Updates interview candidate permissions based on room live status.
   */
  syncCandidatePermissions(roomId: string, isLive: boolean): number {
    const existing = this.roomMetadata.get(roomId);
    this.roomMetadata.set(roomId, {
      ...existing,
      status: isLive ? "live" : "open",
      startedAt: isLive ? (existing?.startedAt ?? new Date()) : null,
    });

    let updated = 0;
    const sockets = this.roomActiveSockets.get(roomId);
    if (!sockets) return 0;

    for (const socketId of sockets) {
      const active = this.activeConnections.get(this.makeKey(roomId, socketId));
      if (active) {
        const prev = active.connection.readOnly;
        active.connection.readOnly = this.calculateEffectiveReadOnly(active);
        if (active.connection.readOnly !== prev) {
          updated++;
        }
      }
    }
    return updated;
  }

  /**
   * Coordinates in-memory room permissions when room lifecycle changes.
   */
  updateRoomLifecycle(
    roomId: string,
    status: "open" | "live" | "ended" | "archived",
    type?: string,
    startedAt?: Date | null
  ): void {
    const existing = this.roomMetadata.get(roomId);
    this.roomMetadata.set(roomId, {
      ...existing,
      status,
      type: type ?? existing?.type,
      startedAt: startedAt !== undefined ? startedAt : existing?.startedAt,
    });

    if (status === "ended" || status === "archived") {
      this.setRoomReadOnly(roomId);
    } else {
      const sockets = this.roomActiveSockets.get(roomId);
      if (sockets) {
        for (const socketId of sockets) {
          const active = this.activeConnections.get(this.makeKey(roomId, socketId));
          if (active) {
            active.connection.readOnly = this.calculateEffectiveReadOnly(active);
          }
        }
      }
    }
  }

  /**
   * Authoritative effective permission calculation.
   * A connection is read-only if ANY of the following apply:
   * 1. Server is shutting down.
   * 2. Room is permanently marked read-only (e.g. document > 2 MB cap).
   * 3. Room is currently backpressured by persistence queue depth.
   * 4. Room lifecycle status is 'ended' or 'archived'.
   * 5. Member role is 'viewer'.
   * 6. Interview candidate outside the active live window (not live or not started).
   * 7. Member was explicitly muted via setMemberReadOnly.
   */
  calculateEffectiveReadOnly(active: ActiveConnection): boolean {
    if (this.isShuttingDownState) {
      return true;
    }

    const roomId = active.roomId;
    if (this.readOnlyRooms.has(roomId)) {
      return true;
    }

    if (this.backpressuredRooms.has(roomId)) {
      return true;
    }

    const roomMeta = this.roomMetadata.get(roomId);
    if (roomMeta) {
      if (roomMeta.status === "ended" || roomMeta.status === "archived") {
        return true;
      }
    }

    const role =
      active.memberRole ??
      (active.principal as { role?: string })?.role;
    if (role === "viewer") {
      return true;
    }

    if (role === "candidate") {
      if (!roomMeta || roomMeta.status !== "live") {
        return true;
      }
    }

    const memberKey = `${roomId}:${active.memberId}`;
    if (this.readOnlyMembers.has(memberKey)) {
      return true;
    }

    return false;
  }

  /**
   * Sets server shutdown state, cancels all pending reservations, and forces all active connections to read-only.
   */
  setShutdown(isShuttingDown: boolean): void {
    this.isShuttingDownState = isShuttingDown;
    if (isShuttingDown) {
      for (const res of this.reservations.values()) {
        res.cancelled = true;
        res.cancellationReason = "server_shutting_down";
        this.stopHeartbeat(res.roomId, res.socketId);
      }
      this.reservations.clear();
      this.clearAllTransportCloseListeners();
    }
    for (const active of this.activeConnections.values()) {
      active.connection.readOnly = this.calculateEffectiveReadOnly(active);
    }
  }

  /**
   * Sets room to read-only. Updates all current active connections to readOnly = true.
   */
  setRoomReadOnly(roomId: string): void {
    this.readOnlyRooms.add(roomId);
    const sockets = this.roomActiveSockets.get(roomId);
    if (sockets) {
      for (const socketId of sockets) {
        const active = this.activeConnections.get(this.makeKey(roomId, socketId));
        if (active) {
          active.connection.readOnly = this.calculateEffectiveReadOnly(active);
        }
      }
    }
  }

  /**
   * Sets room to writable.
   */
  setRoomWritable(roomId: string): void {
    this.readOnlyRooms.delete(roomId);
    const sockets = this.roomActiveSockets.get(roomId);
    if (sockets) {
      for (const socketId of sockets) {
        const active = this.activeConnections.get(this.makeKey(roomId, socketId));
        if (active) {
          active.connection.readOnly = this.calculateEffectiveReadOnly(active);
        }
      }
    }
  }

  /**
   * Engages or releases persistence backpressure for a room.
   * When engaged or released, recalculates effective read-only state for every connection.
   * Never blindly clears readOnly = false.
   */
  setRoomBackpressure(roomId: string, backpressured: boolean): void {
    if (backpressured) {
      this.backpressuredRooms.add(roomId);
    } else {
      this.backpressuredRooms.delete(roomId);
    }

    const sockets = this.roomActiveSockets.get(roomId);
    if (sockets) {
      for (const socketId of sockets) {
        const active = this.activeConnections.get(this.makeKey(roomId, socketId));
        if (active) {
          active.connection.readOnly = this.calculateEffectiveReadOnly(active);
        }
      }
    }
  }

  /**
   * Checks if room is currently backpressured due to persistence queue depth.
   */
  isRoomBackpressured(roomId: string): boolean {
    return this.backpressuredRooms.has(roomId);
  }

  /**
   * Checks if room is currently read-only (either permanently or via backpressure).
   */
  isRoomReadOnly(roomId: string): boolean {
    return this.readOnlyRooms.has(roomId) || this.backpressuredRooms.has(roomId);
  }

  /**
   * Sets all currently active rooms to read-only mode (used during server shutdown).
   */
  setAllRoomsReadOnly(): void {
    for (const roomId of this.roomActiveSockets.keys()) {
      this.setRoomReadOnly(roomId);
    }
  }

  /**
   * Returns active connection count for a room.
   */
  getRoomConnectionCount(roomId: string): number {
    return this.roomActiveSockets.get(roomId)?.size ?? 0;
  }

  /**
   * Returns active connection count for a specific member in a room.
   */
  getMemberConnectionCount(roomId: string, memberId: string): number {
    return this.memberSockets.get(`${roomId}:${memberId}`)?.size ?? 0;
  }

  /**
   * Returns total count of active physical WebSocket connections (optionally filtered by room).
   */
  getActiveConnectionCount(roomId?: string): number {
    if (roomId) {
      return this.roomActiveSockets.get(roomId)?.size ?? 0;
    }
    return this.activeConnections.size;
  }

  /**
   * Returns total count of rooms currently holding at least one active connection.
   */
  getActiveRoomCount(): number {
    return this.roomActiveSockets.size;
  }

  /**
   * Returns total count of pending connection reservations across all rooms.
   */
  getPendingReservationCount(now = Date.now()): number {
    this.pruneExpiredReservations(now);
    let count = 0;
    for (const res of this.reservations.values()) {
      if (!res.cancelled && now <= res.leaseExpiresAt && now < res.hardDeadlineAt) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns aggregate room capacity statistics without exposing raw room IDs or sensitive data.
   */
  getCapacityStats(): CapacityStats {
    const roomKeys = Array.from(this.roomActiveSockets.keys());
    const now = Date.now();
    this.pruneExpiredReservations(now);
    const rooms: RoomCapacityStat[] = roomKeys.map((roomId, idx) => {
      const activeConnections = this.roomActiveSockets.get(roomId)?.size ?? 0;
      let pendingReservations = 0;
      for (const res of this.reservations.values()) {
        if (
          res.roomId === roomId &&
          !res.cancelled &&
          now <= res.leaseExpiresAt &&
          now < res.hardDeadlineAt
        ) {
          pendingReservations++;
        }
      }
      return {
        roomIndex: idx + 1,
        activeConnections,
        pendingReservations,
        distinctMembers: this.getDistinctMemberCount(roomId, now),
        maxConnections: MAX_ROOM_CONNECTIONS,
        isReadOnly: this.readOnlyRooms.has(roomId),
      };
    });

    return {
      totalActiveRooms: this.roomActiveSockets.size,
      totalActiveConnections: this.activeConnections.size,
      totalPendingReservations: this.getPendingReservationCount(now),
      maxConnectionsPerRoom: MAX_ROOM_CONNECTIONS,
      roomsWithActiveConnections: roomKeys.filter(
        (id) => (this.roomActiveSockets.get(id)?.size ?? 0) > 0
      ).length,
      rooms,
    };
  }

  /**
   * Closes all active WebSocket connections across all rooms with a specified close code and reason.
   * Cancels all pending reservations and unregisters connections.
   */
  closeAllConnections(
    code = 1001,
    reason = "server_shutting_down"
  ): number {
    let closed = 0;
    const socketKeys = Array.from(this.activeConnections.keys());
    for (const key of socketKeys) {
      const active = this.activeConnections.get(key);
      if (active) {
        try {
          const conn = active.connection as {
            close?: (opts?: { code?: number; reason?: string }) => void;
            webSocket?: { close?: (code?: number, reason?: string) => void };
          };
          if (conn.webSocket && typeof conn.webSocket.close === "function") {
            conn.webSocket.close(code, reason);
          } else if (typeof conn.close === "function") {
            conn.close({ code, reason });
          }
        } catch {
          // ignore already closed
        }
        closed++;
      }
    }
    this.stopAllHeartbeats();
    this.reservations.clear();
    return closed;
  }

  /**
   * Force-destroys any remaining underlying socket transports if graceful close did not complete.
   */
  forceDestroyAllTransports(): number {
    let destroyed = 0;
    const socketKeys = Array.from(this.activeConnections.keys());
    for (const key of socketKeys) {
      const active = this.activeConnections.get(key);
      if (active) {
        try {
          const ws = active.connection.webSocket as
            | { terminate?: () => void; _socket?: { destroy?: () => void } }
            | undefined;
          if (typeof ws?.terminate === "function") {
            ws.terminate();
          } else if (typeof ws?._socket?.destroy === "function") {
            ws._socket.destroy();
          }
        } catch {
          // ignore
        }
        this.unregisterConnection(active.roomId, active.socketId);
        destroyed++;
      }
    }
    this.stopAllHeartbeats();
    this.reservations.clear();
    return destroyed;
  }

  /**
   * Resets all internal tracking state (for testing).
   */
  resetAll(): void {
    this.stopAllHeartbeats();
    this.clearAllTransportCloseListeners();
    this.reservations.clear();
    this.activeConnections.clear();
    this.roomActiveSockets.clear();
    this.memberSockets.clear();
    this.readOnlyRooms.clear();
    this.backpressuredRooms.clear();
    this.readOnlyMembers.clear();
    this.roomMetadata.clear();
    this.deletedRooms.clear();
    this.isShuttingDownState = false;
  }
}

export const syncRegistry = new SyncRegistry();
