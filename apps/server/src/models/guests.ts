import mongoose, { Schema, Document, Model } from "mongoose";

export interface IGuest extends Document {
  displayName: string;
  roomId: string;
  createdAt: Date;
  expiresAt: Date;
}

const GuestSchema = new Schema<IGuest>(
  {
    displayName: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v: string) => [...v].length <= 40,
        message: "displayName must not exceed 40 characters",
      },
    },
    roomId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days (PRD 12)
    },
  },
  { collection: "guests" }
);

// PRD Section 12: Short-lived; auto-expires after 7 days (time-to-live index on expiresAt)
GuestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GuestModel: Model<IGuest> =
  (mongoose.models.Guest as Model<IGuest>) ||
  mongoose.model<IGuest>("Guest", GuestSchema);
