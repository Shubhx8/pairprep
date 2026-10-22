import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMessage extends Document {
  roomId: string;
  authorId: string;
  text: string;
  ts: Date;
  kind: "user" | "system";
}

const MessageSchema = new Schema<IMessage>(
  {
    roomId: { type: String, required: true },
    authorId: { type: String, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    ts: { type: Date, default: Date.now },
    kind: { type: String, enum: ["user", "system"], default: "user" },
  },
  { collection: "messages" }
);

// PRD Section 12: Capped at 1,000 characters; index on roomId plus ts for loading recent messages
MessageSchema.index({ roomId: 1, ts: 1 });

export const MessageModel: Model<IMessage> =
  (mongoose.models.Message as Model<IMessage>) ||
  mongoose.model<IMessage>("Message", MessageSchema);
