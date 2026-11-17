import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoomKick extends Document {
  roomId: string;
  principalType: "user" | "guest";
  principalId: string;
  kickedAt: Date;
  expiresAt: Date;
  kickedBy: string;
  reason?: string;
}

const RoomKickSchema = new Schema<IRoomKick>(
  {
    roomId: { type: String, required: true, index: true },
    principalType: { type: String, enum: ["user", "guest"], required: true },
    principalId: { type: String, required: true },
    kickedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    kickedBy: { type: String, required: true },
    reason: { type: String, default: "kicked_by_owner" },
  },
  { collection: "room_kicks", timestamps: false }
);

// Exactly one active kick record per principal per room
RoomKickSchema.index({ roomId: 1, principalType: 1, principalId: 1 }, { unique: true });
// TTL index: MongoDB automatically purges documents when expiresAt is reached
RoomKickSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoomKickModel: Model<IRoomKick> =
  mongoose.models.RoomKick || mongoose.model<IRoomKick>("RoomKick", RoomKickSchema);
