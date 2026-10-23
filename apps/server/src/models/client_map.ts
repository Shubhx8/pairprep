import mongoose, { Schema, Document, Model } from "mongoose";

export interface IClientMap extends Document {
  roomId: string;
  clientId: number;
  actorId: string;
  connectedAt: Date;
}

const ClientMapSchema = new Schema<IClientMap>(
  {
    roomId: { type: String, required: true },
    clientId: { type: Number, required: true },
    actorId: { type: String, required: true },
    connectedAt: { type: Date, default: Date.now },
  },
  { collection: "client_map" }
);

// PRD Section 12: Index on roomId plus clientId for author attribution mapping
ClientMapSchema.index({ roomId: 1, clientId: 1 });

export const ClientMapModel: Model<IClientMap> =
  (mongoose.models.ClientMap as Model<IClientMap>) ||
  mongoose.model<IClientMap>("ClientMap", ClientMapSchema);
