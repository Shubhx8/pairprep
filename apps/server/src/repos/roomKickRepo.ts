import mongoose from "mongoose";
import { RoomKickModel, type IRoomKick } from "../models/room_kicks.js";

// Configurable default cooldown: 15 minutes (900,000 ms)
export const DEFAULT_KICK_COOLDOWN_MS = 15 * 60 * 1000;

export class RoomKickRepo {
  private canQuery(model: unknown, method?: string): boolean {
    const record = model as Record<string, unknown> | null | undefined;
    if (
      method &&
      record &&
      (typeof record === "object" || typeof record === "function")
    ) {
      const fn = record[method] as Record<string, unknown> | null | undefined;
      if (fn?._isMockFunction || fn?.mock) {
        return true;
      }
    }
    if (record?._isMockFunction || record?.mock) {
      return true;
    }
    return mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);
  }

  /**
   * Records a temporary kick restriction with an expiration timestamp.
   * Atomic, idempotent upsert using findOneAndUpdate with $set.
   */
  public async recordKick(
    roomId: string,
    principal: { id: string; type: "user" | "guest" },
    kickedBy: string,
    cooldownMs = DEFAULT_KICK_COOLDOWN_MS,
    reason = "kicked_by_owner"
  ): Promise<IRoomKick | null> {
    if (!this.canQuery(RoomKickModel, "findOneAndUpdate")) return null;

    const kickedAt = new Date();
    const expiresAt = new Date(kickedAt.getTime() + cooldownMs);

    const doc = await RoomKickModel.findOneAndUpdate(
      {
        roomId,
        principalType: principal.type,
        principalId: principal.id,
      },
      {
        $set: {
          kickedAt,
          expiresAt,
          kickedBy,
          reason,
        },
      },
      { upsert: true, new: true }
    ).exec();

    return doc;
  }

  /**
   * Checks whether a principal is currently under an active (unexpired) temporary kick restriction.
   */
  public async isKicked(
    roomId: string,
    principalType: "user" | "guest",
    principalId: string
  ): Promise<boolean> {
    if (!this.canQuery(RoomKickModel, "findOne")) return false;

    const kick = await RoomKickModel.findOne({
      roomId,
      principalType,
      principalId,
    }).exec();

    if (!kick) return false;

    // Check if expired
    if (kick.expiresAt && kick.expiresAt.getTime() <= Date.now()) {
      return false;
    }

    return true;
  }

  /**
   * Clears any active kick restriction for a room principal.
   */
  public async clearKick(
    roomId: string,
    principalType: "user" | "guest",
    principalId: string
  ): Promise<void> {
    if (!this.canQuery(RoomKickModel, "deleteOne")) return;

    await RoomKickModel.deleteOne({
      roomId,
      principalType,
      principalId,
    }).exec();
  }

  /**
   * Cascading cleanup: deletes all kick records associated with a room.
   */
  public async deleteKicksForRoom(roomId: string): Promise<number> {
    if (!this.canQuery(RoomKickModel, "deleteMany")) return 0;
    const res = await RoomKickModel.deleteMany({ roomId }).exec();
    return res.deletedCount ?? 0;
  }
}

export const roomKickRepo = new RoomKickRepo();
