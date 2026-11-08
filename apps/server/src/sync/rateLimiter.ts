import type { IncomingMessage } from "node:http";
import {
  getClientIp as resolveClientIp,
  normalizeIp,
  parseTrustedProxyCidrs,
} from "../config/proxyTrust.js";
import { config } from "../config.js";

// Re-export trusted proxy list parsed from centralized config
export const TRUSTED_PROXIES = parseTrustedProxyCidrs(config.TRUSTED_PROXY_CIDRS);

export { normalizeIp };

/**
 * Extracts the real client IP address using centralized proxy trust configuration.
 * Untrusted direct connections cannot spoof client IP via X-Forwarded-For.
 */
export function getClientIp(req: IncomingMessage): string {
  return resolveClientIp(req);
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
  private totalRejections = 0;

  constructor(options: UpgradeRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRejections = options.maxRejections ?? 60;
    this.maxEntries = options.maxEntries ?? 5000;
    this.entries = new Map();
    this.totalRejections = 0;
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
    this.totalRejections++;
  }

  /**
   * Returns cumulative total of upgrade rejections recorded.
   */
  getTotalRejections(): number {
    return this.totalRejections;
  }

  /**
   * Resets tracking for a specific IP.
   */
  resetKey(ip: string): void {
    this.entries.delete(normalizeIp(ip));
  }

  /**
   * Clears all tracking state and cumulative rejection counter.
   */
  resetAll(): void {
    this.entries.clear();
    this.totalRejections = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const syncUpgradeRateLimiter = new UpgradeRateLimiter();
