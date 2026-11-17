import type { Socket } from "socket.io";
import {
  PARTICIPANT_PALETTE,
  type UserRole,
  type PresenceMemberDto,
} from "@pairprep/shared";

export interface TrackedMemberInfo {
  memberDocId: string;
  memberId: string;
  displayName: string;
  role: UserRole;
  color: string;
}

export interface PresenceTransitionResult {
  transition: "none" | "joined" | "left";
  isFirstSocket: boolean;
  isLastSocket: boolean;
  memberInfo?: TrackedMemberInfo;
}

/**
 * Authoritative In-Memory Presence Registry for Single-Process Deployment.
 *
 * ARCHITECTURAL CONSTRAINTS & LIMITATIONS:
 * In accordance with Phase 1/2 single-process deployment, this registry tracks
 * socket connections in Node.js process memory.
 * - Sockets per room and member are tracked in a nested map:
 *   roomId -> memberDocId -> Set<socketId>
 * - Multi-tab transitions are strictly debounced:
 *   - 0-to-1 transition emits a member join/online event.
 *   - 1-to-0 transition emits a member left/offline event.
 *   - Intermediate transitions (e.g. 1 -> 2, 2 -> 1) do NOT emit presence events.
 * - Single-Process Limitation: State is local to this process. A future horizontal
 *   scale-out would require a shared adapter (e.g., Redis Streams or Socket.IO Redis Adapter).
 */
export class RoomPresenceTracker {
  // roomId -> memberDocId -> Set<socketId>
  private readonly roomSockets = new Map<string, Map<string, Set<string>>>();

  // socketId -> { roomId, memberDocId }
  private readonly socketIndex = new Map<
    string,
    { roomId: string; memberDocId: string }
  >();

  // socketId -> Socket instance
  private readonly socketInstances = new Map<string, Socket>();

  // memberDocId -> TrackedMemberInfo
  private readonly memberMetadata = new Map<string, TrackedMemberInfo>();

