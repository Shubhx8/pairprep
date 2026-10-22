import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRoomMember extends Document {
  roomId: string;
  memberId: string;
  displayName: string;
  role: "owner" | "interviewer" | "candidate" | "editor" | "viewer";
  isGuest: boolean;
  joinedAt: Date;
  lastSeenAt: Date;
}

const RoomMemberSchema = new Schema<IRoomMember>(
  {
    roomId: { type: String, required: true },
    memberId: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ["owner", "interviewer", "candidate", "editor", "viewer"],
      required: true,
    },
    isGuest: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { collection: "room_members" }
);

// PRD Section 12: Unique on roomId plus member
RoomMemberSchema.index({ roomId: 1, memberId: 1 }, { unique: true });

export const RoomMemberModel: Model<IRoomMember> =
  (mongoose.models.RoomMember as Model<IRoomMember>) ||
  mongoose.model<IRoomMember>("RoomMember", RoomMemberSchema);
