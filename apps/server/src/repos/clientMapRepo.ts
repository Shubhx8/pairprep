import mongoose from "mongoose";
import { ClientMapModel, IClientMap } from "../models/client_map.js";
import { rootLogger } from "../middleware/logger.js";

export interface ClientMapRegistrationResult {
  record: IClientMap | null;
  isConflict: boolean;
  isNew: boolean;
}

export class ClientMapRepo {
  /**
   * Registers a Yjs clientId mapping to an authenticated actorId for a room.
   * Enforces strict "first claim wins" semantics:
   * 1. If an existing record exists with the same actorId, returns isConflict: false, isNew: false.
   * 2. If an existing record exists with a DIFFERENT actorId, does NOT overwrite, logs a warning safely,
   *    and returns isConflict: true, isNew: false.
   * 3. Uses atomic $setOnInsert with upsert: true and handles duplicate-key (E11000) race conditions.
   */
  public async registerClient(
    roomId: string,
    clientId: number,
    actorId: string
  ): Promise<ClientMapRegistrationResult> {
    if (mongoose.connection.readyState !== 1) {
      return { record: null, isConflict: false, isNew: false };
    }

    try {
      const existing = await ClientMapModel.findOne({ roomId, clientId }).exec();
      if (existing) {
        if (existing.actorId !== actorId) {
          rootLogger.warn(
            {
              roomId,
              clientId,
              registeredActorId: existing.actorId,
              claimingActorId: actorId,
            },
            "Conflicting Yjs clientId claim detected; retaining original author attribution"
          );
          return { record: existing, isConflict: true, isNew: false };
        }
        return { record: existing, isConflict: false, isNew: false };
      }

      const doc = await ClientMapModel.findOneAndUpdate(
        { roomId, clientId },
        {
          $setOnInsert: {
            actorId,
            connectedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      ).exec();

      if (doc && doc.actorId !== actorId) {
        rootLogger.warn(
          { roomId, clientId, registeredActorId: doc.actorId, claimingActorId: actorId },
          "Concurrent conflicting Yjs clientId claim race; retaining original author attribution"
        );
        return { record: doc, isConflict: true, isNew: false };
      }

      return { record: doc, isConflict: false, isNew: true };
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 11000) {
        const existing = await ClientMapModel.findOne({ roomId, clientId }).exec();
        const isConflict = existing ? existing.actorId !== actorId : false;
        if (isConflict && existing) {
          rootLogger.warn(
            {
              roomId,
              clientId,
              registeredActorId: existing.actorId,
              claimingActorId: actorId,
            },
            "Duplicate key race during Yjs clientId claim; retaining original author attribution"
          );
        }
        return { record: existing, isConflict, isNew: false };
      }
      throw err;
    }
  }

  public async findByClient(
    roomId: string,
    clientId: number
  ): Promise<IClientMap | null> {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }
    return ClientMapModel.findOne({ roomId, clientId }).exec();
  }

  public async findByRoom(roomId: string): Promise<IClientMap[]> {
    if (mongoose.connection.readyState !== 1) {
      return [];
    }
    return ClientMapModel.find({ roomId }).exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    if (mongoose.connection.readyState !== 1) {
      return 0;
    }
    const result = await ClientMapModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const clientMapRepo = new ClientMapRepo();
