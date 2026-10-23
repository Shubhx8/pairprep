import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { messageRepo } from "../../repos/messageRepo.js";
import { MessageModel } from "../../models/messages.js";

describe("Message Model & Repository (PRD CH-1, CH-2 & Section 12)", () => {
  beforeAll(async () => {
    await setupTestDb("messages");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("messages: allows 1,000 character messages and rejects text exceeding 1,000 characters", async () => {
    const roomId = "room-chat-len";
    const text1000 = "a".repeat(1000);

    const msg = await messageRepo.createMessage({
      roomId,
      authorId: "user-1",
      text: text1000,
    });
    expect(msg).toBeDefined();
    expect(msg.text.length).toBe(1000);

    const text1001 = "b".repeat(1001);
    await expect(
      messageRepo.createMessage({
        roomId,
        authorId: "user-1",
        text: text1001,
      })
    ).rejects.toThrow(/Message text cannot exceed 1000 characters/);

    // Also assert schema validation rejects 1001 directly on model
    const directDoc = new MessageModel({
      roomId,
      authorId: "user-1",
      text: text1001,
    });
    await expect(directDoc.save()).rejects.toThrow();
  });

  it("messages: getRecentMessages fetches up to limit sorted by timestamp", async () => {
    const roomId = "room-chat-history";

    for (let i = 1; i <= 5; i++) {
      await messageRepo.createMessage({
        roomId,
        authorId: `user-${i}`,
        text: `Message ${i}`,
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const messages = await messageRepo.getRecentMessages(roomId, 3);
    expect(messages.length).toBe(3);
    expect(messages[0]?.text).toBe("Message 1");
    expect(messages[2]?.text).toBe("Message 3");
  });
});
