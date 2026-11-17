import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoleOpEvidence {
  opId: string;
  role: string;
  version: number;
  appliedAt: Date;
}

export interface IRoomMember extends Document {
  roomId: string;
  memberId: string;
  displayName: string;
  role: "owner" | "interviewer" | "candidate" | "editor" | "viewer";
  isGuest: boolean;
  guestExpiresAt?: Date;
  lastOpId?: string;
  joinOpId?: string;
  appliedOpIds?: string[];
  roleVersion?: number;
  roleOps?: IRoleOpEvidence[];
  tombstoneOpId?: string;
  joinedAt: Date;
  lastSeenAt: Date;
}

const RoomMemberSchema = new Schema<IRoomMember>(
  {
    roomId: { type: String, required: true },
    memberId: { type: String, required: true },
    displayName: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v: string) => [...v].length <= 40,
        message: "displayName must not exceed 40 characters",
      },
    },
    role: {
      type: String,
      enum: ["owner", "interviewer", "candidate", "editor", "viewer"],
      required: true,
    },
    isGuest: { type: Boolean, default: false },
    guestExpiresAt: { type: Date },
    lastOpId: { type: String },
    joinOpId: { type: String },
    appliedOpIds: { type: [String], default: [] },
    roleVersion: { type: Number, default: 1 },
    roleOps: {
      type: [
        {
          opId: { type: String, required: true },
          role: { type: String, required: true },
          version: { type: Number, required: true },
          appliedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    tombstoneOpId: { type: String },
    joinedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { collection: "room_members" }
);

// PRD Section 12 & T05: Indexes
RoomMemberSchema.index({ roomId: 1, memberId: 1 }, { unique: true });
RoomMemberSchema.index({ memberId: 1, joinedAt: -1, _id: -1 });
RoomMemberSchema.index({ guestExpiresAt: 1 }, { sparse: true });

export const RoomMemberModel: Model<IRoomMember> =
  (mongoose.models.RoomMember as Model<IRoomMember>) ||
  mongoose.model<IRoomMember>("RoomMember", RoomMemberSchema);
