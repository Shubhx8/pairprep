import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoomBan extends Document {
  roomId: string;
  principalType: "user" | "guest";
  principalId: string;
  bannedAt: Date;
  bannedBy: string;
  reason?: string;
}

const RoomBanSchema = new Schema<IRoomBan>(
  {
    roomId: { type: String, required: true, index: true },
    principalType: { type: String, enum: ["user", "guest"], required: true },
    principalId: { type: String, required: true },
    bannedAt: { type: Date, default: Date.now },
    bannedBy: { type: String, required: true },
    reason: { type: String, default: "kicked_by_owner" },
  },
  { collection: "room_bans", timestamps: false }
);

// Authoritative unique constraint: exactly one ban record per principal per room
RoomBanSchema.index({ roomId: 1, principalType: 1, principalId: 1 }, { unique: true });
RoomBanSchema.index({ roomId: 1, bannedAt: -1 });

export const RoomBanModel: Model<IRoomBan> =
  mongoose.models.RoomBan || mongoose.model<IRoomBan>("RoomBan", RoomBanSchema);
