import crypto from "node:crypto";
import { RoomModel, IRoom } from "../models/rooms.js";
import { RoomMemberModel } from "../models/room_members.js";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";
import { MessageModel } from "../models/messages.js";
import { EventModel } from "../models/events.js";
import { ClientMapModel } from "../models/client_map.js";

export class RoomRepo {
  /**
   * PRD ROOM-1 & T03: Generates a cryptographically unguessable room slug
   * with at least 128 bits of entropy encoded as base64url.
   * Matches /^[A-Za-z0-9_-]+$/ with no padding (=), plus (+), or slash (/).
   */
  public generateSlug(): string {
    return crypto.randomBytes(16).toString("base64url");
  }

  public async createRoom(data: {
    title: string;
    ownerId: string;
    type?: "practice" | "interview";
    language?: "python" | "cpp" | "javascript";
    timeLimitSec?: number;
    settings?: Record<string, unknown>;
    slug?: string;
  }): Promise<IRoom> {
    const slug = data.slug || this.generateSlug();
    const room = new RoomModel({
      slug,
      title: data.title,
      ownerId: data.ownerId,
      type: data.type || "practice",
      language: data.language || "python",
      status: "open",
      timeLimitSec: data.timeLimitSec,
      settings: data.settings || {},
      createdAt: new Date(),
    });

    return room.save();
  }

  public async findBySlug(slug: string): Promise<IRoom | null> {
    return RoomModel.findOne({ slug }).exec();
  }

  public async findById(id: string): Promise<IRoom | null> {
    return RoomModel.findById(id).exec();
  }

  /**
   * PRD PER-2: Retrieve rooms owned by a user, sorted newest first
   */
  public async listByOwner(ownerId: string): Promise<IRoom[]> {
    return RoomModel.find({ ownerId }).sort({ createdAt: -1 }).exec();
  }

  public async updateStatus(
    slug: string,
    status: "open" | "live" | "ended" | "archived"
  ): Promise<IRoom | null> {
    const update: { status: string; startedAt?: Date; endedAt?: Date } = { status };
    if (status === "live") update.startedAt = new Date();
    if (status === "ended") update.endedAt = new Date();

    return RoomModel.findOneAndUpdate({ slug }, { $set: update }, { new: true }).exec();
  }

  /**
   * PRD Section 12 Rule 3: Deleting a room cascades to its updates,
   * snapshots, messages, events, members, and client mappings.
   */
  public async deleteRoom(roomId: string): Promise<boolean> {
    const room = await RoomModel.findByIdAndDelete(roomId).exec();
    if (!room) return false;

    await Promise.all([
      DocUpdateModel.deleteMany({ roomId }).exec(),
      DocSnapshotModel.deleteMany({ roomId }).exec(),
      MessageModel.deleteMany({ roomId }).exec(),
      EventModel.deleteMany({ roomId }).exec(),
      RoomMemberModel.deleteMany({ roomId }).exec(),
      ClientMapModel.deleteMany({ roomId }).exec(),
    ]);

    return true;
  }
}

export const roomRepo = new RoomRepo();
