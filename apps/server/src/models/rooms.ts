import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoom extends Document {
  slug: string;
  title: string;
  type: "practice" | "interview";
  ownerId: string;
  language: "python" | "cpp" | "javascript";
  status: "open" | "live" | "ended" | "archived" | "deleted";
  settings: Record<string, unknown>;
  problemId?: string;
  timeLimitSec?: number;
  memberCount: number;
  memberCountUpdatedAt: Date;
  lastActivityAt: Date;
  messageSeq?: number;
  idempotencyKey?: string;
  statusOpId?: string;
  deletionOpId?: string;
  deletedAt?: Date;
  lastRemovedMember?: { memberDocId: string; opId: string };
  removedMembers?: { memberDocId: string; opId: string; removedAt: Date }[];
  appliedOpIds?: string[];
  version?: number;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
}

const RoomSchema = new Schema<IRoom>(
  {
    slug: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: ["practice", "interview"], default: "practice" },
    ownerId: { type: String, required: true },
    language: {
      type: String,
      enum: ["python", "cpp", "javascript"],
      default: "python",
    },
    status: {
      type: String,
      enum: ["open", "live", "ended", "archived", "deleted"],
      default: "open",
    },
    settings: { type: Schema.Types.Mixed, default: {} },
    problemId: { type: String },
    timeLimitSec: { type: Number },
    memberCount: { type: Number, default: 1, min: 1, max: 6 },
    memberCountUpdatedAt: { type: Date, default: Date.now },
    lastActivityAt: { type: Date, default: Date.now },
    messageSeq: { type: Number, default: 0, min: 0 },
    idempotencyKey: { type: String },
    statusOpId: { type: String },
    deletionOpId: { type: String },
    deletedAt: { type: Date },
    lastRemovedMember: { type: Schema.Types.Mixed },
    removedMembers: {
      type: [
        {
          memberDocId: { type: String, required: true },
          opId: { type: String, required: true },
          removedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    appliedOpIds: { type: [String], default: [] },
    version: { type: Number, default: 0 },
    startedAt: { type: Date },
    endedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "rooms" }
);

// PRD Section 12 & T05: Indexes
RoomSchema.index({ slug: 1 }, { unique: true });
RoomSchema.index({ ownerId: 1, createdAt: -1 });
RoomSchema.index({ lastActivityAt: 1 });
RoomSchema.index(
  { ownerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

export const RoomModel: Model<IRoom> =
  (mongoose.models.Room as Model<IRoom>) || mongoose.model<IRoom>("Room", RoomSchema);
