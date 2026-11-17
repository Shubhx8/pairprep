export interface ReceiptTokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface ReceiptRateLimiterOptions {
  capacity?: number;
  refillRatePerSec?: number;
  maxEntries?: number;
}

export interface ReceiptRateLimitResult {
  allowed: boolean;
  retryAfter?: number; // in seconds
}

/**
 * Token Bucket Rate Limiter for WhatsApp-style Receipt Events (Phase 4 / AC-16):
 * - Covers chat:delivered, chat:read, and chat:read_batch.
 * - Capacity: 100 tokens.
 * - Refill rate: 20 tokens per second.
 * - Event costs:
 *     - chat:delivered (single): 1 token
 *     - chat:read (single): 1 token
 *     - chat:read_batch: 2 + floor(N / 10) tokens
 * - Tracks both principalId and socketId to prevent multi-socket abuse.
 * - Periodic cleanup of inactive buckets.
 */
export class ReceiptRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly maxEntries: number;
  private readonly principalBuckets = new Map<string, ReceiptTokenBucket>();
  private readonly socketBuckets = new Map<string, ReceiptTokenBucket>();

  constructor(options: ReceiptRateLimiterOptions = {}) {
    this.capacity = options.capacity ?? (process.env["PAIRPREP_E2E"] === "1" ? 500 : 100);
    const refillPerSec =
      options.refillRatePerSec ?? (process.env["PAIRPREP_E2E"] === "1" ? 100 : 20);
    this.refillRatePerMs = refillPerSec / 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  public getCost(type: "delivered" | "read" | "read_batch", batchSize = 1): number {
    if (type === "delivered") return 1;
    if (type === "read") return 1;
    if (type === "read_batch") {
      return 2 + Math.floor(Math.max(1, batchSize) / 10);
    }
    return 1;
  }

  private updateBucket(
    bucket: ReceiptTokenBucket | undefined,
    cost: number,
    now: number
  ): { bucket: ReceiptTokenBucket; allowed: boolean; retryAfter?: number } {
    const current: ReceiptTokenBucket = bucket ?? {
      tokens: this.capacity,
      lastRefill: now,
    };

    const elapsed = Math.max(0, now - current.lastRefill);
    const refilled = Math.min(
      this.capacity,
      current.tokens + elapsed * this.refillRatePerMs
    );
    current.lastRefill = now;

    if (refilled >= cost) {
      current.tokens = refilled - cost;
      return { bucket: current, allowed: true };
    }

    // Insufficient tokens
    current.tokens = refilled;
    const deficit = cost - refilled;
    const retryAfterMs = Math.ceil(deficit / this.refillRatePerMs);
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { bucket: current, allowed: false, retryAfter: retryAfterSec };
  }

  /**
   * Consumes tokens for a receipt operation across principal and socket boundaries.
   */
  public consume(
    principalId: string,
    socketId: string,
    type: "delivered" | "read" | "read_batch",
    batchSize = 1,
    now = Date.now()
  ): ReceiptRateLimitResult {
    this.enforceCapacity();

    const cost = this.getCost(type, batchSize);

    // 1. Evaluate Socket Bucket
    const socketRes = this.updateBucket(this.socketBuckets.get(socketId), cost, now);
    this.socketBuckets.set(socketId, socketRes.bucket);

    if (!socketRes.allowed) {
      return { allowed: false, retryAfter: socketRes.retryAfter };
    }

    // 2. Evaluate Principal Bucket (prevents bypassing limits via multi-socket abuse)
    const principalRes = this.updateBucket(
      this.principalBuckets.get(principalId),
      cost,
      now
    );
    this.principalBuckets.set(principalId, principalRes.bucket);

    if (!principalRes.allowed) {
      // Revert socket consumption on principal rejection
      socketRes.bucket.tokens = Math.min(this.capacity, socketRes.bucket.tokens + cost);
      return { allowed: false, retryAfter: principalRes.retryAfter };
    }

    return { allowed: true };
  }

  public cleanupSocket(socketId: string): void {
    this.socketBuckets.delete(socketId);
  }

  public cleanupPrincipal(principalId: string): void {
    this.principalBuckets.delete(principalId);
  }

  private enforceCapacity(): void {
    if (this.socketBuckets.size > this.maxEntries) {
      this.socketBuckets.clear();
    }
    if (this.principalBuckets.size > this.maxEntries) {
      this.principalBuckets.clear();
    }
  }

  public reset(): void {
    this.socketBuckets.clear();
    this.principalBuckets.clear();
  }
}

export const receiptRateLimiter = new ReceiptRateLimiter();