  /**
   * Assigns a deterministic color from PARTICIPANT_PALETTE based on string hash.
   */
  public static getDeterministicColor(identifier: string): string {
    let hash = 0;
    for (let i = 0; i < identifier.length; i++) {
      hash = (hash << 5) - hash + identifier.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % PARTICIPANT_PALETTE.length;
    return PARTICIPANT_PALETTE[index] || "#3b82f6";
  }

  /**
   * Registers a socket connection for a member in a room.
   * Returns whether this is a 0-to-1 transition (first socket connecting).
   */
  public registerSocket(
    socket: Socket,
    roomId: string,
    member: {
      id?: string;
      _id?: unknown;
      memberId: string;
      displayName: string;
      role: UserRole;
    }
  ): PresenceTransitionResult {
    const memberDocId = member.id ? String(member.id) : String(member._id ?? "");
    const socketId = socket.id;

    let memberMap = this.roomSockets.get(roomId);
    if (!memberMap) {
      memberMap = new Map();
      this.roomSockets.set(roomId, memberMap);
    }

    let socketSet = memberMap.get(memberDocId);
    const isFirstSocket = !socketSet || socketSet.size === 0;

    if (!socketSet) {
      socketSet = new Set();
      memberMap.set(memberDocId, socketSet);
    }

    socketSet.add(socketId);
    this.socketIndex.set(socketId, { roomId, memberDocId });
    this.socketInstances.set(socketId, socket);

    const color = RoomPresenceTracker.getDeterministicColor(member.memberId);
    const memberInfo: TrackedMemberInfo = {
      memberDocId,
      memberId: member.memberId,
      displayName: member.displayName,
      role: member.role,
      color,
    };
    this.memberMetadata.set(memberDocId, memberInfo);

    return {
      transition: isFirstSocket ? "joined" : "none",
      isFirstSocket,
      isLastSocket: false,
      memberInfo,
    };
  }

  /**
   * Unregisters a socket on disconnect.
   * Returns whether this was a 1-to-0 transition (last socket disconnecting).
   */
  public unregisterSocket(socketId: string): PresenceTransitionResult {
    const entry = this.socketIndex.get(socketId);
    this.socketInstances.delete(socketId);
    this.socketIndex.delete(socketId);

    if (!entry) {
      return { transition: "none", isFirstSocket: false, isLastSocket: false };
    }

    const { roomId, memberDocId } = entry;
    const memberMap = this.roomSockets.get(roomId);
    if (!memberMap) {
      return { transition: "none", isFirstSocket: false, isLastSocket: false };
    }

    const socketSet = memberMap.get(memberDocId);
    if (!socketSet) {
      return { transition: "none", isFirstSocket: false, isLastSocket: false };
    }

    socketSet.delete(socketId);
    const isLastSocket = socketSet.size === 0;

    const memberInfo = this.memberMetadata.get(memberDocId);

    if (isLastSocket) {
      memberMap.delete(memberDocId);
      this.memberMetadata.delete(memberDocId);
      if (memberMap.size === 0) {
        this.roomSockets.delete(roomId);
      }
    }

    return {
      transition: isLastSocket ? "left" : "none",
      isFirstSocket: false,
      isLastSocket,
      memberInfo,
    };
  }

  /**
   * Updates a member's tracked role (e.g. after REST role change).
   */
  public updateMemberRole(memberDocId: string, newRole: UserRole): void {
    const info = this.memberMetadata.get(memberDocId);
    if (info) {
      info.role = newRole;
    }
  }

  /**
   * Returns the list of currently active online members in a room.
   */
  public getOnlineMembers(roomId: string): PresenceMemberDto[] {
    const memberMap = this.roomSockets.get(roomId);
    if (!memberMap) return [];

    const result: PresenceMemberDto[] = [];
    for (const [memberDocId, socketSet] of memberMap.entries()) {
      if (socketSet.size > 0) {
        const info = this.memberMetadata.get(memberDocId);
        if (info) {
          result.push({
            memberId: info.memberId,
            memberDocId: info.memberDocId,
            displayName: info.displayName,
            role: info.role,
            color: info.color,
            isOnline: true,
          });
        }
      }
    }
    return result;
  }

  /**
   * Forcefully closes all active sockets belonging to a member in a room
   * (e.g., when member is removed by the room owner).
   */
  public disconnectMemberSockets(roomId: string, memberDocId: string): void {
    const memberMap = this.roomSockets.get(roomId);
    if (!memberMap) return;

    const socketSet = memberMap.get(memberDocId);
    if (!socketSet) return;

    const socketIds = Array.from(socketSet);
    for (const socketId of socketIds) {
      const socket = this.socketInstances.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
      this.unregisterSocket(socketId);
    }

    memberMap.delete(memberDocId);
    this.memberMetadata.delete(memberDocId);
  }

  /**
   * Gracefully drains and closes all sockets in a room (M-1).
   * 1. Broadcasts room:deleted with bounded acknowledgement / drain period (max drainTimeoutMs).
   * 2. Calls socket.disconnect(false) to allow packet buffers to write out before closure.
   * 3. Forcibly terminates any stubborn connected sockets after the deadline.
   * 4. Notification is best-effort over network transport; authoritative reconnect rejection
   *    (404 ROOM_NOT_FOUND) provides the absolute barrier for offline/slow clients.
   */
  public async gracefulDisconnectRoomSockets(
    roomId: string,
    drainTimeoutMs = 500
  ): Promise<void> {
    const memberMap = this.roomSockets.get(roomId);
    if (!memberMap) return;

    const socketsToClose: Socket[] = [];
    for (const [, socketSet] of memberMap.entries()) {
      for (const socketId of socketSet) {
        const socket = this.socketInstances.get(socketId);
        if (socket) {
          socketsToClose.push(socket);
        }
        this.socketInstances.delete(socketId);
        this.socketIndex.delete(socketId);
      }
    }

    if (socketsToClose.length === 0) {
      for (const [memberDocId] of memberMap.entries()) {
        this.memberMetadata.delete(memberDocId);
      }
      this.roomSockets.delete(roomId);
      return;
    }

    // Bounded acknowledgement / graceful disconnect
    const drainPromises = socketsToClose.map((socket) => {
      return new Promise<void>((resolve) => {
        let settled = false;
        const complete = () => {
          if (!settled) {
            settled = true;
            try {
              socket.disconnect(false);
            } catch {
              // ignore
            }
            resolve();
          }
        };

        // If socket supports timeout/ack, emit with bounded timeout
        if (typeof (socket as unknown as { timeout?: unknown }).timeout === "function") {
          try {
            socket.timeout(drainTimeoutMs).emit("room:deleted", { roomId }, () => {
              complete();
            });
          } catch {
            complete();
          }
        } else {
          try {
            socket.emit("room:deleted", { roomId });
          } catch {
            // ignore
          }
          complete();
        }

        setTimeout(complete, drainTimeoutMs);
      });
    });

    await Promise.all(drainPromises);

    // Hard disconnect any sockets that remain connected after deadline
    for (const socket of socketsToClose) {
      if (socket.connected) {
        try {
          socket.disconnect(true);
        } catch {
          // ignore
        }
      }
    }

    for (const [memberDocId] of memberMap.entries()) {
      this.memberMetadata.delete(memberDocId);
    }
    this.roomSockets.delete(roomId);
  }

  /**
   * Closes all sockets in a room without hard-killing buffers immediately.
   */
  public disconnectRoomSockets(roomId: string): void {
    const memberMap = this.roomSockets.get(roomId);
    if (!memberMap) return;

    for (const [memberDocId, socketSet] of memberMap.entries()) {
      for (const socketId of socketSet) {
        const socket = this.socketInstances.get(socketId);
        if (socket) {
          socket.disconnect(false);
        }
        this.socketInstances.delete(socketId);
        this.socketIndex.delete(socketId);
      }
      this.memberMetadata.delete(memberDocId);
    }

    this.roomSockets.delete(roomId);
  }

  public getSocketCountForMember(roomId: string, memberDocId: string): number {
    return this.roomSockets.get(roomId)?.get(memberDocId)?.size ?? 0;
  }

  public getOnlineMemberCount(roomId: string): number {
    return this.roomSockets.get(roomId)?.size ?? 0;
  }

  public reset(): void {
    this.roomSockets.clear();
    this.socketIndex.clear();
    this.socketInstances.clear();
    this.memberMetadata.clear();
  }
}

export const presenceTracker = new RoomPresenceTracker();
