import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUser extends Document {
  provider: "google" | "github";
  providerId: string;
  displayName: string;
  avatarUrl?: string;
  email: string;
  role: "user" | "owner-admin";
  createdAt: Date;
  disabled: boolean;
}

const UserSchema = new Schema<IUser>(
  {
    provider: { type: String, enum: ["google", "github"], required: true },
    providerId: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    avatarUrl: { type: String },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ["user", "owner-admin"], default: "user" },
    createdAt: { type: Date, default: Date.now },
    disabled: { type: Boolean, default: false },
  },
  { collection: "users" }
);

// PRD Section 12: Unique index on provider plus providerId
UserSchema.index({ provider: 1, providerId: 1 }, { unique: true });

export const UserModel: Model<IUser> =
  (mongoose.models.User as Model<IUser>) || mongoose.model<IUser>("User", UserSchema);
