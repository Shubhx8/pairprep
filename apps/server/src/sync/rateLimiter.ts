import proxyaddr from "proxy-addr";
import type { IncomingMessage } from "node:http";

// Trusted subnets: loopback, Docker, and internal cluster subnets
export const TRUSTED_PROXIES = [
  "loopback",
  "linklocal",
  "uniquelocal",
  "10.0.0.0/8",
  "172.16.0.0/12",
];
const trustFn = proxyaddr.compile(TRUSTED_PROXIES);

/**
 * Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
 * so that rate limiting buckets remain consistent across dual-stack sockets.
 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * Extracts the real client IP address using proxy-addr with trusted proxy configuration.
 * Untrusted direct connections cannot spoof client IP via X-Forwarded-For.
 */
export function getClientIp(req: IncomingMessage): string {
  try {
    const rawIp =
      proxyaddr(req, trustFn) || req.socket.remoteAddress || "127.0.0.1";
    return normalizeIp(rawIp);
  } catch {
    return normalizeIp(req.socket.remoteAddress || "127.0.0.1");
  }
}

export interface UpgradeRateLimiterOptions {
  windowMs?: number;
  maxRejections?: number;
  maxEntries?: number;
}

/**
 * Tracks rejected upgrade attempts per IP (e.g. invalid origin, 401/403/404, bad protocol).
 * Bounded to maxEntries to guarantee bounded memory usage.
 */
export class UpgradeRateLimiter {
  private readonly windowMs: number;
  private readonly maxRejections: number;
  private readonly maxEntries: number;
  private readonly entries: Map<string, number[]>;

  constructor(options: UpgradeRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRejections = options.maxRejections ?? 60;
    this.maxEntries = options.maxEntries ?? 5000;
    this.entries = new Map();
  }

  /**
   * Checks if an IP has exceeded the allowed rejected connection limit.
   */
  isRateLimited(ip: string, now = Date.now()): boolean {
    const normIp = normalizeIp(ip);
    const timestamps = this.entries.get(normIp);
    if (!timestamps) return false;

    const valid = timestamps.filter((t) => now - t < this.windowMs);
    if (valid.length === 0) {
      this.entries.delete(normIp);
      return false;
    }
    this.entries.set(normIp, valid);
    return valid.length >= this.maxRejections;
  }

  /**
   * Records a rejected connection attempt for an IP.
   */
  recordRejection(ip: string, now = Date.now()): void {
    const normIp = normalizeIp(ip);
    if (this.entries.size >= this.maxEntries && !this.entries.has(normIp)) {
      // Evict oldest entry (first key in map)
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    const timestamps = this.entries.get(normIp) || [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);
    valid.push(now);
    this.entries.set(normIp, valid);
  }

  /**
   * Resets tracking for a specific IP.
   */
  resetKey(ip: string): void {
    this.entries.delete(normalizeIp(ip));
  }

  /**
   * Clears all tracking state.
   */
  resetAll(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const syncUpgradeRateLimiter = new UpgradeRateLimiter();
