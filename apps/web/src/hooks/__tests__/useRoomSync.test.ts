import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { WebSocketStatus } from "@hocuspocus/provider";
import { useRoomSync, type UseRoomSyncOptions } from "../useRoomSync.js";

interface MockProviderConfiguration {
  websocketProvider?: { status: WebSocketStatus };
  onStatus?: (params: { status: WebSocketStatus }) => void;
  onSynced?: (params: { state: boolean }) => void;
  onAuthenticationFailed?: (params: { reason: string }) => void;
  onClose?: (params: { event: { code: number; reason: string } }) => void;
  [key: string]: unknown;
}

interface MockWsProviderConfiguration {
  url: string;
  WebSocketPolyfill?: unknown;
  [key: string]: unknown;
}

const {
  mockInstances,
  mockWsInstances,
  destructionOrderLog,
  MockHocuspocusProvider,
  MockHocuspocusProviderWebsocket,
} = vi.hoisted(() => {
  const destructionLog: string[] = [];

  class MockWsProvider {
    static shouldFailDestroy = false;
    configuration: MockWsProviderConfiguration;
    status: WebSocketStatus = "connecting" as WebSocketStatus;
    isDestroyed = false;

    constructor(configuration: MockWsProviderConfiguration) {
      this.configuration = configuration;
      wsInstances.push(this);
    }

    destroy() {
      this.isDestroyed = true;
      destructionLog.push("customWsProvider");
      if (MockWsProvider.shouldFailDestroy) {
        MockWsProvider.shouldFailDestroy = false;
        throw new Error("Simulated WebSocket destroy failure");
      }
    }
  }

  class MockProvider {
    static shouldFail = false;
    static shouldFailAttach = false;
    static shouldFailDestroy = false;

    configuration: MockProviderConfiguration;
    status: WebSocketStatus = "connecting" as WebSocketStatus;
    isDestroyed = false;
    attachCount = 0;
    _isAttached = false;

    constructor(configuration: MockProviderConfiguration) {
      if (MockProvider.shouldFail) {
        MockProvider.shouldFail = false;
        throw new Error("Simulated constructor failure");
      }
      this.configuration = {
        ...configuration,
        websocketProvider: configuration.websocketProvider || {
          status: this.status,
        },
      };
      instances.push(this);
    }

    attach() {
      if (MockProvider.shouldFailAttach) {
        MockProvider.shouldFailAttach = false;
        throw new Error("Simulated attach failure");
      }
      this.attachCount++;
      this._isAttached = true;
    }

    disconnect() {
      this.status = "disconnected" as WebSocketStatus;
      if (this.configuration.websocketProvider) {
        (this.configuration.websocketProvider as { status: WebSocketStatus }).status =
          "disconnected" as WebSocketStatus;
      }
    }

    connect() {
      this.status = "connecting" as WebSocketStatus;
      if (this.configuration.websocketProvider) {
        (this.configuration.websocketProvider as { status: WebSocketStatus }).status =
          "connecting" as WebSocketStatus;
      }
    }

    destroy() {
      this.isDestroyed = true;
      destructionLog.push("activeProvider");
      if (MockProvider.shouldFailDestroy) {
        MockProvider.shouldFailDestroy = false;
        throw new Error("Simulated provider destroy failure");
      }
    }

    simulateStatus(newStatus: WebSocketStatus) {
      this.status = newStatus;
      if (this.configuration?.websocketProvider) {
        this.configuration.websocketProvider.status = newStatus;
      }
      this.configuration.onStatus?.({ status: newStatus });
    }

    simulateSynced(state: boolean) {
      this.configuration.onSynced?.({ state });
    }

    simulateAuthFailed(reason: string) {
      this.configuration.onAuthenticationFailed?.({ reason });
    }

    simulateClose(code: number, reason: string) {
      this.configuration.onClose?.({ event: { code, reason } });
    }
  }

  const instances: MockProvider[] = [];
  const wsInstances: MockWsProvider[] = [];

  return {
    mockInstances: instances,
    mockWsInstances: wsInstances,
    destructionOrderLog: destructionLog,
    MockHocuspocusProvider: MockProvider,
    MockHocuspocusProviderWebsocket: MockWsProvider,
  };
});

