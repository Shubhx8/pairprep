import type { IncomingMessage } from "node:http";
import {
  getClientIp,
  normalizeIp,
  getTrustProxyFn,
  type TrustProxyFn,
} from "../config/proxyTrust.js";

export interface SocketHandshakeRateLimiterOptions {
  windowMs?: number;
  maxAttempts?: number;
  maxEntries?: number;
}

/**
 * Process-Local Socket.IO Handshake Admission Rate Limiter.
 *
 * ARCHITECTURAL NOTE:
 * This rate limiter maintains process-local in-memory state. In accordance with
 * Phase 0 single-process server architecture, state is NOT distributed across
 * multiple server processes or instances (no Redis or external store dependency).
 * Handshake admission applies at the Engine.IO HTTP upgrade boundary before
 * Socket.IO connection admission, socket initialization, or event handlers.
 */
export class SocketHandshakeRateLimiter {
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly maxEntries: number;
  private readonly entries: Map<string, number[]>;

  constructor(options: SocketHandshakeRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 60;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.entries = new Map();
  }

  /**
   * Normalizes an IP string or falls back to 'unknown'.
   */
  private sanitizeIp(ip?: string | null): string {
    if (!ip || typeof ip !== "string") {
      return "unknown";
    }
    const norm = normalizeIp(ip);
    return norm.length > 0 ? norm : "unknown";
  }

  /**
   * Removes expired timestamps for an IP, deleting the entry if empty.
   */
  private pruneIp(ip: string, now: number): number[] {
    const timestamps = this.entries.get(ip);
    if (!timestamps) return [];

    const valid = timestamps.filter((t) => now - t < this.windowMs);
    if (valid.length === 0) {
      this.entries.delete(ip);
      return [];
    }
    this.entries.set(ip, valid);
    return valid;
  }

  /**
   * Prunes expired timestamps across all tracked IP entries.
   */
  pruneExpired(now: number = Date.now()): void {
    for (const [key, timestamps] of this.entries.entries()) {
      const valid = timestamps.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.entries.delete(key);
      } else {
        this.entries.set(key, valid);
      }
    }
  }

  /**
   * Checks whether an IP has reached or exceeded the handshake rate limit
   * without consuming an attempt slot.
   */
  isRateLimited(ip?: string | null, now: number = Date.now()): boolean {
    const safeIp = this.sanitizeIp(ip);
    const valid = this.pruneIp(safeIp, now);
    return valid.length >= this.maxAttempts;
  }

  /**
   * Synchronously attempts to consume a handshake admission slot for the given IP.
   * Returns true if allowed (under limit), false if rate limited.
   *
   * Because JavaScript execution in Node.js is single-threaded, synchronous execution
   * guarantees atomic check-and-increment without race conditions under concurrency.
   */
  consume(ip?: string | null, now: number = Date.now()): boolean {
    const safeIp = this.sanitizeIp(ip);
    const valid = this.pruneIp(safeIp, now);

    if (valid.length >= this.maxAttempts) {
      return false;
    }

    // Ensure memory is bounded before inserting a new key
    if (!this.entries.has(safeIp) && this.entries.size >= this.maxEntries) {
      this.pruneExpired(now);
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) {
          this.entries.delete(oldestKey);
        }
      }
    }

    valid.push(now);
    this.entries.set(safeIp, valid);
    return true;
  }

  /**
   * Returns remaining attempts in the current window for an IP.
   */
  getRemainingAttempts(ip?: string | null, now: number = Date.now()): number {
    const safeIp = this.sanitizeIp(ip);
    const valid = this.pruneIp(safeIp, now);
    return Math.max(0, this.maxAttempts - valid.length);
  }

  /**
   * Returns the count of tracked unique IP entries.
   */
  getTrackedIpCount(): number {
    return this.entries.size;
  }

  /**
   * Resets rate limit tracking for a specific IP, or clears all entries if no IP is provided.
   */
  reset(ip?: string | null): void {
    if (ip !== undefined && ip !== null) {
      this.entries.delete(this.sanitizeIp(ip));
    } else {
      this.entries.clear();
    }
  }
}

/**
 * Extracts and normalizes the client IP address from a Socket.IO handshake request.
 * Safely handles missing, invalid, or malformed requests and socket instances.
 */
export function resolveHandshakeIp(
  req?:
    | IncomingMessage
    | { address?: string; headers?: Record<string, string | string[] | undefined> }
    | null,
  trustFn: TrustProxyFn = getTrustProxyFn()
): string {
  if (!req) {
    return "unknown";
  }
  try {
    if ("socket" in req || "connection" in req) {
      const resolved = getClientIp(req as IncomingMessage, trustFn);
      const normalized = normalizeIp(resolved);
      return normalized || "unknown";
    }
    if ("address" in req && typeof req.address === "string") {
      const normalized = normalizeIp(req.address);
      return normalized || "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
