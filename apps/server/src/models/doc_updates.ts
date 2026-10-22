import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDocUpdate extends Document {
  roomId: string;
  seq: number;
  authorId: string;
  ts: Date;
  update: Buffer;
  size: number;
}

const DocUpdateSchema = new Schema<IDocUpdate>(
  {
    roomId: { type: String, required: true },
    seq: { type: Number, required: true },
    authorId: { type: String, required: true },
    ts: { type: Date, default: Date.now },
    update: { type: Buffer, required: true },
    size: { type: Number, required: true },
  },
  { collection: "doc_updates" }
);

// PRD Section 12: Append-only; index on roomId plus seq
DocUpdateSchema.index({ roomId: 1, seq: 1 }, { unique: true });

export const DocUpdateModel: Model<IDocUpdate> =
  (mongoose.models.DocUpdate as Model<IDocUpdate>) ||
  mongoose.model<IDocUpdate>("DocUpdate", DocUpdateSchema);