vi.mock("@hocuspocus/provider", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@hocuspocus/provider");
  return {
    ...actual,
    HocuspocusProvider: MockHocuspocusProvider,
    HocuspocusProviderWebsocket: MockHocuspocusProviderWebsocket,
  };
});

describe("useRoomSync hook", () => {
  const validRoomId = "507f1f77bcf86cd799439011";
  const validRoomId2 = "607f1f77bcf86cd799439022";

  beforeEach(() => {
    mockInstances.length = 0;
    mockWsInstances.length = 0;
    destructionOrderLog.length = 0;
    MockHocuspocusProvider.shouldFail = false;
    MockHocuspocusProvider.shouldFailAttach = false;
    MockHocuspocusProvider.shouldFailDestroy = false;
    MockHocuspocusProviderWebsocket.shouldFailDestroy = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not create a provider or document when disabled", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: false })
    );

    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();
    expect(result.current.status).toBe("disconnected");
    expect(result.current.isSynced).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockInstances).toHaveLength(0);
  });

  it("does not create a provider when roomId is null or undefined", () => {
    const { result } = renderHook(() => useRoomSync({ roomId: null, enabled: true }));

    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();
    expect(result.current.status).toBe("disconnected");
    expect(result.current.error).toBeNull();
    expect(mockInstances).toHaveLength(0);
  });

  it("rejects invalid room ID (slug) before provider creation and surfaces error", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: "practice-slug-alpha", enabled: true })
    );

    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toMatch(/Invalid room document id/);
    expect(mockInstances).toHaveLength(0);
  });

  it("creates exactly one Y.Doc and HocuspocusProvider with valid ObjectId", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    expect(mockInstances).toHaveLength(1);
    const instance = mockInstances[0]!;

    expect(result.current.doc).toBeInstanceOf(Y.Doc);
    expect(result.current.provider).toBe(instance);
    expect(instance.configuration.name).toBe(validRoomId);
    expect(instance.configuration.document).toBe(result.current.doc);
    expect(result.current.status).toBe("connecting");
    expect(result.current.isSynced).toBe(false);
  });

  it("transitions status to connected and reflects sync state", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateStatus(WebSocketStatus.Connected);
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.isSynced).toBe(false);

    act(() => {
      instance.simulateSynced(true);
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.isSynced).toBe(true);
  });

  it("transitions to reconnecting when connection drops after being connected", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateStatus(WebSocketStatus.Connected);
    });
    expect(result.current.status).toBe("connected");

    act(() => {
      instance.simulateStatus(WebSocketStatus.Connecting);
    });
    expect(result.current.status).toBe("reconnecting");
  });

  it("handles authentication rejection and sets error status", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateAuthFailed("invalid_guest");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe(
      "Authentication required. Please sign in or rejoin the room."
    );
  });

  it("handles server closure error codes and maps them to friendly messages (e.g. 4003, 4029)", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateClose(4003, "kicked_by_admin");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe(
      "Access denied. You do not have permission to participate in this room."
    );
  });

  it("handles runtime authentication failures and maps room capacity to friendly Room Full message", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateAuthFailed("room_capacity_exceeded");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe(
      "Room is full. This room has reached its maximum capacity of 6 participants."
    );
  });

  it("handles rate limit, shutdown, and oversized close codes with friendly runtime error messages", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateClose(4029, "rate_limit_exceeded");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe(
      "Too many requests. Please slow down and wait a moment before reconnecting."
    );

    act(() => {
      instance.simulateClose(1001, "server_shutdown");
    });
    expect(result.current.error?.message).toBe(
      "Server is restarting or shutting down. Reconnecting shortly..."
    );

    act(() => {
      instance.simulateClose(1009, "too big");
    });
    expect(result.current.error?.message).toBe(
      "Document or message exceeds maximum allowed size."
    );
  });

  it("destroys provider and document on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;
    const doc = result.current.doc!;
    const destroySpy = vi.spyOn(doc, "destroy");

    unmount();

    expect(instance.isDestroyed).toBe(true);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("cleans up previous provider and creates new one when roomId changes", () => {
    const { result, rerender } = renderHook(
      (props: UseRoomSyncOptions) => useRoomSync(props),
      {
        initialProps: { roomId: validRoomId, enabled: true },
      }
    );

    expect(mockInstances).toHaveLength(1);
    const firstInstance = mockInstances[0]!;
    expect(firstInstance.configuration.name).toBe(validRoomId);

    // Switch room
    rerender({ roomId: validRoomId2, enabled: true });

    expect(firstInstance.isDestroyed).toBe(true);
    expect(mockInstances).toHaveLength(2);
    const secondInstance = mockInstances[1]!;
    expect(secondInstance.configuration.name).toBe(validRoomId2);
    expect(result.current.provider).toBe(secondInstance);
  });

  it("prevents stale provider callbacks from updating state after unmount or switch", () => {
    const { result, rerender } = renderHook(
      (props: UseRoomSyncOptions) => useRoomSync(props),
      {
        initialProps: { roomId: validRoomId, enabled: true },
      }
    );

    const firstInstance = mockInstances[0]!;

    // Switch to room 2
    rerender({ roomId: validRoomId2, enabled: true });
    const secondInstance = mockInstances[1]!;

    // Late callback from room 1 should be ignored
    act(() => {
      firstInstance.simulateAuthFailed("stale_failure");
      firstInstance.simulateSynced(true);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isSynced).toBe(false);

    // Callback from room 2 is respected
    act(() => {
      secondInstance.simulateSynced(true);
    });
    expect(result.current.isSynced).toBe(true);
  });

  it("handles offline and online browser events cleanly", () => {
    const { result, unmount } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    expect(result.current.status).toBe("connecting");

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.status).toBe("offline");

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.status).toBe("connecting");

    // Unmount cleans up event listeners
    unmount();
    // Dispatching again does not throw
    window.dispatchEvent(new Event("offline"));
  });

  it("handles React StrictMode double-mounting without leaking or duplicating active providers", () => {
    // Simulate StrictMode: mount, unmount, remount
    const { unmount } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    expect(mockInstances).toHaveLength(1);
    const firstInstance = mockInstances[0]!;

    // StrictMode unmounts first invocation
    unmount();
    expect(firstInstance.isDestroyed).toBe(true);

    // StrictMode mounts second invocation
    const { result: remountResult } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    expect(mockInstances).toHaveLength(2);
    const secondInstance = mockInstances[1]!;
    expect(secondInstance.isDestroyed).toBe(false);
    expect(remountResult.current.provider).toBe(secondInstance);

    act(() => {
      secondInstance.simulateStatus(WebSocketStatus.Connected);
      secondInstance.simulateSynced(true);
    });

    expect(remountResult.current.status).toBe("connected");
    expect(remountResult.current.isSynced).toBe(true);
  });

  it("handles provider constructor failure safely", () => {
    MockHocuspocusProvider.shouldFail = true;

    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("Simulated constructor failure");
    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();
  });

  it("attaches the provider exactly once when WebSocketPolyfill is injected", () => {
    class DummyWs {}

    const { result, unmount } = renderHook(() =>
      useRoomSync({
        roomId: validRoomId,
        enabled: true,
        WebSocketPolyfill: DummyWs,
      })
    );

    expect(mockWsInstances).toHaveLength(1);
    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.attachCount).toBe(1);
    expect(mockInstances[0]!._isAttached).toBe(true);
    expect(result.current.provider).toBe(mockInstances[0]!);

    unmount();
    expect(mockInstances[0]!.isDestroyed).toBe(true);
    expect(mockWsInstances[0]!.isDestroyed).toBe(true);
  });

  it("destroys custom socket if HocuspocusProvider construction fails", () => {
    class DummyWs {}
    MockHocuspocusProvider.shouldFail = true;

    const { result } = renderHook(() =>
      useRoomSync({
        roomId: validRoomId,
        enabled: true,
        WebSocketPolyfill: DummyWs,
      })
    );

    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0]!.isDestroyed).toBe(true);
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("Simulated constructor failure");
  });

  it("cleans up provider, custom WebSocket, and Y.Doc in exact order when attach() throws", () => {
    class DummyWs {}
    MockHocuspocusProvider.shouldFailAttach = true;

    const originalDocDestroy = Y.Doc.prototype.destroy;
    const docDestroySpy = vi
      .spyOn(Y.Doc.prototype, "destroy")
      .mockImplementation(function (this: Y.Doc) {
        destructionOrderLog.push("activeDoc");
        return originalDocDestroy.call(this);
      });

    const { result } = renderHook(() =>
      useRoomSync({
        roomId: validRoomId,
        enabled: true,
        WebSocketPolyfill: DummyWs,
      })
    );

    // attach() threw, so the error path should have transitioned to error
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Simulated attach failure");
    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();

    // Verify both HocuspocusProvider and custom WebSocket provider were created
    expect(mockInstances).toHaveLength(1);
    expect(mockWsInstances).toHaveLength(1);

    // Verify both are marked destroyed
    expect(mockInstances[0]!.isDestroyed).toBe(true);
    expect(mockWsInstances[0]!.isDestroyed).toBe(true);

    // Verify exact destruction order of all three resources in one ordered log:
    // activeProvider first, customWsProvider second, activeDoc third
    expect(destructionOrderLog).toEqual([
      "activeProvider",
      "customWsProvider",
      "activeDoc",
    ]);

    // Verify each resource is destroyed exactly once
    expect(destructionOrderLog.filter((x) => x === "activeProvider")).toHaveLength(1);
    expect(destructionOrderLog.filter((x) => x === "customWsProvider")).toHaveLength(1);
    expect(destructionOrderLog.filter((x) => x === "activeDoc")).toHaveLength(1);
    expect(docDestroySpy).toHaveBeenCalledTimes(1);

    docDestroySpy.mockRestore();
  });

  it("preserves primary attachment error and executes remaining cleanups when a cleanup operation throws", () => {
    class DummyWs {}
    MockHocuspocusProvider.shouldFailAttach = true;
    MockHocuspocusProvider.shouldFailDestroy = true;

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const originalDocDestroy = Y.Doc.prototype.destroy;
    const docDestroySpy = vi
      .spyOn(Y.Doc.prototype, "destroy")
      .mockImplementation(function (this: Y.Doc) {
        destructionOrderLog.push("activeDoc");
        return originalDocDestroy.call(this);
      });

    const { result } = renderHook(() =>
      useRoomSync({
        roomId: validRoomId,
        enabled: true,
        WebSocketPolyfill: DummyWs,
      })
    );

    // 1. Primary error is preserved
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Simulated attach failure");
    expect(result.current.doc).toBeNull();
    expect(result.current.provider).toBeNull();

    // 2. Secondary cleanup error was logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[useRoomSync] Provider cleanup error:",
      expect.objectContaining({ message: "Simulated provider destroy failure" })
    );

    // 3. Subsequent cleanups still executed in order
    expect(mockWsInstances[0]!.isDestroyed).toBe(true);
    expect(destructionOrderLog).toEqual([
      "activeProvider",
      "customWsProvider",
      "activeDoc",
    ]);

    // 4. Each resource attempted exactly once
    expect(destructionOrderLog.filter((x) => x === "activeProvider")).toHaveLength(1);
    expect(destructionOrderLog.filter((x) => x === "customWsProvider")).toHaveLength(1);
    expect(destructionOrderLog.filter((x) => x === "activeDoc")).toHaveLength(1);
    expect(docDestroySpy).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
    docDestroySpy.mockRestore();
  });
});
