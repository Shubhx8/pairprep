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

const { mockInstances, MockHocuspocusProvider } = vi.hoisted(() => {
  class MockProvider {
    static shouldFail = false;

    configuration: MockProviderConfiguration;
    status: WebSocketStatus = "connecting" as WebSocketStatus;
    isDestroyed = false;

    constructor(configuration: MockProviderConfiguration) {
      if (MockProvider.shouldFail) {
        MockProvider.shouldFail = false;
        throw new Error("Simulated constructor failure");
      }
      this.configuration = {
        ...configuration,
        websocketProvider: { status: this.status },
      };
      instances.push(this);
    }

    destroy() {
      this.isDestroyed = true;
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

  return { mockInstances: instances, MockHocuspocusProvider: MockProvider };
});

vi.mock("@hocuspocus/provider", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@hocuspocus/provider");
  return {
    ...actual,
    HocuspocusProvider: MockHocuspocusProvider,
  };
});

describe("useRoomSync hook", () => {
  const validRoomId = "507f1f77bcf86cd799439011";
  const validRoomId2 = "607f1f77bcf86cd799439022";

  beforeEach(() => {
    mockInstances.length = 0;
    MockHocuspocusProvider.shouldFail = false;
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
    expect(result.current.error?.message).toBe("Authentication failed: invalid_guest");
  });

  it("handles server closure error codes (e.g. 4003, 4029)", () => {
    const { result } = renderHook(() =>
      useRoomSync({ roomId: validRoomId, enabled: true })
    );

    const instance = mockInstances[0]!;

    act(() => {
      instance.simulateClose(4003, "kicked_by_admin");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/Connection closed: kicked_by_admin/);
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
});
