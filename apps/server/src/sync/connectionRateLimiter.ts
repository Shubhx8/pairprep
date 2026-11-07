export interface ConnectionRateLimiterOptions {
  /** Maximum message tokens burst capacity. Default: 100 */
  maxMessageBurst?: number;
  /** Message token refill rate per second. Default: 50 */
  messageRefillPerSec?: number;
  /** Maximum byte tokens burst capacity. Default: 2,097,152 (2 MB) */
  maxByteBurst?: number;
  /** Byte token refill rate per second. Default: 1,048,576 (1 MB/s) */
  byteRefillPerSec?: number;
  /** Entry TTL in milliseconds for idle state pruning. Default: 60,000 (1 min) */
  entryTtlMs?: number;
  /** Maximum entries to retain in memory to prevent exhaustion. Default: 10,000 */
  maxEntries?: number;
}

export type RateLimitReason =
  | "message_rate_limit_exceeded"
  | "byte_rate_limit_exceeded"
  | "rate_limiter_capacity_exceeded"
  | "invalid_socket_identity";

export type RateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: RateLimitReason;
    };

export interface ConnectionRateState {
  messageTokens: number;
  byteTokens: number;
  lastRefillAt: number;
}

/**
 * Dual token-bucket rate limiter for WebSocket connections.
 * Enforces per-connection limits on both message frequency (messages/sec)
 * and byte throughput (bytes/sec) to defend against malicious flooding,
 * while allowing normal collaborative typing and initial synchronization bursts.
 */
export class ConnectionRateLimiter {
  private readonly maxMessageBurst: number;
  private readonly messageRefillPerSec: number;
  private readonly maxByteBurst: number;
  private readonly byteRefillPerSec: number;
  private readonly entryTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries: Map<string, ConnectionRateState>;

  constructor(options: ConnectionRateLimiterOptions = {}) {
    this.maxMessageBurst = options.maxMessageBurst ?? 100;
    this.messageRefillPerSec = options.messageRefillPerSec ?? 50;
    this.maxByteBurst = options.maxByteBurst ?? 2 * 1024 * 1024;
    this.byteRefillPerSec = options.byteRefillPerSec ?? 1024 * 1024;
    this.entryTtlMs = options.entryTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.entries = new Map();
  }

  /**
   * Consumes 1 message token and byteLength byte tokens for a given socketId.
   * If either bucket has insufficient tokens, returns allowed: false with the specific reason.
   */
  consume(
    socketId: string,
    byteLength: number,
    now = Date.now()
  ): RateLimitResult {
    if (!socketId || typeof socketId !== "string" || !socketId.trim()) {
      return { allowed: false, reason: "invalid_socket_identity" };
    }

    let state = this.entries.get(socketId);

    if (!state) {
      if (this.entries.size >= this.maxEntries) {
        this.prune(now);
        if (this.entries.size >= this.maxEntries) {
          // Reject new untracked connection to preserve capacity and prevent active connection eviction
          return { allowed: false, reason: "rate_limiter_capacity_exceeded" };
        }
      }

      state = {
        messageTokens: this.maxMessageBurst,
        byteTokens: this.maxByteBurst,
        lastRefillAt: now,
      };
      this.entries.set(socketId, state);
    } else {
      // Refill tokens based on elapsed time
      const deltaMs = Math.max(0, now - state.lastRefillAt);
      if (deltaMs > 0) {
        const deltaSec = deltaMs / 1000;
        state.messageTokens = Math.min(
          this.maxMessageBurst,
          state.messageTokens + deltaSec * this.messageRefillPerSec
        );
        state.byteTokens = Math.min(
          this.maxByteBurst,
          state.byteTokens + deltaSec * this.byteRefillPerSec
        );
        state.lastRefillAt = now;
      }
    }

    // Check message count
    if (state.messageTokens < 1) {
      return { allowed: false, reason: "message_rate_limit_exceeded" };
    }

    // Check byte volume
    if (state.byteTokens < byteLength) {
      return { allowed: false, reason: "byte_rate_limit_exceeded" };
    }

    // Deduct tokens
    state.messageTokens -= 1;
    state.byteTokens -= byteLength;

    return { allowed: true };
  }

  /**
   * Cleans up tracking state for a disconnected or failed socket.
   */
  cleanup(socketId: string): void {
    if (socketId) {
      this.entries.delete(socketId);
    }
  }

  /**
   * Checks if an entry currently exists for socketId.
   */
  has(socketId: string): boolean {
    return this.entries.has(socketId);
  }

  /**
   * Returns current state for socketId (for inspection/testing).
   */
  get(socketId: string): ConnectionRateState | undefined {
    return this.entries.get(socketId);
  }

  /**
   * Prunes entries that haven't been active for longer than entryTtlMs.
   */
  prune(now = Date.now()): number {
    let prunedCount = 0;
    for (const [socketId, state] of this.entries.entries()) {
      if (now - state.lastRefillAt > this.entryTtlMs) {
        this.entries.delete(socketId);
        prunedCount++;
      }
    }
    return prunedCount;
  }

  /**
   * Resets all tracked connections (useful in test teardown).
   */
  resetAll(): void {
    this.entries.clear();
  }

  /**
   * Current number of tracked connections.
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * WebSocket close error representing rate limit / flood defense violation.
 * Uses close code 4029 (application-level 429 Too Many Requests).
 */
export class RateLimitError extends Error {
  readonly code: number = 4029;
  readonly reason: RateLimitReason;

  constructor(reason: RateLimitReason) {
    super(`WebSocket rate limit exceeded: ${reason}`);
    this.name = "RateLimitError";
    this.reason = reason;
  }
}

export const connectionRateLimiter = new ConnectionRateLimiter();

