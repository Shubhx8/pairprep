import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDocSnapshot extends Document {
  roomId: string;
  seq: number;
  ts: Date;
  state?: Buffer;
  text?: string;
}

const DocSnapshotSchema = new Schema<IDocSnapshot>(
  {
    roomId: { type: String, required: true },
    seq: { type: Number, required: true },
    ts: { type: Date, default: Date.now },
    state: { type: Buffer },
    text: { type: String },
  },
  { collection: "doc_snapshots" }
);

// PRD Section 12: Index on roomId plus seq descending for fast latest snapshot retrieval
DocSnapshotSchema.index({ roomId: 1, seq: -1 });

export const DocSnapshotModel: Model<IDocSnapshot> =
  (mongoose.models.DocSnapshot as Model<IDocSnapshot>) ||
  mongoose.model<IDocSnapshot>("DocSnapshot", DocSnapshotSchema);
