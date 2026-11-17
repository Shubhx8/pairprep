export interface ChatRateLimiterOptions {
  windowMs?: number;
  userMax?: number;
  ipMax?: number;
  maxEntries?: number;
}

export interface ChatRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  reason?: "user_limit" | "ip_limit";
}

/**
 * AD-7 Approved Chat Rate Limiter:
 * - 20 messages per user per 10 seconds.
 * - 100 messages per IP per 10 seconds (campus NAT accommodation).
 *
 * Enforced on the inbound chat:send WebSocket event.
 * If exceeded, returns structured error with retryAfter in seconds.
 */
export class ChatRateLimiter {
  private readonly windowMs: number;
  private readonly userMax: number;
  private readonly ipMax: number;
  private readonly maxEntries: number;
  private readonly userTimestamps = new Map<string, number[]>();
  private readonly ipTimestamps = new Map<string, number[]>();

  constructor(options: ChatRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 10_000;
    this.userMax = options.userMax ?? (process.env["PAIRPREP_E2E"] === "1" ? 1000 : 20);
    this.ipMax = options.ipMax ?? (process.env["PAIRPREP_E2E"] === "1" ? 5000 : 100);
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  private pruneTimestamps(timestamps: number[], now: number): number[] {
    return timestamps.filter((ts) => now - ts < this.windowMs);
  }

  /**
   * Evaluates and records a chat send attempt for the given user ID and IP.
   */
  public consume(
    userId: string,
    ip: string,
    now: number = Date.now()
  ): ChatRateLimitResult {
    const cleanUserId = userId.trim();
    const cleanIp = ip.trim() || "unknown";

    // 1. Check User Limit
    const userHistory = this.pruneTimestamps(
      this.userTimestamps.get(cleanUserId) ?? [],
      now
    );
    if (userHistory.length >= this.userMax) {
      const oldest = userHistory[0] ?? now;
      const retryAfterMs = Math.max(100, this.windowMs - (now - oldest));
      return {
        allowed: false,
        retryAfter: Math.ceil(retryAfterMs / 1000),
        reason: "user_limit",
      };
    }

    // 2. Check IP Limit (AD-7 Campus NAT accommodation)
    const ipHistory = this.pruneTimestamps(this.ipTimestamps.get(cleanIp) ?? [], now);
    if (ipHistory.length >= this.ipMax) {
      const oldest = ipHistory[0] ?? now;
      const retryAfterMs = Math.max(100, this.windowMs - (now - oldest));
      return {
        allowed: false,
        retryAfter: Math.ceil(retryAfterMs / 1000),
        reason: "ip_limit",
      };
    }

    // Bound memory before inserting new entries
    if (
      !this.userTimestamps.has(cleanUserId) &&
      this.userTimestamps.size >= this.maxEntries
    ) {
      this.pruneAll(now);
      if (this.userTimestamps.size >= this.maxEntries) {
        const firstKey = this.userTimestamps.keys().next().value;
        if (firstKey !== undefined) this.userTimestamps.delete(firstKey);
      }
    }
    if (!this.ipTimestamps.has(cleanIp) && this.ipTimestamps.size >= this.maxEntries) {
      this.pruneAll(now);
      if (this.ipTimestamps.size >= this.maxEntries) {
        const firstKey = this.ipTimestamps.keys().next().value;
        if (firstKey !== undefined) this.ipTimestamps.delete(firstKey);
      }
    }

    // Record attempt
    userHistory.push(now);
    this.userTimestamps.set(cleanUserId, userHistory);

    ipHistory.push(now);
    this.ipTimestamps.set(cleanIp, ipHistory);

    return { allowed: true };
  }

  public pruneAll(now: number = Date.now()): void {
    for (const [key, history] of this.userTimestamps.entries()) {
      const valid = this.pruneTimestamps(history, now);
      if (valid.length === 0) {
        this.userTimestamps.delete(key);
      } else {
        this.userTimestamps.set(key, valid);
      }
    }

    for (const [key, history] of this.ipTimestamps.entries()) {
      const valid = this.pruneTimestamps(history, now);
      if (valid.length === 0) {
        this.ipTimestamps.delete(key);
      } else {
        this.ipTimestamps.set(key, valid);
      }
    }
  }

  public reset(): void {
    this.userTimestamps.clear();
    this.ipTimestamps.clear();
  }
}

export const chatRateLimiter = new ChatRateLimiter();
