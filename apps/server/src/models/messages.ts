import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMessage extends Document {
  roomId: string;
  seq: number;
  authorId: string;
  authorName?: string;
  clientMsgId?: string;
  text: string;
  ts: Date;
  kind: "user" | "system";
  opId?: string;
}

const MessageSchema = new Schema<IMessage>(
  {
    roomId: { type: String, required: true },
    seq: { type: Number, required: true },
    authorId: { type: String, required: true },
    authorName: { type: String, trim: true },
    clientMsgId: { type: String, trim: true },
    text: { type: String, required: true, maxlength: 1000 },
    ts: { type: Date, default: Date.now },
    kind: { type: String, enum: ["user", "system"], default: "user" },
    opId: { type: String, trim: true },
  },
  { collection: "messages" }
);

MessageSchema.pre("validate", async function () {
  if (this.seq === undefined || this.seq === null) {
    if (mongoose.connection.readyState === 1 && this.roomId) {
      const highest = await mongoose
        .model<IMessage>("Message")
        .findOne({ roomId: this.roomId })
        .sort({ seq: -1 })
        .select("seq")
        .exec();
      this.seq = (highest?.seq ?? 0) + 1;
    } else {
      this.seq = 1;
    }
  }
});

// 1. Monotonic sequence uniqueness per room
MessageSchema.index({ roomId: 1, seq: 1 }, { unique: true });

// 2. Client message idempotency (partial filter for string clientMsgId)
MessageSchema.index(
  { roomId: 1, authorId: 1, clientMsgId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMsgId: { $type: "string" } },
  }
);

// 3. Chronological sorting for history pagination
MessageSchema.index({ roomId: 1, ts: 1 });

// 4. Outbox system message exactly-once deduplication
MessageSchema.index(
  { roomId: 1, opId: 1 },
  {
    unique: true,
    partialFilterExpression: { opId: { $type: "string" } },
  }
);

export const MessageModel: Model<IMessage> =
  (mongoose.models.Message as Model<IMessage>) ||
  mongoose.model<IMessage>("Message", MessageSchema);
