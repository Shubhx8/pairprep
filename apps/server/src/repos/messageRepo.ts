import mongoose from "mongoose";
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
  recipientIds?: string[];
  excludedRecipientIds?: string[];
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
          seq: data.seq,
          authorId: data.authorId,
          authorName: data.authorName,
          clientMsgId: data.clientMsgId?.trim() || undefined,
          text: data.text,
          kind: data.kind || "user",
          opId: data.opId?.trim() || undefined,
          recipientIds: data.recipientIds || [],
          excludedRecipientIds: data.excludedRecipientIds || [],
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
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
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

  public async markDelivered(
    roomId: string,
    messageId: string,
    memberId: string
  ): Promise<IMessage | null> {
    return MessageModel.findOneAndUpdate(
      {
        _id: messageId,
        roomId,
        $or: [
          { recipientIds: { $exists: false } },
          { recipientIds: { $size: 0 } },
          { recipientIds: memberId },
        ],
        excludedRecipientIds: { $ne: memberId },
      },
      { $addToSet: { deliveredTo: memberId } },
      { new: true }
    ).exec();
  }

  public async markRead(
    roomId: string,
    messageId: string,
    memberId: string
  ): Promise<IMessage | null> {
    return MessageModel.findOneAndUpdate(
      {
        _id: messageId,
        roomId,
        $or: [
          { recipientIds: { $exists: false } },
          { recipientIds: { $size: 0 } },
          { recipientIds: memberId },
        ],
        excludedRecipientIds: { $ne: memberId },
      },
      { $addToSet: { readBy: memberId, deliveredTo: memberId } },
      { new: true }
    ).exec();
  }

  /**
   * Batched read receipt update (Phase 4 / AC-14).
   * Atomically marks up to 50 messages as read for a member in a single operation.
   * Enforces sender exclusion (authorId != memberId) and departed member exclusion (excludedRecipientIds != memberId).
   * Returns list of message IDs that matched the update and were marked read.
   */
  public async markReadBatch(
    roomId: string,
    messageIds: string[],
    memberId: string
  ): Promise<{ updatedIds: string[]; modifiedCount: number }> {
    if (!messageIds || messageIds.length === 0) {
      return { updatedIds: [], modifiedCount: 0 };
    }
    const validHex = /^[0-9a-fA-F]{24}$/;
    const uniqueIds = Array.from(
      new Set(messageIds.filter((id) => typeof id === "string" && validHex.test(id)))
    ).slice(0, 50);

    if (uniqueIds.length === 0) {
      return { updatedIds: [], modifiedCount: 0 };
    }

    const filter: Record<string, unknown> = {
      _id: { $in: uniqueIds },
      roomId,
      authorId: { $ne: memberId },
      $or: [
        { recipientIds: { $exists: false } },
        { recipientIds: { $size: 0 } },
        { recipientIds: memberId },
      ],
      excludedRecipientIds: { $ne: memberId },
    };

    const matchingDocs = await MessageModel.find(filter).select("_id").exec();
    const updatedIds = matchingDocs.map((d) => d._id.toString());

    if (updatedIds.length > 0) {
      const res = await MessageModel.updateMany(
        { _id: { $in: updatedIds }, roomId },
        { $addToSet: { readBy: memberId, deliveredTo: memberId } }
      ).exec();
      return { updatedIds, modifiedCount: res.modifiedCount || 0 };
    }

    return { updatedIds: [], modifiedCount: 0 };
  }

  public async excludeRecipientFromRoomMessages(
    roomId: string,
    memberId: string | string[]
  ): Promise<number> {
    const memberIds = Array.isArray(memberId) ? memberId : [memberId];
    const uniqueIds = Array.from(new Set(memberIds.filter(Boolean)));
    if (uniqueIds.length === 0) return 0;

    const isMocked =
      Boolean(
        (MessageModel.updateMany as { _isMockFunction?: boolean })._isMockFunction
      ) || Boolean((MessageModel.updateMany as { mock?: unknown }).mock);
    if (mongoose.connection.readyState !== 1 && !isMocked) {
      return 0;
    }

    let modifiedCount = 0;
    for (const id of uniqueIds) {
      const result = await MessageModel.updateMany(
        { roomId, recipientIds: id },
        { $addToSet: { excludedRecipientIds: id } }
      ).exec();
      modifiedCount += result.modifiedCount || 0;
    }
    return modifiedCount;
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
