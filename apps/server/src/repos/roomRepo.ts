import crypto from "node:crypto";
import { RoomModel, IRoom } from "../models/rooms.js";
import { RoomMemberModel } from "../models/room_members.js";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";
import { MessageModel } from "../models/messages.js";
import { EventModel } from "../models/events.js";
import { ClientMapModel } from "../models/client_map.js";
import { GuestModel } from "../models/guests.js";

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
    idempotencyKey?: string;
  }): Promise<IRoom> {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      const slug = data.slug || this.generateSlug();
      const now = new Date();
      const room = new RoomModel({
        slug,
        title: data.title,
        ownerId: data.ownerId,
        type: data.type || "practice",
        language: data.language || "python",
        status: "open",
        timeLimitSec: data.timeLimitSec,
        settings: data.settings || {},
        memberCount: 1,
        memberCountUpdatedAt: now,
        lastActivityAt: now,
        idempotencyKey: data.idempotencyKey,
        createdAt: now,
      });

      try {
        return await room.save();
      } catch (err: unknown) {
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: number }).code === 11000
        ) {
          const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
          // If collision is on ownerId + idempotencyKey, don't retry slug generation
          if (keyPattern && keyPattern["ownerId"] && keyPattern["idempotencyKey"]) {
            throw err;
          }
          // If collision is on slug and we didn't force a custom slug, retry
          if (!data.slug && attempt < maxRetries) {
            continue;
          }
        }
        throw err;
      }
    }

    throw new Error("Failed to generate a unique room slug after retries");
  }

  public async findBySlug(slug: string): Promise<IRoom | null> {
    return RoomModel.findOne({ slug }).exec();
  }

  public async findById(id: string): Promise<IRoom | null> {
    return RoomModel.findById(id).exec();
  }

  public async findByOwnerAndIdempotencyKey(
    ownerId: string,
    idempotencyKey: string
  ): Promise<IRoom | null> {
    return RoomModel.findOne({ ownerId, idempotencyKey }).exec();
  }

  /**
   * PRD PER-2: Retrieve rooms owned by a user, sorted newest first
   */
  public async listByOwner(ownerId: string): Promise<IRoom[]> {
    return RoomModel.find({ ownerId }).sort({ createdAt: -1 }).exec();
  }

  public async touchActivity(roomId: string): Promise<void> {
    await RoomModel.findByIdAndUpdate(roomId, {
      $set: { lastActivityAt: new Date() },
    }).exec();
  }

  public async archiveInactiveRooms(cutoffDate: Date): Promise<number> {
    const res = await RoomModel.updateMany(
      { status: { $ne: "archived" }, lastActivityAt: { $lt: cutoffDate } },
      { $set: { status: "archived" } }
    ).exec();
    return res.modifiedCount;
  }

  public async updateStatus(
    slug: string,
    status: "open" | "live" | "ended" | "archived"
  ): Promise<IRoom | null> {
    const now = new Date();
    const update: { status: string; startedAt?: Date; endedAt?: Date; lastActivityAt: Date } = {
      status,
      lastActivityAt: now,
    };
    if (status === "live") update.startedAt = now;
    if (status === "ended") update.endedAt = now;

    return RoomModel.findOneAndUpdate({ slug }, { $set: update }, { new: true }).exec();
  }

  /**
   * PRD Section 12 Rule 3: Deleting a room cascades to its updates,
   * snapshots, messages, events, guests, client mappings, and members.
   * Cascade order: children first, room document last.
   */
  public async deleteRoom(roomId: string): Promise<boolean> {
    await DocUpdateModel.deleteMany({ roomId }).exec();
    await DocSnapshotModel.deleteMany({ roomId }).exec();
    await MessageModel.deleteMany({ roomId }).exec();
    await EventModel.deleteMany({ roomId }).exec();
    await GuestModel.deleteMany({ roomId }).exec();
    await ClientMapModel.deleteMany({ roomId }).exec();
    await RoomMemberModel.deleteMany({ roomId }).exec();

    const room = await RoomModel.findByIdAndDelete(roomId).exec();
    return room !== null;
  }
}

export const roomRepo = new RoomRepo();
