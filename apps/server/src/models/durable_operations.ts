import mongoose, { Schema, Document, Model } from "mongoose";

export type DurableOperationType =
  "join" | "remove" | "role_change" | "room_ended" | "room_deleted";

export type DurableOperationStatus =
  "intent_recorded" | "applied" | "persisted" | "published" | "completed" | "abandoned";

export interface IDurableOperation extends Document {
  opId: string; // Stable opId: sys:${type}:${roomId}:${targetMemberDocId}:${nonce}
  roomId: string;
  type: DurableOperationType;
  status: DurableOperationStatus;
  payload: Record<string, unknown>;
  seq?: number;
  messageId?: string;
  appliedVersion?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DurableOperationSchema = new Schema<IDurableOperation>(
  {
    opId: { type: String, required: true, unique: true },
    roomId: { type: String, required: true },
    type: {
      type: String,
      enum: ["join", "remove", "role_change", "room_ended", "room_deleted"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "intent_recorded",
        "applied",
        "persisted",
        "published",
        "completed",
        "abandoned",
      ],
      required: true,
      default: "intent_recorded",
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    seq: { type: Number },
    messageId: { type: String },
    appliedVersion: { type: Number },
    error: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "durable_operations" }
);

DurableOperationSchema.index({ roomId: 1, status: 1 });
DurableOperationSchema.index({ status: 1, updatedAt: 1 });
DurableOperationSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 7 * 24 * 3600,
    partialFilterExpression: { status: { $in: ["completed", "abandoned"] } },
  }
);

export const DurableOperationModel: Model<IDurableOperation> =
  (mongoose.models.DurableOperation as Model<IDurableOperation>) ||
  mongoose.model<IDurableOperation>("DurableOperation", DurableOperationSchema);
