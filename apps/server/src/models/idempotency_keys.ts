import mongoose, { Schema, Document, Model } from "mongoose";

export interface IIdempotencyKey extends Document {
  key: string;
  actorId: string;
  route: string;
  requestHash: string;
  response?: Record<string, unknown>;
  createdAt: Date;
}

const IdempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    key: { type: String, required: true },
    actorId: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    response: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "idempotency_keys" }
);

// AD-3 & T03: Unique compound index on (key, actor, route) and TTL index of 24 hours
IdempotencyKeySchema.index({ key: 1, actorId: 1, route: 1 }, { unique: true });
IdempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const IdempotencyKeyModel: Model<IIdempotencyKey> =
  (mongoose.models.IdempotencyKey as Model<IIdempotencyKey>) ||
  mongoose.model<IIdempotencyKey>("IdempotencyKey", IdempotencyKeySchema);
