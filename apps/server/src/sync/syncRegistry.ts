import type { Principal } from "../middleware/identity.js";

export const MAX_ROOM_MEMBERS = 6;
export const MAX_ROOM_CONNECTIONS = 6;
export const MAX_MEMBER_CONNECTIONS = 3;
export const RESERVATION_TTL_MS = 10_000;

export interface SyncConnectionLike {
  readOnly: boolean;
  webSocket?: {
    close: (code?: number, reason?: string) => void;
  };
  socketId?: string;
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
   * Cancels a pending reservation on auth failure, permission denial, or socket error.
   */
  cancelReservation(socketId: string): void {
    this.reservations.delete(socketId);
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
    connection: SyncConnectionLike
  ): void {
    this.reservations.delete(socketId);

    const activeConn: ActiveConnection = {
      socketId,
      roomId,
      memberId,
      principal,
      connection,
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
          active.connection.webSocket?.close(code, reason);
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
