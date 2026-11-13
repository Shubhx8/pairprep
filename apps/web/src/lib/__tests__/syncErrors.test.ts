import { describe, it, expect } from "vitest";
import { formatSyncCloseError } from "../syncErrors.js";

describe("formatSyncCloseError", () => {
  it("formats 4003 permission denied correctly", () => {
    const res = formatSyncCloseError(4003, "permission_denied");
    expect(res.message).toBe(
      "Access denied. You do not have permission to participate in this room."
    );
    expect(res.code).toBe(4003);
    expect(res.isFatal).toBe(true);
  });

  it("formats 4029 rate limit exceeded correctly", () => {
    const res = formatSyncCloseError(4029, "rate_limit_exceeded");
    expect(res.message).toBe(
      "Too many requests. Please slow down and wait a moment before reconnecting."
    );
    expect(res.code).toBe(4029);
    expect(res.isFatal).toBe(false);
  });

  it("formats 1001 server shutdown / going away correctly", () => {
    const res = formatSyncCloseError(1001, "server_shutdown");
    expect(res.message).toBe(
      "Server is restarting or shutting down. Reconnecting shortly..."
    );
    expect(res.code).toBe(1001);
    expect(res.isFatal).toBe(false);
  });

  it("formats 1009 oversized document correctly", () => {
    const res = formatSyncCloseError(1009, "message_too_large");
    expect(res.message).toBe("Document or message exceeds maximum allowed size.");
    expect(res.code).toBe(1009);
    expect(res.isFatal).toBe(true);
  });

  it("formats room full (code 4004 or room_full reason) correctly", () => {
    const res1 = formatSyncCloseError(4004);
    expect(res1.message).toBe(
      "Room is full. This room has reached its maximum capacity of 6 participants."
    );
    expect(res1.isFatal).toBe(true);

    const res2 = formatSyncCloseError(undefined, "room_full");
    expect(res2.message).toBe(
      "Room is full. This room has reached its maximum capacity of 6 participants."
    );
    expect(res2.isFatal).toBe(true);

    const res3 = formatSyncCloseError(undefined, "room_capacity_exceeded");
    expect(res3.message).toBe(
      "Room is full. This room has reached its maximum capacity of 6 participants."
    );
    expect(res3.isFatal).toBe(true);

    const res4 = formatSyncCloseError(undefined, "room_member_limit_exceeded");
    expect(res4.message).toBe(
      "Room is full. This room has reached its maximum capacity of 6 participants."
    );
    expect(res4.isFatal).toBe(true);
  });

  it("formats server not_room_member and room_closed reasons correctly", () => {
    const resMember = formatSyncCloseError(undefined, "not_room_member");
    expect(resMember.message).toBe(
      "Access denied. You do not have permission to participate in this room."
    );
    expect(resMember.isFatal).toBe(true);

    const resClosed = formatSyncCloseError(undefined, "room_closed");
    expect(resClosed.message).toBe("This room has ended or is no longer available.");
    expect(resClosed.isFatal).toBe(true);
  });

  it("formats 4001 unauthenticated correctly", () => {
    const res = formatSyncCloseError(4001, "unauthenticated");
    expect(res.message).toBe(
      "Authentication required. Please sign in or rejoin the room."
    );
    expect(res.isFatal).toBe(true);
  });

  it("provides graceful fallback for unexpected close reasons", () => {
    const res = formatSyncCloseError(1000, "Normal Closure");
    expect(res.message).toBe("Connection closed: Normal Closure");
    expect(res.isFatal).toBe(false);
  });
});
