import type { Principal } from "../middleware/identity.js";
import type { CloseEvent } from "@hocuspocus/common";

export const MAX_ROOM_MEMBERS = 6;
export const MAX_ROOM_CONNECTIONS = 6;
export const MAX_MEMBER_CONNECTIONS = 3;
export const RESERVATION_TTL_MS = 10_000;

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
  socketId: string;
  roomId: string;
  memberId?: string;
  reservedAt: number;
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

/**
 * PRD ROOM-4 & T07 Sync Registry
 * Enforces:
 * 1. Strict room capacity limit: at most 6 total active WebSocket connections per room.
 * 2. Per-member connection limit: at most 3 connections per member within the room.
 * 3. Synchronous reservation before async authentication, released on every error/disconnect path.
 * 4. Closing all connections for a member upon kick/leave (closeConnectionsForMember).
 * 5. Dynamic read-only locking for a room (setRoomReadOnly).
 */
export class SyncRegistry {
  private reservations = new Map<string, ConnectionReservation>(); // socketId -> reservation
  private activeConnections = new Map<string, ActiveConnection>(); // socketId -> ActiveConnection
  private roomActiveSockets = new Map<string, Set<string>>(); // roomId -> Set<socketId>
  private memberSockets = new Map<string, Set<string>>(); // `${roomId}:${memberId}` -> Set<socketId>
  private readOnlyRooms = new Set<string>(); // roomId

  /**
   * Prunes reservations older than RESERVATION_TTL_MS.
   */
  private pruneExpiredReservations(now = Date.now()): void {
    for (const [socketId, res] of this.reservations.entries()) {
      if (now - res.reservedAt > RESERVATION_TTL_MS) {
        this.reservations.delete(socketId);
      }
    }
  }

