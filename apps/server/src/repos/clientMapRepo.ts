import { ClientMapModel, IClientMap } from "../models/client_map.js";

export class ClientMapRepo {
  public async registerClient(
    roomId: string,
    clientId: number,
    actorId: string
  ): Promise<IClientMap> {
    return ClientMapModel.findOneAndUpdate(
      { roomId, clientId },
      {
        $set: {
          actorId,
          connectedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    ).exec();
  }

  public async findByClient(
    roomId: string,
    clientId: number
  ): Promise<IClientMap | null> {
    return ClientMapModel.findOne({ roomId, clientId }).exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await ClientMapModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const clientMapRepo = new ClientMapRepo();
