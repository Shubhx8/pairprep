/**
 * Centralized mapping from WebSocket close codes and error reasons
 * to user-friendly, accessible error messages.
 *
 * Implements PRD T08 Section 11:
 * - 4003: Friendly permission / authorization message
 * - 4029: Friendly rate-limit message
 * - 1001: Friendly connection-ended / server-shutdown message
 * - 1009: Friendly oversized message / document message
 * - Room full: Friendly maximum capacity message (6 participants)
 */

export interface FormattedSyncError {
  /** User-friendly message suitable for presentation in the UI */
  message: string;
  /** WebSocket close code if applicable */
  code?: number;
  /** Raw technical reason for logs */
  rawReason?: string;
  /** Indicates whether the connection should permanently cease retrying */
  isFatal: boolean;
}

export function formatSyncCloseError(
  code?: number,
  rawReason?: string
): FormattedSyncError {
  const reason = (rawReason || "").toLowerCase();

  // 1. Room full condition (code 4004 or server capacity / member limit reasons)
  if (
    code === 4004 ||
    reason.includes("room_capacity_exceeded") ||
    reason.includes("room_member_limit_exceeded") ||
    reason.includes("room_capacity") ||
    reason.includes("room capacity") ||
    reason.includes("member_limit") ||
    reason.includes("capacity_exceeded") ||
    reason.includes("capacity exceeded") ||
    reason.includes("room_full") ||
    reason.includes("room full") ||
    reason.includes("maximum 6")
  ) {
    return {
      message:
        "Room is full. This room has reached its maximum capacity of 6 participants.",
      code,
      rawReason,
      isFatal: true,
    };
  }

  // 2. Rate limiting (code 4029)
  if (
    code === 4029 ||
    reason.includes("rate_limit") ||
    reason.includes("rate limit") ||
    reason.includes("too many requests")
  ) {
    return {
      message:
        "Too many requests. Please slow down and wait a moment before reconnecting.",
      code,
      rawReason,
      isFatal: false,
    };
  }

  // 3. Permission & Authentication (codes 4001, 4003 or server permission reasons)
  if (
    code === 4001 ||
    reason.includes("unauthenticated") ||
    reason.includes("authentication failed")
  ) {
    return {
      message: "Authentication required. Please sign in or rejoin the room.",
      code,
      rawReason,
      isFatal: true,
    };
  }

  if (
    code === 4003 ||
    reason.includes("not_room_member") ||
    reason.includes("permission") ||
    reason.includes("unauthorized") ||
    reason.includes("kicked") ||
    reason.includes("forbidden")
  ) {
    return {
      message: "Access denied. You do not have permission to participate in this room.",
      code,
      rawReason,
      isFatal: true,
    };
  }

  // 4. Room closed or deleted
  if (
    reason.includes("room_closed") ||
    reason.includes("room_deleted") ||
    reason.includes("room_not_found")
  ) {
    return {
      message: "This room has ended or is no longer available.",
      code,
      rawReason,
      isFatal: true,
    };
  }

  // 5. Server restart / Shutdown / Going away (code 1001)
  if (
    code === 1001 ||
    reason.includes("shutting down") ||
    reason.includes("server_shutdown") ||
    reason.includes("going away")
  ) {
    return {
      message: "Server is restarting or shutting down. Reconnecting shortly...",
      code,
      rawReason,
      isFatal: false,
    };
  }

  // 6. Oversized message / document (code 1009)
  if (
    code === 1009 ||
    reason.includes("too big") ||
    reason.includes("oversized") ||
    reason.includes("message_too_large")
  ) {
    return {
      message: "Document or message exceeds maximum allowed size.",
      code,
      rawReason,
      isFatal: true,
    };
  }

  // Default fallback
  const fallbackMessage =
    rawReason && !rawReason.startsWith("code ")
      ? `Connection closed: ${rawReason}`
      : "Connection to synchronization server was closed.";

  return {
    message: fallbackMessage,
    code,
    rawReason,
    isFatal: false,
  };
}
