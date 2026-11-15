import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRoomSocket } from "../useRoomSocket.js";
import { apiClient } from "../../lib/apiClient.js";
import type { RoomMemberDetailDto } from "@pairprep/shared";

// Mock apiClient
vi.mock("../../lib/apiClient.js", () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

// Mock socket.io-client
const mockSocket = {
  id: "mock_socket_123",
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

describe("useRoomSocket Hook (Vitest Unit & Timing Tests)", () => {
  const dummyMember: RoomMemberDetailDto = {
    id: "member_123",
    displayName: "Alice Tester",
    role: "editor",
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
    Object.keys(registeredHandlers).forEach((key) => delete registeredHandlers[key]);
    mockSocket.connected = false;

    // Default apiClient mock response for history
    (apiClient.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1. connects lazily and emits room:join on mount", async () => {
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();

    // Trigger connect
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    expect(result.current.connectionStatus).toBe("connected");
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "room:join",
      { roomId: "507f1f77bcf86cd799439011" },
      expect.any(Function)
    );
  });

  it("2. dispatches optimistic message with status 'sending' and canonical clientMsgId", async () => {
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    let clientMsgId: string | null = null;
    await act(async () => {
      clientMsgId = await result.current.sendMessage("Hello pair programming!");
    });

    expect(clientMsgId).toBeTruthy();
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]?.status).toBe("sending");
    expect(result.current.messages[0]?.text).toBe("Hello pair programming!");
    expect(result.current.messages[0]?.clientMsgId).toBe(clientMsgId);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "chat:send",
      {
        roomId: "507f1f77bcf86cd799439011",
        text: "Hello pair programming!",
        clientMsgId,
      },
      expect.any(Function)
    );
  });

  it("3. confirms message with status 'sent' on server ack with seq", async () => {
    let capturedAckCallback: ((ack: unknown) => void) | undefined;
    mockSocket.emit.mockImplementation(
      (ev: string, _payload: unknown, ack?: (res: unknown) => void) => {
        if (ev === "chat:send") {
          capturedAckCallback = ack;
        }
      }
    );

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    let clientMsgId: string | null = null;
    await act(async () => {
      clientMsgId = await result.current.sendMessage("Acknowledge me");
    });

    expect(result.current.messages[0]?.status).toBe("sending");

    // Server acks
    act(() => {
      capturedAckCallback?.({
        ok: true,
        data: {
          messageId: "server_msg_999",
          seq: 42,
          ts: new Date().toISOString(),
        },
      });
    });

    expect(result.current.messages[0]?.status).toBe("sent");
    expect(result.current.messages[0]?.seq).toBe(42);
    expect(result.current.messages[0]?.id).toBe("server_msg_999");
    expect(result.current.messages[0]?.clientMsgId).toBe(clientMsgId);
  });

  it("4. transitions optimistic message to 'failed' after 8s ack timeout while preserving clientMsgId", async () => {
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    let clientMsgId: string | null = null;
    await act(async () => {
      clientMsgId = await result.current.sendMessage("Will time out");
    });

    expect(result.current.messages[0]?.status).toBe("sending");

    // Advance timer 7.9 seconds -> still sending
    act(() => {
      vi.advanceTimersByTime(7900);
    });
    expect(result.current.messages[0]?.status).toBe("sending");

    // Advance past 8 seconds -> failed
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.messages[0]?.status).toBe("failed");
    expect(result.current.messages[0]?.clientMsgId).toBe(clientMsgId);
  });

  it("5. deduplicates echo-before-ack: chat:message confirms message in-place and prevents duplicates", async () => {
    let capturedAckCallback: ((ack: unknown) => void) | undefined;
    mockSocket.emit.mockImplementation(
      (ev: string, _payload: unknown, ack?: (res: unknown) => void) => {
        if (ev === "chat:send") {
          capturedAckCallback = ack;
        }
      }
    );

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    let clientMsgId: string | null = null;
    await act(async () => {
      clientMsgId = await result.current.sendMessage("Echo before Ack message");
    });

    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]?.status).toBe("sending");

    // 1. Same-socket chat:message arrives BEFORE ack!
    act(() => {
      trigger("chat:message", {
        roomId: "507f1f77bcf86cd799439011",
        message: {
          id: "server_echo_msg_777",
          roomId: "507f1f77bcf86cd799439011",
          authorId: dummyMember.id,
          authorName: dummyMember.displayName,
          seq: 15,
          clientMsgId,
          text: "Echo before Ack message",
          ts: new Date().toISOString(),
          kind: "user",
        },
      });
    });

    // Confirmed in-place, still exactly 1 message
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]?.status).toBe("sent");
    expect(result.current.messages[0]?.seq).toBe(15);
    expect(result.current.messages[0]?.id).toBe("server_echo_msg_777");

    // 2. Ack arrives later: should not create a duplicate
    act(() => {
      capturedAckCallback?.({
        ok: true,
        data: {
          messageId: "server_echo_msg_777",
          seq: 15,
          ts: new Date().toISOString(),
        },
      });
    });

    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]?.status).toBe("sent");
  });

  it("6. reconnect reconciliation: refetches details and applies missed role changes and ended state", async () => {
    const onRoleChanged = vi.fn();
    const onRoomEnded = vi.fn();
    const onMembersUpdated = vi.fn();

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
        onRoleChanged,
        onRoomEnded,
        onMembersUpdated,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Simulate disconnect
    act(() => {
      mockSocket.connected = false;
      trigger("disconnect", "transport close");
    });
    expect(result.current.connectionStatus).toBe("disconnected");

    // Mock API response for reconnect state check
    (apiClient.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (path: string) => {
        if (path === "/api/v1/rooms/test-slug-123") {
          return Promise.resolve({
            room: { id: "507f1f77bcf86cd799439011", status: "ended" },
            currentMember: { ...dummyMember, role: "viewer" },
            members: [{ ...dummyMember, role: "viewer" }],
          });
        }
        if (path.includes("/messages")) {
          return Promise.resolve({
            messages: [
              {
                id: "msg_offline_1",
                roomId: "507f1f77bcf86cd799439011",
                authorId: "user_other",
                text: "Sent while you were offline",
                seq: 20,
                ts: new Date().toISOString(),
                kind: "user",
              },
            ],
            hasMore: false,
          });
        }
        return Promise.reject(new Error("Unknown route"));
      }
    );

    // Reconnect
    await act(async () => {
      mockSocket.connected = true;
      trigger("connect");
      await Promise.resolve();
    });

    expect(onRoomEnded).toHaveBeenCalledTimes(1);
    expect(onRoleChanged).toHaveBeenCalledWith("viewer");
    expect(onMembersUpdated).toHaveBeenCalled();
    expect(
      result.current.messages.some((m) => m.text === "Sent while you were offline")
    ).toBe(true);
  });

  it("7. reconnect reconciliation: triggers removal and halts socket if user was removed offline", async () => {
    const onMemberRemoved = vi.fn();
    const syncProvider = { disconnect: vi.fn(), destroy: vi.fn() };

    renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
        onMemberRemoved,
        syncProvider,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Simulate disconnect
    act(() => {
      mockSocket.connected = false;
      trigger("disconnect", "ping timeout");
    });

    // Mock response: user was removed while offline (no currentMember returned)
    (apiClient.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (path: string) => {
        if (path === "/api/v1/rooms/test-slug-123") {
          return Promise.resolve({
            room: { id: "507f1f77bcf86cd799439011", status: "open" },
            // currentMember omitted!
          });
        }
        return Promise.resolve({ messages: [] });
      }
    );

    // Reconnect
    await act(async () => {
      mockSocket.connected = true;
      trigger("connect");
      await Promise.resolve();
    });

    expect(onMemberRemoved).toHaveBeenCalledWith(dummyMember.id);
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(syncProvider.disconnect).toHaveBeenCalled();
    expect(syncProvider.destroy).toHaveBeenCalled();
  });

  it("8. fatal errors immediately disconnect and set status to fatal_error without retry", async () => {
    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();

    // Trigger fatal connect error (e.g. 401 Unauthorized handshake rejection)
    act(() => {
      trigger("connect_error", new Error("Unauthorized origin"));
    });

    expect(result.current.connectionStatus).toBe("fatal_error");
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it("9. rate limit countdown in seconds with composer disabled state", async () => {
    let capturedAckCallback: ((ack: unknown) => void) | undefined;
    mockSocket.emit.mockImplementation(
      (ev: string, _payload: unknown, ack?: (res: unknown) => void) => {
        if (ev === "chat:send") {
          capturedAckCallback = ack;
        }
      }
    );

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    await act(async () => {
      await result.current.sendMessage("Rapid chat message");
    });

    // Server returns RATE_LIMITED with retryAfter = 5 seconds
    act(() => {
      capturedAckCallback?.({
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many messages. Please slow down.",
          retryAfter: 5,
        },
      });
    });

    expect(result.current.isRateLimited).toBe(true);
    expect(result.current.rateLimitCountdown).toBe(5);

    // Advance 2 seconds
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.isRateLimited).toBe(true);
    expect(result.current.rateLimitCountdown).toBe(3);

    // Advance 3 more seconds (5 total)
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.isRateLimited).toBe(false);
    expect(result.current.rateLimitCountdown).toBe(0);
  });

  it("10. retryMessage re-emits chat:send using the exact same clientMsgId", async () => {
    const emittedClientIds: string[] = [];
    mockSocket.emit.mockImplementation(
      (ev: string, payload: { clientMsgId?: string }) => {
        if (ev === "chat:send" && payload.clientMsgId) {
          emittedClientIds.push(payload.clientMsgId);
        }
      }
    );

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    let firstClientId: string | null = null;
    await act(async () => {
      firstClientId = await result.current.sendMessage("Failed message to retry");
    });

    // Timeout message
    act(() => {
      vi.advanceTimersByTime(8100);
    });
    expect(result.current.messages[0]?.status).toBe("failed");

    // Retry sending
    await act(async () => {
      if (firstClientId) {
        await result.current.retryMessage(firstClientId);
      }
    });

    expect(emittedClientIds.length).toBe(2);
    expect(emittedClientIds[0]).toBe(firstClientId);
    expect(emittedClientIds[1]).toBe(firstClientId); // EXACT same ID!
    expect(result.current.messages[0]?.status).toBe("sending");
  });

  it("11. ending a room keeps event connections and chat history while disabling new chat sends", async () => {
    const onRoomEnded = vi.fn();
    const syncProvider = { disconnect: vi.fn(), destroy: vi.fn() };

    const { result } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
        onRoomEnded,
        syncProvider,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Add a message
    act(() => {
      trigger("chat:message", {
        roomId: "507f1f77bcf86cd799439011",
        message: {
          id: "msg_ended_room",
          roomId: "507f1f77bcf86cd799439011",
          authorId: "user_alice",
          text: "Message in active room",
          seq: 1,
          clientMsgId: "c_msg_1",
          ts: new Date().toISOString(),
          kind: "user",
        },
      });
    });
    expect(result.current.messages.length).toBe(1);

    // Host ends room: receives room:status_changed
    act(() => {
      trigger("room:status_changed", {
        roomId: "507f1f77bcf86cd799439011",
        status: "ended",
      });
    });

    expect(onRoomEnded).toHaveBeenCalledTimes(1);
    // Sockets are NOT destroyed on room ended!
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(syncProvider.disconnect).not.toHaveBeenCalled();
    // History is preserved
    expect(result.current.messages.length).toBe(1);
    expect(result.current.isRoomEnded).toBe(true);

    // Sending is disabled when room ended
    let sendResult: string | null = "initial";
    await act(async () => {
      sendResult = await result.current.sendMessage(
        "Attempting to send after room ended"
      );
    });
    expect(sendResult).toBeNull();
  });

  it("12. explicit teardown on unmount removes all socket listeners, calls disconnect, and prevents reconnection", async () => {
    const { unmount } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    expect(Object.keys(registeredHandlers).length).toBeGreaterThan(0);

    // Unmount hook -> triggers explicit cleanup
    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    // Disconnect called
    expect(mockSocket.disconnect).toHaveBeenCalled();

    // Verify listeners removed with off()
    expect(mockSocket.off).toHaveBeenCalledWith("connect", expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith("chat:message", expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith("disconnect", expect.any(Function));

    // Further transport events do NOT trigger reconnect or state mutation
    act(() => {
      trigger("connect");
    });
    // mockSocket.emit room:join should not be called again after unmount
    expect(mockSocket.emit).toHaveBeenCalledTimes(1); // Only the initial room:join
  });

  it("13. live room:member_left(reason: removed) triggers callback and permanently destroys socket & syncProvider without reconnecting", async () => {
    const onMemberRemoved = vi.fn();
    const syncProvider = { disconnect: vi.fn(), destroy: vi.fn() };

    const { unmount } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
        onMemberRemoved,
        syncProvider,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    // Receive room:member_left for dummyMember with reason 'removed'
    await act(async () => {
      trigger("room:member_left", {
        roomId: "507f1f77bcf86cd799439011",
        memberId: dummyMember.id,
        reason: "removed",
      });
      await Promise.resolve();
    });

    expect(onMemberRemoved).toHaveBeenCalledWith(dummyMember.id);
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(syncProvider.disconnect).toHaveBeenCalled();
    expect(syncProvider.destroy).toHaveBeenCalled();

    unmount();
  });

  it("14. live room:deleted triggers callback and permanently destroys socket & syncProvider without reconnecting", async () => {
    const onRoomDeleted = vi.fn();
    const syncProvider = { disconnect: vi.fn(), destroy: vi.fn() };

    const { unmount } = renderHook(() =>
      useRoomSocket({
        roomId: "507f1f77bcf86cd799439011",
        slug: "test-slug-123",
        currentMember: dummyMember,
        enabled: true,
        onRoomDeleted,
        syncProvider,
      })
    );

    await waitForSocketReady();
    act(() => {
      mockSocket.connected = true;
      trigger("connect");
    });

    await act(async () => {
      trigger("room:deleted", {
        roomId: "507f1f77bcf86cd799439011",
      });
      await Promise.resolve();
    });

    expect(onRoomDeleted).toHaveBeenCalledTimes(1);
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(syncProvider.disconnect).toHaveBeenCalled();
    expect(syncProvider.destroy).toHaveBeenCalled();

    unmount();
  });
});
