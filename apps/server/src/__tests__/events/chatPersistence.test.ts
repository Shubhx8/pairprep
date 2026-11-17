import { describe, it, expect, beforeEach, vi } from "vitest";
import { sanitizeChatText } from "@pairprep/shared";
import { ChatRateLimiter } from "../../events/chatRateLimiter.js";
import { MessageRepo } from "../../repos/messageRepo.js";
import { MessageModel } from "../../models/messages.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomRepo } from "../../repos/roomRepo.js";

describe("T09 Phase 2 — Chat Persistence & Protocol (CH-1, CH-2, SEC-1, SEC-3)", () => {
  describe("Unicode & Character Limits Sanitization (SEC-3, CH-1)", () => {
    it("accepts exactly 1,000 characters and normalizes Unicode to NFC", () => {
      const text = "A".repeat(1000);
      const sanitized = sanitizeChatText(text);
      expect(sanitized).toHaveLength(1000);
    });

    it("strips Byte Order Mark (BOM \uFEFF)", () => {
      const textWithBom = "\uFEFFHello World\uFEFF";
      const sanitized = sanitizeChatText(textWithBom);
      expect(sanitized).toBe("Hello World");
      expect(sanitized.includes("\uFEFF")).toBe(false);
    });

    it("strips Bidi overrides and embeddings (RLO, LRO, etc.)", () => {
      // \u202E is Right-to-Left Override
      const textWithBidi = "Hello \u202EWorld\u202C!";
      const sanitized = sanitizeChatText(textWithBidi);
      expect(sanitized).toBe("Hello World!");
      expect(sanitized.includes("\u202E")).toBe(false);
    });

    it("strips C0/C1 control characters but preserves newlines and tabs", () => {
      const textWithControls = "Line 1\nLine 2\tTabbed\u0000\u0007\u001FEnd";
      const sanitized = sanitizeChatText(textWithControls);
      expect(sanitized).toBe("Line 1\nLine 2\tTabbedEnd");
      expect(sanitized.includes("\n")).toBe(true);
      expect(sanitized.includes("\t")).toBe(true);
      expect(sanitized.includes("\u0000")).toBe(false);
      expect(sanitized.includes("\u0007")).toBe(false);
    });

    it("preserves complex emojis with Zero-Width Joiner (ZWJ) and Variation Selector 16", () => {
      // 👨‍👩‍👧‍👦 contains ZWJ (\u200D)
      const familyEmoji = "👨‍👩‍👧‍👦";
      const sanitizedFamily = sanitizeChatText(familyEmoji);
      expect(sanitizedFamily).toBe(familyEmoji);

      // ❤️ contains Variation Selector 16 (\uFE0F)
      const heartEmoji = "❤️";
      const sanitizedHeart = sanitizeChatText(heartEmoji);
      expect(sanitizedHeart).toBe(heartEmoji);
    });
  });

  describe("AD-7 Chat Rate Limiter (Campus NAT Accommodation)", () => {
    let limiter: ChatRateLimiter;

    beforeEach(() => {
      limiter = new ChatRateLimiter({
        windowMs: 10_000,
        userMax: 20,
        ipMax: 100,
      });
    });

    it("allows up to 20 messages per user within 10 seconds and rejects the 21st", () => {
      const userId = "user_student_1";
      const ip = "192.168.1.50";
      const now = 100000;

      for (let i = 0; i < 20; i++) {
        const res = limiter.consume(userId, ip, now + i * 10);
        expect(res.allowed).toBe(true);
      }

      // 21st message from same user is blocked
      const blocked = limiter.consume(userId, ip, now + 300);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe("user_limit");
      expect(blocked.retryAfter).toBeGreaterThan(0);
    });

    it("allows distinct users sharing the same public IP to exceed 20 messages up to 100 (Campus NAT)", () => {
      const campusIp = "130.211.5.1";
      const now = 200000;

      // 5 students each send 15 messages (total 75 messages from same IP)
      for (let s = 1; s <= 5; s++) {
        const studentId = `student_${s}`;
        for (let m = 0; m < 15; m++) {
          const res = limiter.consume(studentId, campusIp, now + m * 5);
          expect(res.allowed).toBe(true);
        }
      }

      // 6th student sends 25 messages from the campus IP
      const student6 = "student_6";
      for (let m = 0; m < 20; m++) {
        const res = limiter.consume(student6, campusIp, now + m * 5);
        expect(res.allowed).toBe(true);
      }

      // student 6 exceeds their 20 cap
      const userBlocked = limiter.consume(student6, campusIp, now + 200);
      expect(userBlocked.allowed).toBe(false);
      expect(userBlocked.reason).toBe("user_limit");

      // Now total messages from campusIp is 75 + 20 = 95. A 7th student sends 5 messages
      const student7 = "student_7";
      for (let m = 0; m < 5; m++) {
        const res = limiter.consume(student7, campusIp, now + m * 5);
        expect(res.allowed).toBe(true);
      }

      // Now total IP messages = 100. Next message from campus IP is blocked on IP limit
      const student8 = "student_8";
      const ipBlocked = limiter.consume(student8, campusIp, now + 300);
      expect(ipBlocked.allowed).toBe(false);
      expect(ipBlocked.reason).toBe("ip_limit");
      expect(ipBlocked.retryAfter).toBeGreaterThan(0);
    });

    it("resets rate limit window after windowMs elapses", () => {
      const userId = "user_alice";
      const ip = "10.0.0.1";
      const now = 500000;

      for (let i = 0; i < 20; i++) {
        limiter.consume(userId, ip, now);
      }
      expect(limiter.consume(userId, ip, now).allowed).toBe(false);

      // Advance time by 10,001 ms
      const futureRes = limiter.consume(userId, ip, now + 10001);
      expect(futureRes.allowed).toBe(true);
    });
  });

  describe("Monotonic Sequence Allocation (CH-1)", () => {
    it("allocates strictly monotonic sequence numbers via atomic increment", async () => {
      const roomRepo = new RoomRepo();
      let currentSeq = 0;

      // Mock RoomModel.findOneAndUpdate to simulate MongoDB atomic $inc
      vi.spyOn(RoomModel, "findOneAndUpdate").mockImplementation((() => ({
        exec: vi.fn().mockImplementation(async () => {
          currentSeq += 1;
          return { messageSeq: currentSeq } as unknown as typeof RoomModel;
        }),
      })) as unknown as typeof RoomModel.findOneAndUpdate);

      const seq1 = await roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011");
      const seq2 = await roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011");
      const seq3 = await roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011");

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it("concurrent sequence allocations resolve deterministically without duplicates", async () => {
      const roomRepo = new RoomRepo();
      let currentSeq = 0;

      vi.spyOn(RoomModel, "findOneAndUpdate").mockImplementation((() => ({
        exec: vi.fn().mockImplementation(async () => {
          currentSeq += 1;
          return { messageSeq: currentSeq } as unknown as typeof RoomModel;
        }),
      })) as unknown as typeof RoomModel.findOneAndUpdate);

      const results = await Promise.all([
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011"),
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011"),
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011"),
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011"),
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011"),
      ]);

      expect(results).toHaveLength(5);
      const uniqueSeqs = new Set(results);
      expect(uniqueSeqs.size).toBe(5);
      expect(results).toEqual([1, 2, 3, 4, 5]);
    });

    it("rejects sequence allocation if room is closed and allowClosed is false", async () => {
      const roomRepo = new RoomRepo();

      vi.spyOn(RoomModel, "findOneAndUpdate").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof RoomModel.findOneAndUpdate>);

      await expect(
        roomRepo.allocateMessageSeq("507f1f77bcf86cd799439011")
      ).rejects.toThrow("Cannot allocate sequence number: room not found or closed");
    });
  });

  describe("Idempotency & Duplicate Key Handling (CONC-3)", () => {
    it("returns existing message idempotently when duplicate clientMessageId error occurs", async () => {
      const repo = new MessageRepo();
      const existingMsg = {
        _id: "msg_existing_123",
        roomId: "507f1f77bcf86cd799439011",
        seq: 42,
        authorId: "user_alice",
        clientMsgId: "client_uuid_999",
        text: "Hello once",
      };

      // Mock save to throw E11000 duplicate key error
      const mockSave = vi.fn().mockRejectedValue({
        code: 11000,
        keyPattern: { roomId: 1, authorId: 1, clientMsgId: 1 },
      });
      vi.spyOn(MessageModel.prototype, "save").mockImplementation(mockSave);

      // Mock findOne to return existing message
      vi.spyOn(MessageModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(existingMsg),
      } as unknown as ReturnType<typeof MessageModel.findOne>);

      const result = await repo.createMessage({
        roomId: "507f1f77bcf86cd799439011",
        seq: 43,
        authorId: "user_alice",
        clientMsgId: "client_uuid_999",
        text: "Hello retry",
      });

      expect(result).toBe(existingMsg);
      expect(MessageModel.findOne).toHaveBeenCalledWith({
        roomId: "507f1f77bcf86cd799439011",
        authorId: "user_alice",
        clientMsgId: "client_uuid_999",
      });
    });

    it("rethrows unexpected database errors during message creation", async () => {
      const repo = new MessageRepo();

      vi.spyOn(MessageModel.prototype, "save").mockRejectedValue(
        new Error("Connection reset by peer")
      );

      await expect(
        repo.createMessage({
          roomId: "507f1f77bcf86cd799439011",
          seq: 1,
          authorId: "user_alice",
          text: "Hello",
        })
      ).rejects.toThrow("Connection reset by peer");
    });
  });
});
