import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { roomRepo } from "../../repos/roomRepo.js";
import { RoomModel } from "../../models/rooms.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { DocSnapshotModel } from "../../models/doc_snapshots.js";
import { MessageModel } from "../../models/messages.js";
import { EventModel } from "../../models/events.js";
import { RoomMemberModel } from "../../models/room_members.js";

describe("Room Model & Repository (PRD ROOM-1, ROOM-2, ROOM-6, PER-2)", () => {
  beforeAll(async () => {
    await setupTestDb("rooms");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("rooms: generates slug with crypto.randomBytes(16) base64url matching >= 128-bit length and url-safe charset", () => {
    const slug = roomRepo.generateSlug();
    // 16 bytes encoded in base64url = 22 characters
    expect(slug.length).toBeGreaterThanOrEqual(22);
    // Strict URL-safe base64url character set: alphanumeric, underscore, hyphen. No '+', '/', or '='
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(slug).not.toContain("+");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("=");
  });

  it("rooms: verifies 10,000 consecutively generated slugs produce zero collisions and strictly match /^[A-Za-z0-9_-]+$/", () => {
    const total = 10000;
    const slugs = new Set<string>();
    const urlSafeRegex = /^[A-Za-z0-9_-]+$/;

    for (let i = 0; i < total; i++) {
      const slug = roomRepo.generateSlug();
      expect(urlSafeRegex.test(slug)).toBe(true);
      slugs.add(slug);
    }

    // Zero collisions: Set size must equal total iterations
    expect(slugs.size).toBe(total);
  });

  it("rooms: rejects creating a room with a duplicate slug", async () => {
    const fixedSlug = "duplicate-slug-test-123456";
    await roomRepo.createRoom({
      title: "Room 1",
      ownerId: "owner-1",
      slug: fixedSlug,
    });

    const duplicateRoom = new RoomModel({
      title: "Room 2",
      ownerId: "owner-2",
      slug: fixedSlug,
    });

    await expect(duplicateRoom.save()).rejects.toThrow(/E11000 duplicate key error/);
  });

  it("rooms: lists rooms by owner sorted newest first", async () => {
    const ownerId = "owner-multitask";
    const r1 = await roomRepo.createRoom({
      title: "First Room",
      ownerId,
    });

    // Small delay to ensure distinct creation timestamp
    await new Promise((r) => setTimeout(r, 10));

    const r2 = await roomRepo.createRoom({
      title: "Second Room",
      ownerId,
    });

    const rooms = await RoomModel.find({ ownerId }).sort({ createdAt: -1 }).exec();
    expect(rooms.length).toBe(2);
    expect(rooms[0]?._id.toString()).toBe(r2._id.toString());
    expect(rooms[1]?._id.toString()).toBe(r1._id.toString());
  });

  it("rooms: cascades deletion to doc_updates, doc_snapshots, messages, events, and room_members", async () => {
    const room = await roomRepo.createRoom({
      title: "Room to Delete",
      ownerId: "owner-del",
    });
    const roomId = room._id.toString();

    // Create associated records
    await DocUpdateModel.create({
      roomId,
      seq: 1,
      authorId: "user-1",
      update: Buffer.from([1, 2, 3]),
      size: 3,
    });
    await DocSnapshotModel.create({
      roomId,
      seq: 1,
      text: "console.log('test')",
    });
    await MessageModel.create({
      roomId,
      authorId: "user-1",
      text: "hello",
    });
    await EventModel.create({
      roomId,
      userId: "user-1",
      type: "join",
    });
    await RoomMemberModel.create({
      roomId,
      memberId: "user-1",
      displayName: "User 1",
      role: "owner",
    });

    // Delete room via repo
    const deleted = await roomRepo.deleteRoom(roomId);
    expect(deleted).toBe(true);

    // Verify cascaded deletion
    expect(await DocUpdateModel.countDocuments({ roomId })).toBe(0);
    expect(await DocSnapshotModel.countDocuments({ roomId })).toBe(0);
    expect(await MessageModel.countDocuments({ roomId })).toBe(0);
    expect(await EventModel.countDocuments({ roomId })).toBe(0);
    expect(await RoomMemberModel.countDocuments({ roomId })).toBe(0);
  });
});
