import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SyncRegistry,
  MAX_ROOM_CONNECTIONS,
  MAX_MEMBER_CONNECTIONS,
} from "../../sync/syncRegistry.js";
import type { Principal } from "../../middleware/identity.js";

describe("T07 Sync Registry Unit Tests", () => {
  let registry: SyncRegistry;

  const mockPrincipal = (id: string): Principal => ({
    type: "user",
    id,
    displayName: `User ${id}`,
    role: "user",
    user: {
      id,
      displayName: `User ${id}`,
      role: "user",
    } as unknown as import("../../models/users.js").IUser,
  });

  beforeEach(() => {
    registry = new SyncRegistry();
  });

  describe("Room Capacity Reservation (ROOM-4)", () => {
    it("allows up to 6 reservations in a room and rejects the 7th", () => {
      const roomId = "507f1f77bcf86cd799439011";

      for (let i = 1; i <= MAX_ROOM_CONNECTIONS; i++) {
        const res = registry.reserveSlot(roomId, `sock_${i}`);
        expect(res).toEqual({ success: true });
      }

      expect(registry.getTotalRoomCount(roomId)).toBe(6);

      // 7th attempt is rejected synchronously
      const reject = registry.reserveSlot(roomId, "sock_7");
      expect(reject).toEqual({
        success: false,
        reason: "room_capacity_exceeded",
      });
    });

    it("cancels reservation and frees slot on error or disconnect", () => {
      const roomId = "507f1f77bcf86cd799439011";

      for (let i = 1; i <= 6; i++) {
        registry.reserveSlot(roomId, `sock_${i}`);
      }
      expect(registry.getTotalRoomCount(roomId)).toBe(6);

      // Canceling sock_6 frees a slot
      registry.cancelReservation("sock_6");
      expect(registry.getTotalRoomCount(roomId)).toBe(5);

      const next = registry.reserveSlot(roomId, "sock_new");
      expect(next).toEqual({ success: true });
    });

    it("prunes expired reservations older than 10 seconds", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const now = Date.now();

      // Reserve 6 slots 15 seconds ago
      for (let i = 1; i <= 6; i++) {
        registry.reserveSlot(roomId, `old_sock_${i}`, now - 15_000);
      }

      // Check capacity at current time (should be 0 because all 6 expired)
      expect(registry.getTotalRoomCount(roomId, now)).toBe(0);

      // New reservation succeeds
      const res = registry.reserveSlot(roomId, "fresh_sock", now);
      expect(res).toEqual({ success: true });
    });
  });

  describe("Per-Member Connection Limits", () => {
    it("allows up to 3 connections per member and rejects the 4th", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberId = "user_1";

      for (let i = 1; i <= MAX_MEMBER_CONNECTIONS; i++) {
        expect(registry.checkMemberLimit(roomId, memberId)).toBe(true);
        registry.reserveSlot(roomId, `sock_${i}`);
        registry.assignMemberToReservation(`sock_${i}`, memberId);
      }

      expect(registry.getTotalMemberCount(roomId, memberId)).toBe(3);

      // 4th connection for member is rejected
      expect(registry.checkMemberLimit(roomId, memberId)).toBe(false);
    });

    it("unregisters connection and decrements member connection count", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const memberId = "user_1";
      const socketId = "sock_1";

      registry.reserveSlot(roomId, socketId);
      const mockConn = { readOnly: false };
      registry.promoteReservation(
        socketId,
        roomId,
        memberId,
        mockPrincipal(memberId),
        mockConn
      );

      expect(registry.getMemberConnectionCount(roomId, memberId)).toBe(1);
      expect(registry.getRoomConnectionCount(roomId)).toBe(1);

      registry.unregisterConnection(roomId, socketId);

      expect(registry.getMemberConnectionCount(roomId, memberId)).toBe(0);
      expect(registry.getRoomConnectionCount(roomId)).toBe(0);
    });
  });

  describe("closeConnectionsForMember", () => {
    it("closes all active WebSockets for a member with custom code and reason", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const targetMemberId = "user_to_kick";
      const otherMemberId = "user_staying";

      const closeFn1 = vi.fn();
      const closeFn2 = vi.fn();
      const stayCloseFn = vi.fn();

      const conn1 = { readOnly: false, webSocket: { close: closeFn1 } };
      const conn2 = { readOnly: false, webSocket: { close: closeFn2 } };
      const connStay = { readOnly: false, webSocket: { close: stayCloseFn } };

      registry.reserveSlot(roomId, "sock_kick_1");
      registry.promoteReservation(
        "sock_kick_1",
        roomId,
        targetMemberId,
        mockPrincipal(targetMemberId),
        conn1
      );

      registry.reserveSlot(roomId, "sock_kick_2");
      registry.promoteReservation(
        "sock_kick_2",
        roomId,
        targetMemberId,
        mockPrincipal(targetMemberId),
        conn2
      );

      registry.reserveSlot(roomId, "sock_stay");
      registry.promoteReservation(
        "sock_stay",
        roomId,
        otherMemberId,
        mockPrincipal(otherMemberId),
        connStay
      );

      expect(registry.getRoomConnectionCount(roomId)).toBe(3);
      expect(registry.getMemberConnectionCount(roomId, targetMemberId)).toBe(2);

      // Kick target member
      const closedCount = registry.closeConnectionsForMember(
        roomId,
        targetMemberId,
        4000,
        "kicked_by_owner"
      );

      expect(closedCount).toBe(2);
      expect(closeFn1).toHaveBeenCalledWith(4000, "kicked_by_owner");
      expect(closeFn2).toHaveBeenCalledWith(4000, "kicked_by_owner");
      expect(stayCloseFn).not.toHaveBeenCalled();

      // Target member sockets are removed from tracking
      expect(registry.getMemberConnectionCount(roomId, targetMemberId)).toBe(0);
      expect(registry.getRoomConnectionCount(roomId)).toBe(1);
    });
  });

  describe("setRoomReadOnly", () => {
    it("marks room read-only and updates active connections", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const conn1 = { readOnly: false };
      const conn2 = { readOnly: false };

      registry.reserveSlot(roomId, "sock_1");
      registry.promoteReservation(
        "sock_1",
        roomId,
        "user_1",
        mockPrincipal("user_1"),
        conn1
      );

      registry.reserveSlot(roomId, "sock_2");
      registry.promoteReservation(
        "sock_2",
        roomId,
        "user_2",
        mockPrincipal("user_2"),
        conn2
      );

      expect(conn1.readOnly).toBe(false);
      expect(conn2.readOnly).toBe(false);
      expect(registry.isRoomReadOnly(roomId)).toBe(false);

      // Lock room
      registry.setRoomReadOnly(roomId);

      expect(registry.isRoomReadOnly(roomId)).toBe(true);
      expect(conn1.readOnly).toBe(true);
      expect(conn2.readOnly).toBe(true);

      // New connections promoted after lock are automatically readOnly
      const conn3 = { readOnly: false };
      registry.reserveSlot(roomId, "sock_3");
      registry.promoteReservation(
        "sock_3",
        roomId,
        "user_3",
        mockPrincipal("user_3"),
        conn3
      );
      expect(conn3.readOnly).toBe(true);

      // Unlock room
      registry.setRoomWritable(roomId);
      expect(registry.isRoomReadOnly(roomId)).toBe(false);
    });
  });
});
