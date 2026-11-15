import { MessageModel, IMessage } from "../models/messages.js";
import { roomMutationBarrier } from "../events/roomMutationBarrier.js";

export interface CreateMessageInput {
  roomId: string;
  seq?: number;
  authorId: string;
  authorName?: string;
  clientMsgId?: string;
  text: string;
  kind?: "user" | "system";
  opId?: string;
  ts?: Date;
}

export interface GetMessagesOptions {
  limit?: number;
  beforeSeq?: number;
  afterSeq?: number;
}

export interface GetMessagesResult {
  messages: IMessage[];
  hasMore: boolean;
  nextCursor?: number;
  oldestSeq?: number;
  newestSeq?: number;
}

export class MessageRepo {
  public async createMessage(data: CreateMessageInput): Promise<IMessage> {
    return roomMutationBarrier.withAdmission(data.roomId, async () => {
      if (data.text.length > 1000) {
        throw new Error("Message text cannot exceed 1000 characters");
      }

      try {
        const message = new MessageModel({
          roomId: data.roomId,
          seq: data.seq ?? 1,
          authorId: data.authorId,
          authorName: data.authorName,
          clientMsgId: data.clientMsgId?.trim() || undefined,
          text: data.text,
          kind: data.kind || "user",
          opId: data.opId?.trim() || undefined,
          ts: data.ts || new Date(),
        });

        return await message.save();
      } catch (err: unknown) {
        // Handle MongoDB E11000 Duplicate Key errors for idempotency
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: number }).code === 11000
        ) {
          const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;

          // 1. Client message idempotency (roomId, authorId, clientMsgId)
          if (keyPattern && keyPattern["clientMsgId"] && data.clientMsgId) {
            const existing = await MessageModel.findOne({
              roomId: data.roomId,
              authorId: data.authorId,
              clientMsgId: data.clientMsgId.trim(),
            }).exec();
            if (existing) return existing;
          }

          // 2. Outbox system message idempotency (roomId, opId)
          if (keyPattern && keyPattern["opId"] && data.opId) {
            const existing = await MessageModel.findOne({
              roomId: data.roomId,
              opId: data.opId.trim(),
            }).exec();
            if (existing) return existing;
          }
        }

        throw err;
      }
    });
  }

  /**
   * PRD CH-2: A user who joins late or reloads sees the last 200 messages
   */
  public async getRecentMessages(roomId: string, limit = 200): Promise<IMessage[]> {
    return MessageModel.find({ roomId }).sort({ seq: 1 }).limit(limit).exec();
  }

  /**
   * Paginated message history retrieval.
   * - Default page size: 50; max: 100.
   * - beforeSeq: Fetch messages with seq < beforeSeq (for backward history pagination).
   *   Sorted descending in DB ({ seq: -1 }) then reversed to return ascending order.
   * - afterSeq: Fetch messages with seq > afterSeq (for forward gap-fill).
   *   Sorted ascending in DB ({ seq: 1 }).
   */
  public async getMessages(
    roomId: string,
    options: GetMessagesOptions = {}
  ): Promise<GetMessagesResult> {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
    const filter: Record<string, unknown> = { roomId };

    if (options.beforeSeq !== undefined && options.afterSeq !== undefined) {
      filter["seq"] = { $gt: options.afterSeq, $lt: options.beforeSeq };
    } else if (options.beforeSeq !== undefined) {
      filter["seq"] = { $lt: options.beforeSeq };
    } else if (options.afterSeq !== undefined) {
      filter["seq"] = { $gt: options.afterSeq };
    }

    // Query limit + 1 to detect hasMore
    let messages: IMessage[];
    if (options.afterSeq !== undefined && options.beforeSeq === undefined) {
      // Forward fetch
      const docs = await MessageModel.find(filter)
        .sort({ seq: 1 })
        .limit(limit + 1)
        .exec();

      const hasMore = docs.length > limit;
      messages = hasMore ? docs.slice(0, limit) : docs;
      const newestSeq =
        messages.length > 0 ? messages[messages.length - 1]!.seq : undefined;
      const oldestSeq = messages.length > 0 ? messages[0]!.seq : undefined;

      return {
        messages,
        hasMore,
        nextCursor: newestSeq,
        oldestSeq,
        newestSeq,
      };
    } else {
      // Backward fetch (default): newest first, reversed to ascending
      const docs = await MessageModel.find(filter)
        .sort({ seq: -1 })
        .limit(limit + 1)
        .exec();

      const hasMore = docs.length > limit;
      const trimmed = hasMore ? docs.slice(0, limit) : docs;
      // Reverse to return ascending chronological order
      messages = trimmed.reverse();

      const oldestSeq = messages.length > 0 ? messages[0]!.seq : undefined;
      const newestSeq =
        messages.length > 0 ? messages[messages.length - 1]!.seq : undefined;

      return {
        messages,
        hasMore,
        nextCursor: oldestSeq,
        oldestSeq,
        newestSeq,
      };
    }
  }

  public async deleteMessagesBeforeSeq(
    roomId: string,
    seqCutoff: number
  ): Promise<number> {
    const result = await MessageModel.deleteMany({
      roomId,
      seq: { $lte: seqCutoff },
    }).exec();
    return result.deletedCount || 0;
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await MessageModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const messageRepo = new MessageRepo();
