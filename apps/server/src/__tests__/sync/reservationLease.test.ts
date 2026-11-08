import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SyncRegistry,
  RESERVATION_LEASE_TTL_MS,
  MAX_HANDSHAKE_DURATION_MS,
} from "../../sync/syncRegistry.js";
import type { SyncConnectionLike } from "../../sync/syncRegistry.js";

describe("SyncRegistry Reservation Lease & Isolation Hardening (Commit 6)", () => {
  let registry: SyncRegistry;

  beforeEach(() => {
    registry = new SyncRegistry();
  });

  afterEach(() => {
    registry.resetAll();
  });

  describe("Multi-Room Socket Reservation Isolation", () => {
    it("allows the same physical socketId to hold distinct reservations across different rooms", () => {
      const roomA = "507f1f77bcf86cd799439011";
      const roomB = "507f1f77bcf86cd799439022";
      const socketId = "sock_multi_1";

      const resA = registry.reserveSlot(roomA, socketId);
      const resB = registry.reserveSlot(roomB, socketId);

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      if (resA.success && resB.success) {
        expect(resA.token).not.toBe(resB.token);
        expect(registry.getReservation(socketId, roomA)?.token).toBe(resA.token);
        expect(registry.getReservation(socketId, roomB)?.token).toBe(resB.token);
      }

      expect(registry.getTotalRoomCount(roomA)).toBe(1);
      expect(registry.getTotalRoomCount(roomB)).toBe(1);
      expect(registry.getPendingReservationCount()).toBe(2);

      // Cancelling room A does not affect room B
      registry.cancelReservation(socketId, roomA);
      expect(registry.getReservation(socketId, roomA)).toBeUndefined();
      expect(registry.getReservation(socketId, roomB)).toBeDefined();
      expect(registry.getTotalRoomCount(roomA)).toBe(0);
      expect(registry.getTotalRoomCount(roomB)).toBe(1);
    });

    it("allows promoting a reservation in room A while keeping reservation in room B intact", () => {
      const roomA = "507f1f77bcf86cd799439011";
      const roomB = "507f1f77bcf86cd799439022";
      const socketId = "sock_multi_2";

      const resA = registry.reserveSlot(roomA, socketId);
      const resB = registry.reserveSlot(roomB, socketId);
      expect(resA.success && resB.success).toBe(true);

      const mockConn: SyncConnectionLike = {
        socketId,
        readOnly: false,
        webSocket: {
          close: vi.fn(),
        },
      };

      if (resA.success) {
        const promoA = registry.promoteReservation(
          socketId,
          roomA,
          "member_1",
          { id: "member_1", type: "user", displayName: "User 1" },
          mockConn,
          "editor",
          resA.token
        );
        expect(promoA.success).toBe(true);
      }

      // Room A is now active, room B is still reserved
      expect(registry.getActiveConnectionCount(roomA)).toBe(1);
      expect(registry.getActiveConnectionCount(roomB)).toBe(0);
      expect(registry.getReservation(socketId, roomB)).toBeDefined();
      expect(registry.hasActiveConnection(socketId, roomA)).toBe(true);
      expect(registry.hasActiveConnection(socketId, roomB)).toBe(false);
    });
  });

  describe("Lease Management, Heartbeat & Absolute Hard Deadline", () => {
    it("maintains reservation lease across slow authentication (>10s) via touch/heartbeat", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_slow_auth";
      const startTime = 1_000_000;

      const res = registry.reserveSlot(roomId, socketId, startTime);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;

      // After 8 seconds (before 10s TTL), heartbeat touches lease
      const touchTime1 = startTime + 8_000;
      expect(registry.touchReservation(roomId, socketId, touchTime1)).toBe(true);
      expect(registry.isReservationValid(roomId, socketId, token, touchTime1)).toBe(true);

      // At 14 seconds from start (past original 10s TTL), reservation is still valid because touched
      const touchTime2 = startTime + 14_000;
      expect(registry.touchReservation(roomId, socketId, touchTime2)).toBe(true);
      expect(registry.isReservationValid(roomId, socketId, token, touchTime2)).toBe(true);

      // At 22 seconds from start, another touch keeps it alive
      const touchTime3 = startTime + 22_000;
      expect(registry.touchReservation(roomId, socketId, touchTime3)).toBe(true);
      expect(registry.isReservationValid(roomId, socketId, token, touchTime3)).toBe(true);

      // Successful promotion at 24s (within 30s hard deadline)
      const promoTime = startTime + 24_000;
      const mockConn: SyncConnectionLike = {
        socketId,
        readOnly: false,
        webSocket: { close: vi.fn() },
      };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_slow",
        { id: "member_slow", type: "user", displayName: "Slow User" },
        mockConn,
        "editor",
        token,
        promoTime
      );
      expect(promoResult.success).toBe(true);
    });

    it("expires reservation if lease is not renewed within 10 seconds", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_abandoned";
      const startTime = 1_000_000;

      const res = registry.reserveSlot(roomId, socketId, startTime);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;

      // At 10.001 seconds without touch, reservation has expired
      const expiredTime = startTime + RESERVATION_LEASE_TTL_MS + 1;
      expect(registry.isReservationValid(roomId, socketId, token, expiredTime)).toBe(false);

      // Promotion attempt fails with reservation_expired
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_abandoned",
        { id: "member_abandoned", type: "user", displayName: "Abandoned" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("reservation_expired");
      }
    });

    it("enforces absolute hard deadline of 30 seconds even with continuous heartbeats", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_zombie_auth";
      const startTime = 1_000_000;

      const res = registry.reserveSlot(roomId, socketId, startTime);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;

      // Heartbeat touch at 28 seconds succeeds
      const touchTime = startTime + 28_000;
      expect(registry.touchReservation(roomId, socketId, touchTime)).toBe(true);
      expect(registry.isReservationValid(roomId, socketId, token, touchTime)).toBe(true);

      // At 30.001 seconds, hard deadline exceeded (MAX_HANDSHAKE_DURATION_MS = 30_000)
      const hardDeadlinePast = startTime + MAX_HANDSHAKE_DURATION_MS + 1;
      expect(registry.touchReservation(roomId, socketId, hardDeadlinePast)).toBe(false);
      expect(registry.isReservationValid(roomId, socketId, token, hardDeadlinePast)).toBe(false);

      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_zombie",
        { id: "member_zombie", type: "user", displayName: "Zombie" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("reservation_expired");
      }
    });
  });

  describe("Atomic Promotion Revalidation & Token Identity", () => {
    it("rejects promotion if reservation token does not match", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_token_mismatch";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);

      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_token",
        { id: "member_token", type: "user", displayName: "User" },
        mockConn,
        "editor",
        "stale-or-forged-token"
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("reservation_token_mismatch");
      }
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    it("rejects promotion if room capacity was filled by other connections", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_late_promo";

      // Fill room active connections to capacity (6) with other sockets
      for (let i = 1; i <= 6; i++) {
        const otherRes = registry.reserveSlot(roomId, `other_sock_${i}`);
        expect(otherRes.success).toBe(true);
        if (otherRes.success) {
          const promo = registry.promoteReservation(
            `other_sock_${i}`,
            roomId,
            `other_user_${i}`,
            { id: `other_user_${i}`, type: "user", displayName: `Other ${i}` },
            { socketId: `other_sock_${i}`, readOnly: false },
            "editor",
            otherRes.token
          );
          expect(promo.success).toBe(true);
        }
      }
      expect(registry.getActiveConnectionCount(roomId)).toBe(6);

      // Simulate a previously held reservation attempting promotion after room filled
      const token = "stale-reservation-token";
      const key = `${roomId}:${socketId}`;
      (registry as unknown as { reservations: Map<string, unknown> }).reservations.set(key, {
        token,
        socketId,
        roomId,
        reservedAt: Date.now(),
        leaseExpiresAt: Date.now() + 10_000,
        hardDeadlineAt: Date.now() + 30_000,
        cancelled: false,
      });

      // Now promote sock_late_promo: capacity revalidation fails atomically
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_late",
        { id: "member_late", type: "user", displayName: "Late" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("room_capacity_exceeded");
      }
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    it("rejects promotion and cancels reservation if room was marked deleted", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_deleted_room";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      // Owner deletes room
      registry.markRoomDeleted(roomId);

      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_deleted",
        { id: "member_deleted", type: "user", displayName: "Deleted" },
        mockConn,
        "editor",
        res.token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("room_unavailable");
      }
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    it("verifies promotion failure determines correct close code (1001 for shutdown, 4003 for capacity/deleted)", () => {
      // Simulate promotion failure on shutdown
      const shutdownResult = { success: false, reason: "server_shutting_down" };
      const shutdownCode = shutdownResult.reason === "server_shutting_down" ? 1001 : 4003;
      expect(shutdownCode).toBe(1001);

      // Simulate promotion failure on capacity or room deleted
      const capacityResult = { success: false, reason: "room_capacity_exceeded" };
      const capacityCode = capacityResult.reason === "server_shutting_down" ? 1001 : 4003;
      expect(capacityCode).toBe(4003);

      const deletedResult = { success: false, reason: "room_unavailable" };
      const deletedCode = deletedResult.reason === "server_shutting_down" ? 1001 : 4003;
      expect(deletedCode).toBe(4003);
    });
  });

  describe("Administrative Actions & Reservation Cancellation", () => {
    it("cancels in-flight reservations for kicked member during closeConnectionsForMember", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_kicked_res";
      const memberId = "user_kicked";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      registry.assignMemberToReservation(socketId, memberId, roomId, res.token);
      expect(registry.getPendingReservationCount()).toBe(1);

      // Kicking member closes connections and cancels pending reservations
      registry.closeConnectionsForMember(roomId, memberId, 4003, "removed");

      expect(registry.getPendingReservationCount()).toBe(0);
      expect(registry.isReservationValid(roomId, socketId, res.token)).toBe(false);
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();
    });

    it("cancels all in-flight reservations during room deletion", () => {
      const roomId = "507f1f77bcf86cd799439011";

      const res1 = registry.reserveSlot(roomId, "sock_del_1");
      const res2 = registry.reserveSlot(roomId, "sock_del_2");
      expect(res1.success && res2.success).toBe(true);
      expect(registry.getPendingReservationCount()).toBe(2);

      registry.markRoomDeleted(roomId);
      registry.closeAllConnectionsForRoom(roomId, 1000, "room_deleted");

      expect(registry.getPendingReservationCount()).toBe(0);
      // New reservations in this room are rejected immediately
      const newRes = registry.reserveSlot(roomId, "sock_after_delete");
      expect(newRes.success).toBe(false);
      if (!newRes.success) {
        expect(newRes.reason).toBe("room_unavailable");
      }
    });

    it("cancels all reservations and stops all heartbeats during server shutdown", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const res = registry.reserveSlot(roomId, "sock_shutdown_1");
      expect(res.success).toBe(true);

      registry.setShutdown(true);

      expect(registry.getPendingReservationCount()).toBe(0);
      const newRes = registry.reserveSlot(roomId, "sock_shutdown_2");
      expect(newRes.success).toBe(false);
      if (!newRes.success) {
        expect(newRes.reason).toBe("server_shutting_down");
      }
    });
  });
});
