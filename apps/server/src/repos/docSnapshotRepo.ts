import { DocSnapshotModel, IDocSnapshot } from "../models/doc_snapshots.js";

export class DocSnapshotRepo {
  public async createSnapshot(data: {
    roomId: string;
    seq: number;
    state?: Buffer;
    text?: string;
  }): Promise<IDocSnapshot> {
    const snapshot = new DocSnapshotModel({
      roomId: data.roomId,
      seq: data.seq,
      state: data.state,
      text: data.text,
      ts: new Date(),
    });

    return snapshot.save();
  }

  public async getLatestSnapshot(roomId: string): Promise<IDocSnapshot | null> {
    return DocSnapshotModel.findOne({ roomId }).sort({ seq: -1 }).exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await DocSnapshotModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const docSnapshotRepo = new DocSnapshotRepo();
