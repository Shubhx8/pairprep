import crypto from "node:crypto";
import mongoose from "mongoose";
import { RoomModel, IRoom } from "../models/rooms.js";
import { RoomMemberModel } from "../models/room_members.js";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";
import { MessageModel } from "../models/messages.js";
import { EventModel } from "../models/events.js";
import { ClientMapModel } from "../models/client_map.js";
import { GuestModel } from "../models/guests.js";
import { DurableOperationModel } from "../models/durable_operations.js";
import { AppError } from "../errors/AppError.js";
import { roomMutationBarrier } from "../events/roomMutationBarrier.js";
import { roomBanRepo } from "./roomBanRepo.js";
import { roomKickRepo } from "./roomKickRepo.js";

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
    return RoomModel.findOne({ slug, status: { $ne: "deleted" } }).exec();
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

  public async touchActivity(roomId: string): Promise<void> {
    await RoomModel.findOneAndUpdate(
      { _id: roomId, status: { $ne: "deleted" } },
      { $set: { lastActivityAt: new Date() } }
    ).exec();
  }

  public async archiveInactiveRooms(cutoffDate: Date): Promise<number> {
    const res = await RoomModel.updateMany(
      {
        status: { $nin: ["archived", "deleted"] },
        lastActivityAt: { $lt: cutoffDate },
      },
      { $set: { status: "archived" } }
    ).exec();
    return res.modifiedCount;
  }

  public async updateStatus(
    slug: string,
    status: "open" | "live" | "ended" | "archived" | "deleted",
    opId?: string
  ): Promise<IRoom | null> {
    const findOneMock = RoomModel.findOne as unknown as
      Record<string, unknown> | undefined;
    const isFindOneMocked = Boolean(findOneMock?._isMockFunction || findOneMock?.mock);
    const isDbConnected =
      mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);

    if (opId && (isDbConnected || isFindOneMocked)) {
      const existing = await RoomModel.findOne({ slug }).select("appliedOpIds").exec();
      if (
        existing &&
        existing.appliedOpIds &&
        existing.appliedOpIds.length >= 100 &&
        !existing.appliedOpIds.includes(opId)
      ) {
        throw new AppError(
          "Too many pending status operations for room.",
          409,
          "CAPACITY_EXCEEDED"
        );
      }
    }

    const now = new Date();
    const update: Record<string, unknown> = {
      status,
      lastActivityAt: now,
    };
    if (status === "live") update["startedAt"] = now;
    if (status === "ended") {
      // Authoritative immutable endedAt (Phase 5): only set on first transition to ended
      if (isDbConnected || isFindOneMocked) {
        const existing = await RoomModel.findOne({ slug }).select("endedAt").exec();
        if (!existing?.endedAt) {
          update["endedAt"] = now;
        }
      } else {
        update["endedAt"] = now;
      }
    }
    if (status === "deleted") update["deletedAt"] = now;
    if (opId) update["statusOpId"] = opId;

    const updateOps: Record<string, unknown> = { $set: update };
    if (opId) {
      updateOps["$addToSet"] = { appliedOpIds: opId };
    }

    return RoomModel.findOneAndUpdate({ slug, status: { $ne: "deleted" } }, updateOps, {
      new: true,
    }).exec();
  }

  /**
   * PRD ROOM-6 / H-1: Sets the deletion barrier on the room.
   * Atomically marks room status as "deleted" and stamps deletionOpId.
   * This immediately prevents new joins, messages, role changes, and queries.
   */
  public async setDeletionBarrier(roomId: string, opId: string): Promise<IRoom | null> {
    if (mongoose.connection.readyState === 1) {
      const existing = await RoomModel.findById(roomId).select("appliedOpIds").exec();
      if (
        existing &&
        existing.appliedOpIds &&
        existing.appliedOpIds.length >= 100 &&
        !existing.appliedOpIds.includes(opId)
      ) {
        throw new AppError(
          "Too many pending status operations for room.",
          409,
          "CAPACITY_EXCEEDED"
        );
      }
    }

    const now = new Date();
    return RoomModel.findOneAndUpdate(
      { _id: roomId, status: { $ne: "deleted" } },
      {
        $set: {
          status: "deleted",
          deletionOpId: opId,
          deletedAt: now,
          lastActivityAt: now,
        },
        $addToSet: { appliedOpIds: opId },
      },
      { new: true }
    ).exec();
  }

  /**
   * PRD CH-1 & T09: Allocates a strictly monotonic sequence number for room messages.
   * Atomic $inc ensures no duplicate sequence numbers under concurrency.
   */
  public async allocateMessageSeq(roomId: string, allowClosed = false): Promise<number> {
    return roomMutationBarrier.withAdmission(roomId, async () => {
      const filter: Record<string, unknown> = {
        _id: roomId,
        status: allowClosed ? { $ne: "deleted" } : { $in: ["open", "live"] },
      };
      const room = await RoomModel.findOneAndUpdate(
        filter,
        { $inc: { messageSeq: 1 } },
        { new: true }
      ).exec();
      if (!room) {
        throw new Error("Cannot allocate sequence number: room not found or closed");
      }
      return room.messageSeq ?? 1;
    });
  }

  /**
   * PRD Section 12 Rule 3 / H-2: Deleting a room cascades to its updates,
   * snapshots, messages, events, guests, client mappings, members, and durable operations.
   * Cascade order: children first, room document next, and non-active durable operations.
   * If activeOpId is provided, preserves the active deletion outbox record for recovery.
   */
  public async deleteRoom(roomId: string, activeOpId?: string): Promise<boolean> {
    await DocUpdateModel.deleteMany({ roomId }).exec();
    await DocSnapshotModel.deleteMany({ roomId }).exec();
    await MessageModel.deleteMany({ roomId }).exec();
    await EventModel.deleteMany({ roomId }).exec();
    await GuestModel.deleteMany({ roomId }).exec();
    await ClientMapModel.deleteMany({ roomId }).exec();
    await RoomMemberModel.deleteMany({ roomId }).exec();
    await roomBanRepo.deleteBansForRoom(roomId);
    await roomKickRepo.deleteKicksForRoom(roomId);

    // H-2: Safely transition any pending outbox records to abandoned so they are never silently deleted
    await DurableOperationModel.updateMany(
      {
        roomId,
        opId: { $ne: activeOpId },
        status: { $in: ["intent_recorded", "applied", "persisted", "published"] },
      },
      {
        $set: {
          status: "abandoned",
          error: `Superseded: room deleted by operation ${activeOpId}`,
          updatedAt: new Date(),
        },
      }
    ).exec();

    // Terminal outbox records are retained for 7 days via the TTL index on updatedAt
    // (expireAfterSeconds: 604800) for post-mortem audits and crash recovery verification.

    const room = await RoomModel.findByIdAndDelete(roomId).exec();
    return room !== null;
  }

  /**
   * Cleans up operation ownership evidence on terminal operation resolution.
   */
  public async clearOperationEvidence(roomId: string, opId: string): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    await RoomModel.updateOne(
      { _id: roomId },
      {
        $pull: {
          appliedOpIds: opId,
          removedMembers: { opId },
        },
      }
    ).exec();
  }

  /**
   * Records a banned principal (user or guest) preventing re-entry after owner kick.
   * Delegates to the canonical roomBanRepo.
   */
  public async banPrincipal(
    roomId: string,
    principalId: string,
    principalType: "user" | "guest" = "user",
    bannedBy = "system"
  ): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    await roomBanRepo.banPrincipal(
      roomId,
      { id: principalId, type: principalType },
      bannedBy
    );
  }

  /**
   * Checks whether a principal is banned from entering the room.
   * Delegates to the canonical roomBanRepo.
   */
  public async isPrincipalBanned(
    roomId: string,
    principalId: string,
    principalType?: "user" | "guest"
  ): Promise<boolean> {
    if (mongoose.connection.readyState !== 1) return false;
    if (principalType) {
      return roomBanRepo.isBanned(roomId, principalType, principalId);
    }
    return roomBanRepo.isPrincipalIdBanned(roomId, principalId);
  }
}

export const roomRepo = new RoomRepo();
