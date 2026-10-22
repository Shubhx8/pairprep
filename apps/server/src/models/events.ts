import mongoose, { Schema, Document, Model } from "mongoose";

export interface IEvent extends Document {
  roomId: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  ts: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    roomId: { type: String, required: true },
    userId: { type: String, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    ts: { type: Date, default: Date.now },
  },
  { collection: "events" }
);

// PRD Section 12: Generic event log for replay markers and metrics; index on roomId plus ts
EventSchema.index({ roomId: 1, ts: 1 });

export const EventModel: Model<IEvent> =
  (mongoose.models.Event as Model<IEvent>) ||
  mongoose.model<IEvent>("Event", EventSchema);
