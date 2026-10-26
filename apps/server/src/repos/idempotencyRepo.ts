import { IdempotencyKeyModel, IIdempotencyKey } from "../models/idempotency_keys.js";

export interface ReserveKeyResult {
  status: "won" | "in_progress" | "completed" | "mismatch";
  record?: IIdempotencyKey;
}

export class IdempotencyRepo {
  public async getKey(
    key: string,
    actorId: string,
    route: string
  ): Promise<IIdempotencyKey | null> {
    return IdempotencyKeyModel.findOne({ key, actorId, route }).exec();
  }

  public async setKey(data: {
    key: string;
    actorId: string;
    route: string;
    requestHash: string;
    response?: Record<string, unknown>;
  }): Promise<IIdempotencyKey> {
    const record = new IdempotencyKeyModel({
      key: data.key,
      actorId: data.actorId,
      route: data.route,
      requestHash: data.requestHash,
      status: "completed",
      startedAt: new Date(),
      response: data.response,
      createdAt: new Date(),
    });
    return record.save();
  }

  /**
   * Attempts to reserve an idempotency key with in_progress status and startedAt timestamp.
   * If duplicate key is detected:
   * - Different payload -> returns "mismatch"
   * - Already completed -> returns "completed" with cached response
   * - In progress with stale lease (>30s) -> atomically takes over lease and returns "won"
   * - In progress with active lease (<=30s) -> returns "in_progress"
   */
  public async reserveKey(data: {
    key: string;
    actorId: string;
    route: string;
    requestHash: string;
  }): Promise<ReserveKeyResult> {
    const now = new Date();
    try {
      const record = new IdempotencyKeyModel({
        key: data.key,
        actorId: data.actorId,
        route: data.route,
        requestHash: data.requestHash,
        status: "in_progress",
        startedAt: now,
        createdAt: now,
      });

      const saved = await record.save();
      return { status: "won", record: saved };
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: number }).code === 11000
      ) {
        const existing = await IdempotencyKeyModel.findOne({
          key: data.key,
          actorId: data.actorId,
          route: data.route,
        }).exec();

        if (!existing) {
          return { status: "in_progress" };
        }

        if (existing.requestHash !== data.requestHash) {
          return { status: "mismatch", record: existing };
        }

        if (existing.status === "completed") {
          return { status: "completed", record: existing };
        }

        // Stale lease takeover if in_progress for >30 seconds
        if (Date.now() - existing.startedAt.getTime() > 30000) {
          const taken = await IdempotencyKeyModel.findOneAndUpdate(
            {
              _id: existing._id,
              status: "in_progress",
              startedAt: existing.startedAt,
            },
            {
              $set: { startedAt: now },
            },
            { new: true }
          ).exec();

          if (taken) {
            return { status: "won", record: taken };
          }
        }

        return { status: "in_progress", record: existing };
      }

      throw err;
    }
  }

  /**
   * Completes key with cached 2xx response, fenced strictly on startedAt lease.
   */
  public async completeKey(
    key: string,
    actorId: string,
    route: string,
    startedAt: Date,
    statusCode: number,
    response: Record<string, unknown>
  ): Promise<boolean> {
    const result = await IdempotencyKeyModel.findOneAndUpdate(
      { key, actorId, route, startedAt, status: "in_progress" },
      { $set: { status: "completed", statusCode, response } }
    ).exec();

    return result !== null;
  }

  /**
   * Deletes key on non-2xx failure or exception, fenced strictly on startedAt lease.
   */
  public async deleteKey(
    key: string,
    actorId: string,
    route: string,
    startedAt: Date
  ): Promise<boolean> {
    const result = await IdempotencyKeyModel.deleteOne({
      key,
      actorId,
      route,
      startedAt,
    }).exec();

    return result.deletedCount > 0;
  }
}

export const idempotencyRepo = new IdempotencyRepo();
