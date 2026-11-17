import { describe, it, expect, beforeEach, vi } from "vitest";
import { RoomPresenceTracker } from "../../events/presenceTracker.js";
import type { Socket } from "socket.io";

function createMockSocket(id: string) {
  return {
    id,
    disconnect: vi.fn(),
  } as unknown as Socket;
}

describe("RoomPresenceTracker (Authoritative In-Memory Registry)", () => {
  let tracker: RoomPresenceTracker;

  beforeEach(() => {
    tracker = new RoomPresenceTracker();
  });

  it("registers a socket and detects a 0-to-1 transition (isFirstSocket: true)", () => {
    const socket = createMockSocket("sock_1");
    const result = tracker.registerSocket(socket, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });

    expect(result.transition).toBe("joined");
    expect(result.isFirstSocket).toBe(true);
    expect(result.memberInfo?.displayName).toBe("Alice");
    expect(result.memberInfo?.role).toBe("editor");
    expect(result.memberInfo?.color).toMatch(/^#[0-9a-fA-F]{6}$/);

    expect(tracker.getSocketCountForMember("room_123", "doc_1")).toBe(1);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(1);
  });

  it("handles multi-tab connections without duplicate joined transitions", () => {
    const socket1 = createMockSocket("sock_tab_1");
    const socket2 = createMockSocket("sock_tab_2");

    const res1 = tracker.registerSocket(socket1, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });
    expect(res1.transition).toBe("joined");
    expect(res1.isFirstSocket).toBe(true);

    const res2 = tracker.registerSocket(socket2, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });
    // 2nd tab should NOT trigger a new joined transition
    expect(res2.transition).toBe("none");
    expect(res2.isFirstSocket).toBe(false);

    expect(tracker.getSocketCountForMember("room_123", "doc_1")).toBe(2);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(1);
  });

  it("closing 1 tab while another remains open does NOT trigger an offline transition", () => {
    const socket1 = createMockSocket("sock_tab_1");
    const socket2 = createMockSocket("sock_tab_2");

    tracker.registerSocket(socket1, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });
    tracker.registerSocket(socket2, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });

    // Close 1st tab
    const unreg1 = tracker.unregisterSocket("sock_tab_1");
    expect(unreg1.transition).toBe("none");
    expect(unreg1.isLastSocket).toBe(false);
    expect(tracker.getSocketCountForMember("room_123", "doc_1")).toBe(1);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(1);

    // Close 2nd tab -> 1-to-0 transition
    const unreg2 = tracker.unregisterSocket("sock_tab_2");
    expect(unreg2.transition).toBe("left");
    expect(unreg2.isLastSocket).toBe(true);
    expect(unreg2.memberInfo?.displayName).toBe("Alice");
    expect(tracker.getSocketCountForMember("room_123", "doc_1")).toBe(0);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(0);
  });

  it("returns authoritative presence snapshot for all online room members", () => {
    tracker.registerSocket(createMockSocket("sock_1"), "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "owner",
    });
    tracker.registerSocket(createMockSocket("sock_2"), "room_123", {
      id: "doc_2",
      memberId: "user_2",
      displayName: "Bob",
      role: "viewer",
    });

    const snapshot = tracker.getOnlineMembers("room_123");
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((m) => m.displayName)).toEqual(["Alice", "Bob"]);
    expect(snapshot.every((m) => m.isOnline)).toBe(true);
    expect(snapshot[0]?.memberDocId).toBe("doc_1");
    expect(snapshot[1]?.memberDocId).toBe("doc_2");
  });

  it("disconnectMemberSockets force-closes all sockets belonging to that member", () => {
    const s1 = createMockSocket("s1");
    const s2 = createMockSocket("s2");

    tracker.registerSocket(s1, "room_123", {
      id: "doc_target",
      memberId: "user_target",
      displayName: "Target",
      role: "editor",
    });
    tracker.registerSocket(s2, "room_123", {
      id: "doc_target",
      memberId: "user_target",
      displayName: "Target",
      role: "editor",
    });

    tracker.disconnectMemberSockets("room_123", "doc_target");

    expect(s1.disconnect).toHaveBeenCalledWith(true);
    expect(s2.disconnect).toHaveBeenCalledWith(true);
    expect(tracker.getSocketCountForMember("room_123", "doc_target")).toBe(0);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(0);
  });

  it("disconnectRoomSockets force-closes all sockets in the room", () => {
    const s1 = createMockSocket("s1");
    const s2 = createMockSocket("s2");

    tracker.registerSocket(s1, "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "owner",
    });
    tracker.registerSocket(s2, "room_123", {
      id: "doc_2",
      memberId: "user_2",
      displayName: "Bob",
      role: "viewer",
    });

    tracker.disconnectRoomSockets("room_123");

    // M-1: disconnect(false) allows pending packets to flush
    expect(s1.disconnect).toHaveBeenCalledWith(false);
    expect(s2.disconnect).toHaveBeenCalledWith(false);
    expect(tracker.getOnlineMemberCount("room_123")).toBe(0);
  });

  it("gracefulDisconnectRoomSockets drains sockets with disconnect(false) before cleaning up (M-1)", async () => {
    const s1 = createMockSocket("s1");
    tracker.registerSocket(s1, "room_graceful", {
      id: "doc_1",
      memberId: "u1",
      displayName: "Alice",
      role: "owner",
    });

    await tracker.gracefulDisconnectRoomSockets("room_graceful", 10);
    expect(s1.disconnect).toHaveBeenCalledWith(false);
    expect(tracker.getOnlineMemberCount("room_graceful")).toBe(0);
  });

  it("updates tracked role when updateMemberRole is called", () => {
    tracker.registerSocket(createMockSocket("s1"), "room_123", {
      id: "doc_1",
      memberId: "user_1",
      displayName: "Alice",
      role: "editor",
    });

    tracker.updateMemberRole("doc_1", "viewer");
    const snapshot = tracker.getOnlineMembers("room_123");
    expect(snapshot[0]?.role).toBe("viewer");
  });
});
