import { DocUpdateModel, IDocUpdate } from "../models/doc_updates.js";

/**
 * PRD Section 12 & T03: Strictly append-only repository for document updates.
 * Exposes NO update or single-item delete methods (e.g. updateOne and deleteOne are undefined).
 * Only appendUpdate, getUpdatesSince, and deleteByRoom (for room cleanup cascade) are permitted.
 */
export class DocUpdateRepo {
  public async appendUpdate(data: {
    roomId: string;
    seq: number;
    authorId: string;
    update: Buffer;
    size?: number;
    ts?: Date;
  }): Promise<IDocUpdate> {
    const docUpdate = new DocUpdateModel({
      roomId: data.roomId,
      seq: data.seq,
      authorId: data.authorId,
      update: data.update,
      size: data.size ?? data.update.length,
      ts: data.ts || new Date(),
    });

    return docUpdate.save();
  }

  public async getUpdatesSince(roomId: string, sinceSeq: number): Promise<IDocUpdate[]> {
    return DocUpdateModel.find({
      roomId,
      seq: { $gt: sinceSeq },
    })
      .sort({ seq: 1 })
      .exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await DocUpdateModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const docUpdateRepo = new DocUpdateRepo();
