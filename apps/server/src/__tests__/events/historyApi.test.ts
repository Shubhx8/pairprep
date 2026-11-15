import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageRepo } from "../../repos/messageRepo.js";
import { MessageModel, type IMessage } from "../../models/messages.js";
import { ChatHistoryQuerySchema, toMessageDto } from "@pairprep/shared";

describe("T09 Phase 2 — History Pagination & Reconnect Hydration (CH-1, CH-2)", () => {
  let messageRepo: MessageRepo;

  beforeEach(() => {
    messageRepo = new MessageRepo();
    vi.restoreAllMocks();
  });

  describe("ChatHistoryQuerySchema Validation", () => {
    it("applies default limit: 50 when limit is omitted", () => {
      const parsed = ChatHistoryQuerySchema.parse({});
      expect(parsed.limit).toBe(50);
      expect(parsed.beforeSeq).toBeUndefined();
      expect(parsed.afterSeq).toBeUndefined();
    });

    it("clamps limit between 1 and 100", () => {
      const valid = ChatHistoryQuerySchema.parse({ limit: "100" });
      expect(valid.limit).toBe(100);

      expect(() => ChatHistoryQuerySchema.parse({ limit: "0" })).toThrow();
      expect(() => ChatHistoryQuerySchema.parse({ limit: "101" })).toThrow();
    });

    it("parses valid beforeSeq and afterSeq integers", () => {
      const parsed = ChatHistoryQuerySchema.parse({
        limit: "50",
        beforeSeq: "150",
        afterSeq: "100",
      });
      expect(parsed.limit).toBe(50);
      expect(parsed.beforeSeq).toBe(150);
      expect(parsed.afterSeq).toBe(100);
    });
  });

  describe("MessageRepo.getMessages Cursor Pagination", () => {
    function generateMockMessages(count: number, startSeq = 1): IMessage[] {
      const msgs: IMessage[] = [];
      for (let i = 0; i < count; i++) {
        const seq = startSeq + i;
        msgs.push({
          _id: `msg_id_${seq}`,
          roomId: "507f1f77bcf86cd799439011",
          authorId: `user_${(i % 3) + 1}`,
          authorName: `User ${(i % 3) + 1}`,
          seq,
          text: `Message seq ${seq}`,
          ts: new Date(1700000000000 + seq * 1000),
          kind: "user",
        } as unknown as IMessage);
      }
      return msgs;
    }

    it("backward pagination returns chronological ascending order with hasMore and nextCursor", async () => {
      // 55 messages total in DB (seq 1 to 55)
      // When querying limit=50 with no cursor, DB sorts descending { seq: -1 } limit=51
      // returns [55, 54, ... 5], slice(0, 50) => [55, 54, ... 6], reversed => [6, 7, ... 55]
      const docsDescending = generateMockMessages(51, 5).reverse(); // seq 55 down to 5

      vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(docsDescending),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const result = await messageRepo.getMessages("507f1f77bcf86cd799439011", {
        limit: 50,
      });

      expect(result.messages).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      // Chronological ascending order
      expect(result.messages[0]?.seq).toBe(6);
      expect(result.messages[49]?.seq).toBe(55);
      expect(result.nextCursor).toBe(6); // Oldest seq in this page
      expect(result.oldestSeq).toBe(6);
      expect(result.newestSeq).toBe(55);
    });

    it("supports forward gap-fill pagination using afterSeq", async () => {
      // Client has messages up to seq 100, requests afterSeq=100
      const docsAscending = generateMockMessages(10, 101); // seq 101 to 110

      vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(docsAscending),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const result = await messageRepo.getMessages("507f1f77bcf86cd799439011", {
        limit: 50,
        afterSeq: 100,
      });

      expect(result.messages).toHaveLength(10);
      expect(result.hasMore).toBe(false);
      expect(result.messages[0]?.seq).toBe(101);
      expect(result.messages[9]?.seq).toBe(110);
    });

    it("two-page reconnect hydration reconstructs up to 200 messages (CH-2)", async () => {
      // Page 1: newest 100 messages (seq 101 to 200)
      const page1DocsDesc = generateMockMessages(101, 100).reverse(); // 200 down to 100 (101 items to trigger hasMore)
      // Page 2: preceding 100 messages (seq 1 to 100)
      const page2DocsDesc = generateMockMessages(100, 1).reverse(); // 100 down to 1 (100 items, hasMore false)

      let callCount = 0;
      vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return page1DocsDesc;
          return page2DocsDesc;
        }),
      } as unknown as ReturnType<typeof MessageModel.find>);

      // Step 1: Client loads Page 1
      const page1 = await messageRepo.getMessages("507f1f77bcf86cd799439011", {
        limit: 100,
      });
      expect(page1.messages).toHaveLength(100);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(101);

      // Step 2: Client loads Page 2 using beforeSeq = page1.nextCursor
      const page2 = await messageRepo.getMessages("507f1f77bcf86cd799439011", {
        limit: 100,
        beforeSeq: page1.nextCursor,
      });
      expect(page2.messages).toHaveLength(100);
      expect(page2.hasMore).toBe(false);

      // Step 3: Client concatenates Page 2 (older) + Page 1 (newer)
      const combined = [...page2.messages, ...page1.messages];
      expect(combined).toHaveLength(200);

      // Verify strict ascending order from seq 1 to 200
      for (let i = 0; i < 200; i++) {
        expect(combined[i]?.seq).toBe(i + 1);
      }
    });

    it("handles sequence gaps without errors or missing-message panics", async () => {
      // Gaps caused by aborted sends or crashes: seq [1, 2, 5, 12, 13]
      const gappedMsgs = [
        { _id: "m1", seq: 1, roomId: "r1", authorId: "a1", text: "1", ts: new Date() },
        { _id: "m2", seq: 2, roomId: "r1", authorId: "a1", text: "2", ts: new Date() },
        { _id: "m3", seq: 5, roomId: "r1", authorId: "a1", text: "5", ts: new Date() },
        { _id: "m4", seq: 12, roomId: "r1", authorId: "a1", text: "12", ts: new Date() },
        { _id: "m5", seq: 13, roomId: "r1", authorId: "a1", text: "13", ts: new Date() },
      ].reverse() as unknown as IMessage[];

      vi.spyOn(MessageModel, "find").mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(gappedMsgs),
      } as unknown as ReturnType<typeof MessageModel.find>);

      const result = await messageRepo.getMessages("r1", { limit: 50 });
      expect(result.messages).toHaveLength(5);
      const seqs = result.messages.map((m) => m.seq);
      expect(seqs).toEqual([1, 2, 5, 12, 13]);

      // Verify toMessageDto converts all messages safely
      const dtos = result.messages.map(toMessageDto);
      expect(dtos).toHaveLength(5);
      expect(dtos[2]?.seq).toBe(5);
    });
  });
});
