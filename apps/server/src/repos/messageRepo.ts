import { MessageModel, IMessage } from "../models/messages.js";

export class MessageRepo {
  public async createMessage(data: {
    roomId: string;
    authorId: string;
    text: string;
    kind?: "user" | "system";
  }): Promise<IMessage> {
    if (data.text.length > 1000) {
      throw new Error("Message text cannot exceed 1000 characters");
    }

    const message = new MessageModel({
      roomId: data.roomId,
      authorId: data.authorId,
      text: data.text,
      kind: data.kind || "user",
      ts: new Date(),
    });

    return message.save();
  }

  /**
   * PRD CH-2: A user who joins late or reloads sees the last 200 messages
   */
  public async getRecentMessages(roomId: string, limit = 200): Promise<IMessage[]> {
    return MessageModel.find({ roomId }).sort({ ts: 1 }).limit(limit).exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await MessageModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const messageRepo = new MessageRepo();