  /**
   * Returns total count of active connections and valid pending reservations for a room.
   */
  getTotalRoomCount(roomId: string, now = Date.now()): number {
    this.pruneExpiredReservations(now);
    const activeCount = this.roomActiveSockets.get(roomId)?.size ?? 0;
    let reservedCount = 0;
    for (const res of this.reservations.values()) {
      if (res.roomId === roomId && now - res.reservedAt <= RESERVATION_TTL_MS) {
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
    now = Date.now()
  ): number {
    this.pruneExpiredReservations(now);
    const memberKey = `${roomId}:${memberId}`;
    const activeCount = this.memberSockets.get(memberKey)?.size ?? 0;
    let reservedCount = 0;
    for (const res of this.reservations.values()) {
      if (
        res.roomId === roomId &&
        res.memberId === memberId &&
        now - res.reservedAt <= RESERVATION_TTL_MS
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
    now = Date.now()
  ): { success: true } | { success: false; reason: "room_capacity_exceeded" } {
    if (this.getTotalRoomCount(roomId, now) >= MAX_ROOM_CONNECTIONS) {
      return { success: false, reason: "room_capacity_exceeded" };
    }
    this.reservations.set(socketId, {
      socketId,
      roomId,
      reservedAt: now,
    });
    return { success: true };
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
        now - res.reservedAt <= RESERVATION_TTL_MS
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
    now = Date.now()
  ): boolean {
    return (
      this.getTotalMemberCount(roomId, memberId, now) < MAX_MEMBER_CONNECTIONS
    );
  }

  /**
   * Associates a memberId with an active reservation once principal is resolved.
   */
  assignMemberToReservation(socketId: string, memberId: string): void {
    const res = this.reservations.get(socketId);
    if (res) {
      res.memberId = memberId;
    }
  }

  /**
   * Cancels a pending reservation on auth failure, permission denial, failed document load, or socket error.
   * If roomId is specified, only deletes if the reservation matches that room.
   */
  cancelReservation(socketId: string, roomId?: string): void {
    const res = this.reservations.get(socketId);
    if (res) {
      if (!roomId || res.roomId === roomId) {
        this.reservations.delete(socketId);
      }
    }
  }

  /**
   * Returns a pending reservation by its socket ID, if present.
   */
  getReservation(socketId: string): ConnectionReservation | undefined {
    return this.reservations.get(socketId);
  }

  /**
   * Returns all socket IDs that currently hold a pending reservation for the given room.
   */
  getPendingReservationsForRoom(roomId: string, now = Date.now()): string[] {
    this.pruneExpiredReservations(now);
    const sockets: string[] = [];
    for (const res of this.reservations.values()) {
      if (res.roomId === roomId && now - res.reservedAt <= RESERVATION_TTL_MS) {
        sockets.push(res.socketId);
      }
    }
    return sockets;
  }

  /**
   * Cancels all pending reservations for a specific room (e.g. when document loading fails).
   * Returns the list of socket IDs whose reservations were released.
   */
  cancelReservationsForRoom(roomId: string): string[] {
    const cancelledSockets: string[] = [];
    for (const [socketId, res] of this.reservations.entries()) {
      if (res.roomId === roomId) {
        this.reservations.delete(socketId);
        cancelledSockets.push(socketId);
      }
    }
    return cancelledSockets;
  }

  /**
   * Promotes a reservation to an active connection once connected hook fires.
   */
  promoteReservation(
    socketId: string,
    roomId: string,
    memberId: string,
    principal:
      | Principal
      | { type: string; id: string; displayName: string; [key: string]: unknown },
    connection: SyncConnectionLike,
    memberRole?: string
  ): void {
    this.reservations.delete(socketId);

    const activeConn: ActiveConnection = {
      socketId,
      roomId,
      memberId,
      principal,
      connection,
      memberRole,
      connectedAt: Date.now(),
    };

    this.activeConnections.set(socketId, activeConn);

    if (!this.roomActiveSockets.has(roomId)) {
      this.roomActiveSockets.set(roomId, new Set());
    }
    this.roomActiveSockets.get(roomId)!.add(socketId);

    const memberKey = `${roomId}:${memberId}`;
    if (!this.memberSockets.has(memberKey)) {
      this.memberSockets.set(memberKey, new Set());
    }
    this.memberSockets.get(memberKey)!.add(socketId);

    if (this.readOnlyRooms.has(roomId)) {
      connection.readOnly = true;
    }
  }

  /**
   * Returns an active connection by its socket ID, if registered.
   */
  getConnection(socketId: string): ActiveConnection | undefined {
    return this.activeConnections.get(socketId);
  }

  /**
   * Unregisters a connection on disconnect.
   */
  unregisterConnection(roomId: string, socketId: string): void {
    this.reservations.delete(socketId);

    const active = this.activeConnections.get(socketId);
    if (active) {
      this.activeConnections.delete(socketId);
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
   * Closes all active connections for a member in a room with a specific WebSocket close code and reason.
   * Returns the count of closed sockets.
   */
  closeConnectionsForMember(
    roomId: string,
    memberId: string,
    code = 4000,
    reason = "removed"
  ): number {
    const memberKey = `${roomId}:${memberId}`;
    const sockets = this.memberSockets.get(memberKey);
    if (!sockets || sockets.size === 0) return 0;

    let closed = 0;
    const socketIds = Array.from(sockets);
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(socketId);
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
      const active = this.activeConnections.get(socketId);
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
    const sockets = this.memberSockets.get(memberKey);
    if (!sockets || sockets.size === 0) return 0;

    let updated = 0;
    for (const socketId of sockets) {
      const active = this.activeConnections.get(socketId);
      if (active) {
        active.connection.readOnly = readOnly;
        if (newRole) active.memberRole = newRole;
        updated++;
      }
    }
    return updated;
  }

  /**
   * Closes all active connections in a room with a specific WebSocket close code and reason.
   */
  closeAllConnectionsForRoom(
    roomId: string,
    code = 1000,
    reason = "room_closed"
  ): number {
    const sockets = this.roomActiveSockets.get(roomId);
    if (!sockets || sockets.size === 0) return 0;

    let closed = 0;
    const socketIds = Array.from(sockets);
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(socketId);
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
   * Updates interview candidate permissions based on room live status.
   */
  syncCandidatePermissions(roomId: string, isLive: boolean): number {
    let updated = 0;
    const sockets = this.roomActiveSockets.get(roomId);
    if (!sockets) return 0;

    for (const socketId of sockets) {
      const active = this.activeConnections.get(socketId);
      if (active) {
        const role =
          active.memberRole ??
          (active.principal as { role?: string })?.role;
        if (role === "candidate") {
          active.connection.readOnly = !isLive;
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
    status: "open" | "live" | "ended" | "archived"
  ): void {
    if (status === "ended" || status === "archived") {
      this.setRoomReadOnly(roomId);
    } else if (status === "live") {
      this.syncCandidatePermissions(roomId, true);
    } else if (status === "open") {
      this.syncCandidatePermissions(roomId, false);
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
        const active = this.activeConnections.get(socketId);
        if (active) {
          active.connection.readOnly = true;
        }
      }
    }
  }

  /**
   * Sets room to writable.
   */
  setRoomWritable(roomId: string): void {
    this.readOnlyRooms.delete(roomId);
  }

  /**
   * Checks if room is currently read-only.
   */
  isRoomReadOnly(roomId: string): boolean {
    return this.readOnlyRooms.has(roomId);
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
   * Returns total count of active physical WebSocket connections across all rooms.
   */
  getActiveConnectionCount(): number {
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
  getPendingReservationCount(): number {
    return this.reservations.size;
  }

  /**
   * Returns aggregate room capacity statistics without exposing raw room IDs or sensitive data.
   */
  getCapacityStats(): CapacityStats {
    const roomKeys = Array.from(this.roomActiveSockets.keys());
    const now = Date.now();
    const rooms: RoomCapacityStat[] = roomKeys.map((roomId, idx) => {
      const activeConnections = this.roomActiveSockets.get(roomId)?.size ?? 0;
      let pendingReservations = 0;
      for (const res of this.reservations.values()) {
        if (res.roomId === roomId && now - res.reservedAt <= RESERVATION_TTL_MS) {
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
      totalPendingReservations: this.reservations.size,
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
    const socketIds = Array.from(this.activeConnections.keys());
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(socketId);
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
    this.reservations.clear();
    return closed;
  }

  /**
   * Force-destroys any remaining underlying socket transports if graceful close did not complete.
   */
  forceDestroyAllTransports(): number {
    let destroyed = 0;
    const socketIds = Array.from(this.activeConnections.keys());
    for (const socketId of socketIds) {
      const active = this.activeConnections.get(socketId);
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
        this.unregisterConnection(active.roomId, socketId);
        destroyed++;
      }
    }
    this.reservations.clear();
    return destroyed;
  }

  /**
   * Resets all internal tracking state (for testing).
   */
  resetAll(): void {
    this.reservations.clear();
    this.activeConnections.clear();
    this.roomActiveSockets.clear();
    this.memberSockets.clear();
    this.readOnlyRooms.clear();
  }
}

export const syncRegistry = new SyncRegistry();
