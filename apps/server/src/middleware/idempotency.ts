import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { idempotencyRepo } from "../repos/idempotencyRepo.js";
import { isValidUUID } from "./logger.js";

/**
 * Deterministically serializes an object into a canonical JSON string with sorted keys.
 * Handles nested objects, arrays, and primitive types without any 'any' casting.
 */
export function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalize).join(",")}]`;
  }
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  return `{${sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

/**
 * Computes a deterministic request fingerprint: method + path + sha256(canonicalBody)
 */
export function computeRequestHash(req: Request): string {
  const payloadHash = crypto
    .createHash("sha256")
    .update(canonicalize(req.body ?? {}))
    .digest("hex");
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  return `${req.method}:${fullPath}:${payloadHash}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Idempotency middleware for mutating endpoints.
 * 1. Checks Idempotency-Key (or x-idempotency-key) header.
 * 2. Validates UUID format; rejects invalid UUID with 400 INVALID_IDEMPOTENCY_KEY.
 * 3. Hashes request method, full path, and canonically stringified payload.
 * 4. Reserves key with startedAt lease in idempotency_keys collection.
 * 5. If duplicate:
 *    - Different payload -> 422 IDEMPOTENCY_KEY_REUSED
 *    - Completed -> returns cached 2xx response immediately
 *    - In progress -> polls for winner completion (up to 3s); returns cached response or 409 CONCURRENT_REQUEST_IN_PROGRESS
 * 6. If won:
 *    - 2xx response -> cached in collection, fenced strictly on startedAt
 *    - Non-2xx response or crash -> key deleted, fenced strictly on startedAt, allowing clean retries
 */
export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const rawKey = (req.headers["idempotency-key"] || req.headers["x-idempotency-key"]) as
    string | undefined;

  if (!rawKey) {
    return next();
  }

  const key = rawKey.trim();
  const requestId =
    (res.getHeader("X-Request-Id") as string) ||
    (req.headers["x-request-id"] as string) ||
    "";

  if (!isValidUUID(key)) {
    res.status(400).json({
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be a valid UUID",
        requestId,
      },
    });
    return;
  }

  const actorId = req.principal?.id || req.ip || "anonymous";
  const route = `${req.baseUrl || ""}${req.path || ""}`;
  const requestHash = computeRequestHash(req);

  idempotencyRepo
    .reserveKey({ key, actorId, route, requestHash })
    .then(async (reserveResult) => {
      if (reserveResult.status === "mismatch") {
        res.status(422).json({
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "Idempotency key was previously used with a different payload",
            requestId,
          },
        });
        return;
      }

      if (reserveResult.status === "completed" && reserveResult.record) {
        const cached = reserveResult.record;
        if (cached.statusCode === 204) {
          res.status(204).end();
          return;
        }
        res.status(cached.statusCode || 200).json(cached.response || {});
        return;
      }

      if (reserveResult.status === "in_progress") {
        // Poll for winner completion (up to 3 seconds with 50ms intervals)
        const maxWaitMs = 3000;
        const intervalMs = 50;
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
          await sleep(intervalMs);
          const current = await idempotencyRepo.getKey(key, actorId, route);
          if (!current) {
            // Key was deleted due to winner failure; retry reservation
            const retryReserve = await idempotencyRepo.reserveKey({
              key,
              actorId,
              route,
              requestHash,
            });
            if (retryReserve.status === "won" && retryReserve.record) {
              return setupLeaseHandling(retryReserve.record.startedAt);
            }
            if (retryReserve.status === "completed" && retryReserve.record) {
              if (retryReserve.record.statusCode === 204) {
                res.status(204).end();
                return;
              }
              res
                .status(retryReserve.record.statusCode || 200)
                .json(retryReserve.record.response || {});
              return;
            }
            break;
          }

          if (current.requestHash !== requestHash) {
            res.status(422).json({
              error: {
                code: "IDEMPOTENCY_KEY_REUSED",
                message: "Idempotency key was previously used with a different payload",
                requestId,
              },
            });
            return;
          }

          if (current.status === "completed") {
            if (current.statusCode === 204) {
              res.status(204).end();
              return;
            }
            res.status(current.statusCode || 200).json(current.response || {});
            return;
          }
        }

        res.status(409).json({
          error: {
            code: "CONCURRENT_REQUEST_IN_PROGRESS",
            message: "A request with this idempotency key is currently being processed",
            requestId,
          },
        });
        return;
      }

      // We won the reservation
      if (!reserveResult.record) {
        return next();
      }

      setupLeaseHandling(reserveResult.record.startedAt);
    })
    .catch((err) => next(err));

  function setupLeaseHandling(leaseStartedAt: Date) {
    let responseBody: unknown = undefined;
    const originalJson = res.json.bind(res);

    res.json = (body: unknown): Response => {
      responseBody = body;
      return originalJson(body);
    };

    let finalized = false;

    const cleanup = async () => {
      if (finalized) return;
      finalized = true;

      const statusCode = res.statusCode;
      if (statusCode >= 200 && statusCode < 300) {
        // Cache DTO only, strictly fenced on startedAt lease
        await idempotencyRepo.completeKey(
          key,
          actorId,
          route,
          leaseStartedAt,
          statusCode,
          responseBody && typeof responseBody === "object"
            ? (responseBody as Record<string, unknown>)
            : {}
        );
      } else {
        // Delete key on any failure / non-2xx outcome, fenced on startedAt
        await idempotencyRepo.deleteKey(key, actorId, route, leaseStartedAt);
      }
    };

    res.on("finish", () => {
      cleanup().catch(() => {});
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        idempotencyRepo.deleteKey(key, actorId, route, leaseStartedAt).catch(() => {});
      }
    });

    next();
  }
}
