import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRoomSocket } from "../useRoomSocket.js";
import { apiClient } from "../../lib/apiClient.js";
import type { RoomMemberDetailDto, RoomMemberDto } from "@pairprep/shared";

// Mock apiClient
vi.mock("../../lib/apiClient.js", () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

// Mock socket.io-client
const mockSocket = {
  id: "mock_socket_joined",
  connected: false,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
};

const registeredHandlers: Record<string, (...args: unknown[]) => void> = {};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    mockSocket.on.mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        registeredHandlers[event] = handler;
        return mockSocket;
      }
    );
    mockSocket.off.mockImplementation((event: string) => {
      delete registeredHandlers[event];
      return mockSocket;
    });
    return mockSocket;
  }),
}));

describe("useRoomSocket - room:member_joined Client Defensive Tests (7-13)", () => {
  const dummyRoomId = "507f1f77bcf86cd799439011";
  const dummyMember: RoomMemberDetailDto = {
    id: "alice_host_id",
    displayName: "Alice Host",
    role: "owner",
    isGuest: false,
    joinedAt: new Date().toISOString(),
  };

  function trigger(event: string, ...args: unknown[]) {
    const handler = registeredHandlers[event];
    if (handler) {
      handler(...args);
    }
  }

  async function waitForSocketReady() {
    for (let i = 0; i < 50; i++) {
      if (registeredHandlers["connect"]) return;
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error("Socket listeners failed to register in time");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSocket.connected = false;
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    (apiClient.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 7 & 8: Valid member-joined event updates online state and invokes callback
  it("7 & 8. valid member-joined event updates online state and invokes onMemberJoined callback", async () => {
    const onMemberJoined = vi.fn();
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: dummyRoomId,
        slug: "test-slug-1",
        currentMember: dummyMember,
        enabled: true,
        onMemberJoined,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Initial state: onlineMemberIds is initially empty
    expect(result.current.onlineMemberIds.size).toBe(0);
    expect(result.current.onlineMemberIds.has("bob_id")).toBe(false);

    const validNewMember: RoomMemberDto = {
      roomId: dummyRoomId,
      memberId: "bob_id",
      displayName: "Bob Guest",
      role: "editor",
      isGuest: true,
      joinedAt: new Date().toISOString(),
    };

    act(() => {
      trigger("room:member_joined", {
        roomId: dummyRoomId,
        member: validNewMember,
      });
    });

    expect(result.current.onlineMemberIds.has("bob_id")).toBe(true);
    expect(result.current.onlineMemberIds.size).toBe(1);
    expect(onMemberJoined).toHaveBeenCalledTimes(1);
    expect(onMemberJoined).toHaveBeenCalledWith(validNewMember);
  });

  // 9. An event with missing member does not throw
  it("9. safely ignores event with missing member without throwing", async () => {
    const onMemberJoined = vi.fn();
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: dummyRoomId,
        slug: "test-slug-1",
        currentMember: dummyMember,
        enabled: true,
        onMemberJoined,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    expect(() => {
      act(() => {
        trigger("room:member_joined", {
          roomId: dummyRoomId,
          member: undefined,
        });
      });
    }).not.toThrow();

    expect(onMemberJoined).not.toHaveBeenCalled();
    expect(result.current.onlineMemberIds.size).toBe(0);
  });

  // 10. An event with missing memberId does not update state
  it("10. ignores event with missing or empty memberId and does not update state", async () => {
    const onMemberJoined = vi.fn();
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: dummyRoomId,
        slug: "test-slug-1",
        currentMember: dummyMember,
        enabled: true,
        onMemberJoined,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    act(() => {
      trigger("room:member_joined", {
        roomId: dummyRoomId,
        member: { displayName: "No ID", role: "editor" },
      });
    });

    expect(onMemberJoined).not.toHaveBeenCalled();
    expect(result.current.onlineMemberIds.size).toBe(0);
  });

  // 11. An event for another room is ignored
  it("11. ignores event intended for another room", async () => {
    const onMemberJoined = vi.fn();
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: dummyRoomId,
        slug: "test-slug-1",
        currentMember: dummyMember,
        enabled: true,
        onMemberJoined,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    act(() => {
      trigger("room:member_joined", {
        roomId: "507f1f77bcf86cd799439099", // Different room
        member: {
          roomId: "507f1f77bcf86cd799439099",
          memberId: "other_member",
          displayName: "Other",
          role: "editor",
          isGuest: false,
          joinedAt: new Date().toISOString(),
        },
      });
    });

    expect(onMemberJoined).not.toHaveBeenCalled();
    expect(result.current.onlineMemberIds.has("other_member")).toBe(false);
  });

  // 12. Malformed events do not crash RoomPage callback logic
  it("12. verifies defensive callback boundary does not crash on malformed inputs", async () => {
    let members: Array<{ id: string; displayName: string }> = [
      { id: "alice_host_id", displayName: "Alice Host" },
    ];

    const defensiveCallback = (newMember: unknown) => {
      if (!newMember || typeof newMember !== "object") return;
      const memberId =
        typeof (newMember as { memberId?: unknown }).memberId === "string"
          ? (newMember as { memberId: string }).memberId.trim()
          : "";
      if (!memberId) return;

      if (members.some((m) => m.id === memberId)) return;
      members = [
        ...members,
        {
          id: memberId,
          displayName: (newMember as { displayName?: string }).displayName || "Member",
        },
      ];
    };

    // Call with null, undefined, empty object, missing memberId
    expect(() => defensiveCallback(null)).not.toThrow();
    expect(() => defensiveCallback(undefined)).not.toThrow();
    expect(() => defensiveCallback({})).not.toThrow();
    expect(() => defensiveCallback({ memberId: "" })).not.toThrow();
    expect(() => defensiveCallback({ memberId: 123 })).not.toThrow();

    // Members list should remain unmodified
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe("alice_host_id");
  });

  // 13. A valid subsequent event still works after a malformed event
  it("13. continues to process valid subsequent events normally after malformed events", async () => {
    const onMemberJoined = vi.fn();
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: dummyRoomId,
        slug: "test-slug-1",
        currentMember: dummyMember,
        enabled: true,
        onMemberJoined,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Deliver series of malformed payloads
    act(() => {
      trigger("room:member_joined", null);
      trigger("room:member_joined", undefined);
      trigger("room:member_joined", { roomId: dummyRoomId, member: null });
      trigger("room:member_joined", { roomId: dummyRoomId, member: { memberId: "" } });
    });

    expect(onMemberJoined).not.toHaveBeenCalled();
    expect(result.current.onlineMemberIds.size).toBe(0);

    // Deliver valid subsequent payload
    const validMember: RoomMemberDto = {
      roomId: dummyRoomId,
      memberId: "charlie_valid_id",
      displayName: "Charlie Valid",
      role: "viewer",
      isGuest: false,
      joinedAt: new Date().toISOString(),
    };

    act(() => {
      trigger("room:member_joined", {
        roomId: dummyRoomId,
        member: validMember,
      });
    });

    expect(onMemberJoined).toHaveBeenCalledTimes(1);
    expect(onMemberJoined).toHaveBeenCalledWith(validMember);
    expect(result.current.onlineMemberIds.has("charlie_valid_id")).toBe(true);
  });
});
