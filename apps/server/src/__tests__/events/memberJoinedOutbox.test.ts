import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { outboxService } from "../../events/outboxService.js";
import { DurableOperationModel } from "../../models/durable_operations.js";
import { roomMemberRepo } from "../../repos/roomMemberRepo.js";
import { RoomMemberJoinedPayloadSchema } from "@pairprep/shared";
import type { Server } from "socket.io";
import type { IRoomMember } from "../../models/room_members.js";

describe("OutboxService - room:member_joined Payload Normalization & Safety", () => {
  const dummyRoomId = "507f1f77bcf86cd799439011";
  const dummyMemberId = "user_12345";
  let emittedEvents: Array<{ channel: string; event: string; payload: unknown }> = [];

  const mockIo = {
    to: vi.fn((channel: string) => ({
      emit: vi.fn((event: string, payload: unknown) => {
        emittedEvents.push({ channel, event, payload });
      }),
    })),
  } as unknown as Server;

  beforeEach(() => {
    vi.restoreAllMocks();
    emittedEvents = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. A valid nested member payload produces the correct event
  it("1. broadcasts valid event when op.payload contains a valid nested member", async () => {
    const validMember = {
      roomId: dummyRoomId,
      memberId: dummyMemberId,
      displayName: "Alice Nested",
      role: "editor" as const,
      isGuest: false,
      joinedAt: new Date().toISOString(),
    };

    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_nested_1",
        type: "join",
        roomId: dummyRoomId,
        status: "applied",
        payload: {
          member: validMember,
        },
      }),
    } as never);

    vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    await outboxService.publishBroadcast(mockIo, "op_nested_1");

    expect(emittedEvents).toHaveLength(1);
    const event = emittedEvents[0]!;
    expect(event.channel).toBe(`room:${dummyRoomId}`);
    expect(event.event).toBe("room:member_joined");
    const payload = event.payload as { roomId: string; member: unknown };
    expect(payload.roomId).toBe(dummyRoomId);
    expect(payload.member).toEqual(validMember);
    expect(RoomMemberJoinedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  // 2. The existing flat payload is normalized using authoritative data
  it("2. normalizes existing flat payload by fetching authoritative member from roomMemberRepo", async () => {
    const authoritativeMember = {
      roomId: dummyRoomId,
      memberId: dummyMemberId,
      displayName: "Bob Authoritative",
      role: "editor" as const,
      isGuest: true,
      joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-01T00:05:00.000Z"),
    } as unknown as IRoomMember;

    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_flat_2",
        type: "join",
        roomId: dummyRoomId,
        status: "applied",
        payload: {
          memberId: dummyMemberId,
          displayName: "Bob Flat",
          role: "editor",
        },
      }),
    } as never);

    vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue(authoritativeMember);
    vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    await outboxService.publishBroadcast(mockIo, "op_flat_2");

    expect(roomMemberRepo.findMember).toHaveBeenCalledWith(dummyRoomId, dummyMemberId);
    expect(emittedEvents).toHaveLength(1);
    const event = emittedEvents[0]!;
    expect(event.event).toBe("room:member_joined");
    const parsed = RoomMemberJoinedPayloadSchema.safeParse(event.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.member.displayName).toBe("Bob Authoritative");
      expect(parsed.data.member.isGuest).toBe(true);
      expect(parsed.data.member.memberId).toBe(dummyMemberId);
      expect(parsed.data.member.joinedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  // 3. Legacy persisted operation payloads are handled safely
  it("3. handles legacy persisted operation payload safely without crashing", async () => {
    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_legacy_3",
        type: "join",
        roomId: dummyRoomId,
        status: "persisted",
        payload: {
          // Legacy payload without member object or memberId
          someOldKey: 123,
        },
      }),
    } as never);

    vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue(null);
    vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    // Should not throw
    await expect(
      outboxService.publishBroadcast(mockIo, "op_legacy_3")
    ).resolves.not.toThrow();
    // Malformed broadcast suppressed
    expect(emittedEvents).toHaveLength(0);
  });

  // 4. Missing required member data never produces an invalid broadcast
  it("4. suppresses broadcast when member data is missing or unrecoverable", async () => {
    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_missing_4",
        type: "join",
        roomId: dummyRoomId,
        status: "applied",
        payload: {
          memberId: "nonexistent_member",
        },
      }),
    } as never);

    vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue(null);
    vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    await outboxService.publishBroadcast(mockIo, "op_missing_4");
    expect(emittedEvents).toHaveLength(0);
  });

  // 5. The emitted event passes RoomMemberJoinedPayloadSchema
  it("5. strictly adheres to RoomMemberJoinedPayloadSchema for broadcast event", async () => {
    const authoritativeMember = {
      roomId: dummyRoomId,
      memberId: "charlie_99",
      displayName: "Charlie",
      role: "viewer" as const,
      isGuest: false,
      joinedAt: new Date(),
    } as unknown as IRoomMember;

    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_schema_5",
        type: "join",
        roomId: dummyRoomId,
        status: "applied",
        payload: {
          memberId: "charlie_99",
          displayName: "Charlie",
          role: "viewer",
        },
      }),
    } as never);

    vi.spyOn(roomMemberRepo, "findMember").mockResolvedValue(authoritativeMember);
    vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    await outboxService.publishBroadcast(mockIo, "op_schema_5");
    expect(emittedEvents).toHaveLength(1);
    const result = RoomMemberJoinedPayloadSchema.safeParse(emittedEvents[0]!.payload);
    expect(result.success).toBe(true);
  });

  // 6. Existing outbox retry and idempotency behavior remains intact
  it("6. preserves transitionStatus CAS call to advance status to published", async () => {
    vi.spyOn(DurableOperationModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        opId: "op_cas_6",
        type: "join",
        roomId: dummyRoomId,
        status: "applied",
        payload: {
          member: {
            roomId: dummyRoomId,
            memberId: dummyMemberId,
            displayName: "CAS Tester",
            role: "editor",
            isGuest: false,
            joinedAt: new Date().toISOString(),
          },
        },
      }),
    } as never);

    const transitionSpy = vi.spyOn(outboxService, "transitionStatus").mockResolvedValue({
      modified: true,
      doc: null,
    } as never);

    await outboxService.publishBroadcast(mockIo, "op_cas_6");

    expect(transitionSpy).toHaveBeenCalledWith(
      "op_cas_6",
      ["persisted", "applied"],
      "published"
    );
  });
});
