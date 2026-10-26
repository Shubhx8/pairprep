import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { roomMemberRepo, RoomFullError } from "../../repos/roomMemberRepo.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { RoomModel } from "../../models/rooms.js";

describe("RoomMember Model & Repository (PRD ROOM-3, ROOM-4, ROOM-5)", () => {
  beforeAll(async () => {
    await setupTestDb("room_members");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("room_members: schema does not contain color field", () => {
    const paths = Object.keys(RoomMemberModel.schema.paths);
    expect(paths).not.toContain("color");
  });

  it("room_members: rejects adding the same memberId twice to the same room", async () => {
    const room = await RoomModel.create({
      title: "Dup Member Room",
      ownerId: "owner-1",
      slug: "dup-member-slug",
      memberCount: 1,
      status: "open",
    });
    const roomId = room.id;
    const memberId = "member-unique-1";

    await roomMemberRepo.addMember({
      roomId,
      memberId,
      displayName: "First Join",
      role: "owner",
    });

    // Directly attempting to insert a duplicate in Mongoose model must trigger duplicate key error
    const duplicateDoc = new RoomMemberModel({
      roomId,
      memberId,
      displayName: "Duplicate Join",
      role: "viewer",
    });

    await expect(duplicateDoc.save()).rejects.toThrow(/E11000 duplicate key error/);
  });

  it("room_members: allows up to 6 members and rejects the 7th with ROOM_FULL error", async () => {
    const room = await RoomModel.create({
      title: "Cap 6 Room",
      ownerId: "member-1",
      slug: "cap-6-slug",
      memberCount: 1,
      status: "open",
    });
    const roomId = room.id;

    // Add 6 distinct members successfully
    for (let i = 1; i <= 6; i++) {
      const member = await roomMemberRepo.addMember({
        roomId,
        memberId: `member-${i}`,
        displayName: `Participant ${i}`,
        role: i === 1 ? "owner" : "editor",
      });
      expect(member).toBeDefined();
    }

    const currentCount = await RoomMemberModel.countDocuments({ roomId });
    expect(currentCount).toBe(6);

    // Attempting to add the 7th member must throw RoomFullError with code ROOM_FULL
    await expect(
      roomMemberRepo.addMember({
        roomId,
        memberId: "member-7",
        displayName: "Participant 7",
        role: "viewer",
      })
    ).rejects.toThrowError(RoomFullError);
  });

  it("room_members: updates existing member lastSeenAt when re-joining", async () => {
    const room = await RoomModel.create({
      title: "Rejoin Room",
      ownerId: "owner-1",
      slug: "rejoin-slug",
      memberCount: 1,
      status: "open",
    });
    const roomId = room.id;
    const memberId = "member-rejoin-1";

    const initial = await roomMemberRepo.addMember({
      roomId,
      memberId,
      displayName: "Original Name",
      role: "editor",
    });

    // Short pause
    await new Promise((r) => setTimeout(r, 10));

    const rejoined = await roomMemberRepo.addMember({
      roomId,
      memberId,
      displayName: "Original Name",
      role: "editor",
    });

    expect(rejoined._id.toString()).toBe(initial._id.toString());
    expect(rejoined.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      initial.lastSeenAt.getTime()
    );
  });
});
