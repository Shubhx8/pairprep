import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoom extends Document {
  slug: string;
  title: string;
  type: "practice" | "interview";
  ownerId: string;
  language: "python" | "cpp" | "javascript";
  status: "open" | "live" | "ended" | "archived";
  settings: Record<string, unknown>;
  problemId?: string;
  timeLimitSec?: number;
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
      enum: ["open", "live", "ended", "archived"],
      default: "open",
    },
    settings: { type: Schema.Types.Mixed, default: {} },
    problemId: { type: String },
    timeLimitSec: { type: Number },
    startedAt: { type: Date },
    endedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "rooms" }
);

// PRD Section 12: Unique index on slug; index on ownerId plus createdAt
RoomSchema.index({ slug: 1 }, { unique: true });
RoomSchema.index({ ownerId: 1, createdAt: -1 });

export const RoomModel: Model<IRoom> =
  (mongoose.models.Room as Model<IRoom>) || mongoose.model<IRoom>("Room", RoomSchema);
