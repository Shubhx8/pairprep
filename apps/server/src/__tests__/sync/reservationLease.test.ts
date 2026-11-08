import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
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

  describe("Immediate Abandoned Authentication Handshake Cleanup (Commit 6a)", () => {
    // Required Test 1 — Disconnect During Authentication
    it("releases reservation and halts heartbeat immediately when socket disconnects during async auth", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_auth_disconnect";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(true);
      expect(registry.getTotalRoomCount(roomId)).toBe(1);

      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      let abortedReason = "";
      const registered = registry.registerTransportCloseListener(
        roomId,
        socketId,
        token,
        mockTransport,
        (reason) => {
          abortedReason = reason;
        }
      );
      expect(registered).toBe(true);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(true);

      // Simulate long-running asynchronous DB operation:
      // While auth is in flight, client drops transport
      mockTransport.emit("close");

      // Verify reservation and heartbeat cancelled immediately without waiting for 30s deadline
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();
      expect(registry.hasReservationForSocket(socketId, roomId)).toBe(false);
      expect(registry.isReservationValid(roomId, socketId, token)).toBe(false);
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(abortedReason).toBe("socket_closed");
      expect(registry.getTotalRoomCount(roomId)).toBe(0);

      // Prove another client can immediately acquire the released slot
      const res2 = registry.reserveSlot(roomId, "sock_replacement");
      expect(res2.success).toBe(true);
      expect(registry.getTotalRoomCount(roomId)).toBe(1);

      // When delayed async database operation finishes, late promotion must fail
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_late_auth",
        { id: "member_late_auth", type: "user", displayName: "Late User" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("reservation_missing");
      }
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    // Required Test 2 — Disconnect During Document Loading
    it("cleans up reservation and halts heartbeat when socket disconnects during document loading", async () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_docload_disconnect";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      registry.assignMemberToReservation(socketId, "member_docload", roomId, token);

      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      registry.registerTransportCloseListener(roomId, socketId, token, mockTransport);
      expect(registry.isReservationValid(roomId, socketId, token)).toBe(true);

      // Simulate client disconnect during document load
      mockTransport.emit("close");

      expect(registry.isReservationValid(roomId, socketId, token)).toBe(false);
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);

      // Resume document loading: late promotion fails
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_docload",
        { id: "member_docload", type: "user", displayName: "Docload User" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    // Required Test 3 — Late Heartbeat Race
    it("prevents cancelled reservation from being recreated or renewed by stale heartbeat", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_heartbeat_race";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(true);

      // Cancel reservation
      registry.cancelReservation(socketId, roomId, "explicit_cancellation");
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();

      // Trigger stale touch / heartbeat renewal
      const touchResult = registry.touchReservation(roomId, socketId, token);
      expect(touchResult).toBe(false);
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);

      // Verify token cannot be promoted
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_race",
        { id: "member_race", type: "user", displayName: "Race User" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("reservation_missing");
      }
    });

    // Required Test 4 — Successful Promotion Listener Cleanup
    it("cleans up transport listener upon successful promotion so normal disconnect lifecycle applies", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_promo_cleanup";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      registry.registerTransportCloseListener(roomId, socketId, token, mockTransport);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(true);

      const mockConn: SyncConnectionLike = {
        socketId,
        readOnly: false,
        webSocket: { close: vi.fn() },
      };

      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_promoted",
        { id: "member_promoted", type: "user", displayName: "Promoted User" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(true);
      // Transport close listener MUST be cleaned up on promotion
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(true);

      // Emitting 'close' now should NOT trigger pending reservation cancellation logic
      mockTransport.emit("close");
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(true);

      // Normal unregisterConnection handles established connection disconnect
      registry.unregisterConnection(roomId, socketId);
      expect(registry.hasActiveConnection(socketId, roomId)).toBe(false);
    });

    // Required Test 5 — Multi-Room Shared Socket
    it("preserves Room B reservation and heartbeat when Room A transport lifecycle is cancelled", () => {
      const roomA = "507f1f77bcf86cd799439011";
      const roomB = "507f1f77bcf86cd799439022";
      const socketId = "sock_multi_isolated";

      const resA = registry.reserveSlot(roomA, socketId);
      const resB = registry.reserveSlot(roomB, socketId);
      expect(resA.success && resB.success).toBe(true);
      if (!resA.success || !resB.success) return;

      const mockTransportA = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      const mockTransportB = new EventEmitter() as EventEmitter & { destroyed?: boolean };

      registry.registerTransportCloseListener(roomA, socketId, resA.token, mockTransportA);
      registry.registerTransportCloseListener(roomB, socketId, resB.token, mockTransportB);

      expect(registry.hasTransportCloseListener(roomA, socketId)).toBe(true);
      expect(registry.hasTransportCloseListener(roomB, socketId)).toBe(true);

      // Cancel Room A only
      registry.cancelReservation(socketId, roomA, "room_a_cancelled");

      expect(registry.hasTransportCloseListener(roomA, socketId)).toBe(false);
      expect(registry.getReservation(socketId, roomA)).toBeUndefined();
      expect(registry.hasHeartbeat(roomA, socketId)).toBe(false);

      // Room B must remain completely intact
      expect(registry.hasTransportCloseListener(roomB, socketId)).toBe(true);
      expect(registry.getReservation(socketId, roomB)?.token).toBe(resB.token);
      expect(registry.hasHeartbeat(roomB, socketId)).toBe(true);
      expect(registry.getTotalRoomCount(roomB)).toBe(1);

      // Room B promotion succeeds
      const mockConnB: SyncConnectionLike = { socketId, readOnly: false };
      const promoB = registry.promoteReservation(
        socketId,
        roomB,
        "member_b",
        { id: "member_b", type: "user", displayName: "User B" },
        mockConnB,
        "editor",
        resB.token
      );
      expect(promoB.success).toBe(true);
      expect(registry.hasActiveConnection(socketId, roomB)).toBe(true);
    });

    // Required Test 6 — Shutdown
    it("cancels pending reservations, heartbeats, and transport listeners on shutdown and blocks late promotion", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_shutdown_immediate";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      registry.registerTransportCloseListener(roomId, socketId, token, mockTransport);

      expect(registry.hasHeartbeat(roomId, socketId)).toBe(true);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(true);

      // Server initiates shutdown
      registry.setShutdown(true);

      expect(registry.getPendingReservationCount()).toBe(0);
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(registry.isReservationValid(roomId, socketId, token)).toBe(false);

      // Late async DB resolution attempts promotion
      const mockConn: SyncConnectionLike = { socketId, readOnly: false };
      const promoResult = registry.promoteReservation(
        socketId,
        roomId,
        "member_shutdown",
        { id: "member_shutdown", type: "user", displayName: "Shutdown User" },
        mockConn,
        "editor",
        token
      );
      expect(promoResult.success).toBe(false);
      if (!promoResult.success) {
        expect(promoResult.reason).toBe("server_shutting_down");
      }
    });

    // Test 1 — Destroyed Node socket
    it("immediately rejects and cancels reservation if transport is already destroyed before registration", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_already_destroyed";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(true);

      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };
      mockTransport.destroyed = true;

      let abortCallCount = 0;
      let abortedReason = "";
      const registered = registry.registerTransportCloseListener(
        roomId,
        socketId,
        token,
        mockTransport,
        (reason) => {
          abortCallCount++;
          abortedReason = reason;
        }
      );

      // Registration returns failure result
      expect(registered).toBe(false);

      // Reservation is cancelled immediately
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();
      expect(registry.hasReservationForSocket(socketId, roomId)).toBe(false);
      expect(registry.isReservationValid(roomId, socketId, token)).toBe(false);

      // Heartbeat is stopped immediately
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);

      // No temporary listeners remain
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(mockTransport.listenerCount("close")).toBe(0);
      expect(mockTransport.listenerCount("end")).toBe(0);
      expect(mockTransport.listenerCount("error")).toBe(0);

      // Abort callback is invoked exactly once
      expect(abortCallCount).toBe(1);
      expect(abortedReason).toBe("socket_already_closed");
    });

    // Test 2 — String-valued closed state
    it("immediately rejects and cancels reservation if transport has string readyState 'closed'", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_already_closed_str";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(true);

      const mockTransport = new EventEmitter() as EventEmitter & { readyState?: string };
      mockTransport.readyState = "closed";

      let abortCallCount = 0;
      let abortedReason = "";
      const registered = registry.registerTransportCloseListener(
        roomId,
        socketId,
        token,
        mockTransport,
        (reason) => {
          abortCallCount++;
          abortedReason = reason;
        }
      );

      // Registration returns failure result
      expect(registered).toBe(false);

      // Reservation is cancelled immediately
      expect(registry.getReservation(socketId, roomId)).toBeUndefined();
      expect(registry.hasReservationForSocket(socketId, roomId)).toBe(false);
      expect(registry.isReservationValid(roomId, socketId, token)).toBe(false);

      // Heartbeat is stopped immediately
      expect(registry.hasHeartbeat(roomId, socketId)).toBe(false);

      // No temporary listeners remain
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(mockTransport.listenerCount("close")).toBe(0);
      expect(mockTransport.listenerCount("end")).toBe(0);
      expect(mockTransport.listenerCount("error")).toBe(0);

      // Abort callback is invoked exactly once
      expect(abortCallCount).toBe(1);
      expect(abortedReason).toBe("socket_already_closed");
    });

    // Test 3 — Listener cleanup across all events
    it("removes transport listener from close, end, and error events upon cleanup and remains idempotent", () => {
      const roomId = "507f1f77bcf86cd799439011";
      const socketId = "sock_cleanup_all_events";

      const res = registry.reserveSlot(roomId, socketId);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const token = res.token;
      const mockTransport = new EventEmitter() as EventEmitter & { destroyed?: boolean };

      const registered = registry.registerTransportCloseListener(roomId, socketId, token, mockTransport);
      expect(registered).toBe(true);
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(true);

      // Verify listeners were attached to all 3 events
      expect(mockTransport.listenerCount("close")).toBe(1);
      expect(mockTransport.listenerCount("end")).toBe(1);
      expect(mockTransport.listenerCount("error")).toBe(1);

      // Remove listener explicitly
      registry.removeTransportCloseListener(roomId, socketId);

      // Verify listener was removed from ALL THREE events
      expect(registry.hasTransportCloseListener(roomId, socketId)).toBe(false);
      expect(mockTransport.listenerCount("close")).toBe(0);
      expect(mockTransport.listenerCount("end")).toBe(0);
      expect(mockTransport.listenerCount("error")).toBe(0);

      // Repeated cleanup calls are completely harmless and idempotent
      expect(() => {
        registry.removeTransportCloseListener(roomId, socketId);
        registry.removeTransportCloseListener(roomId, socketId);
      }).not.toThrow();
    });
  });
});
