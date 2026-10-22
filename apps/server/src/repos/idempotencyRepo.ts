import { IdempotencyKeyModel, IIdempotencyKey } from "../models/idempotency_keys.js";

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
      response: data.response,
      createdAt: new Date(),
    });

    return record.save();
  }
}

export const idempotencyRepo = new IdempotencyRepo();
