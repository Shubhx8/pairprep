import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useParticipantSync } from "../useParticipantSync.js";
import type { HocuspocusProvider } from "@hocuspocus/provider";

class MockAwareness {
  private states = new Map<number, Record<string, unknown>>();
  private listeners = new Set<() => void>();

  getStates() {
    return this.states;
  }

  setLocalState(state: Record<string, unknown>, clientId = 1) {
    this.states.set(clientId, state);
    this.emitChange();
  }

  setRemoteState(clientId: number, state: Record<string, unknown>) {
    this.states.set(clientId, state);
    this.emitChange();
  }

  removeRemoteState(clientId: number) {
    this.states.delete(clientId);
    this.emitChange();
  }

  on(event: string, cb: () => void) {
    if (event === "change") this.listeners.add(cb);
  }

  off(event: string, cb: () => void) {
    if (event === "change") this.listeners.delete(cb);
  }

  emitChange() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get listenerCount() {
    return this.listeners.size;
  }
}

describe("useParticipantSync (Finding 1)", () => {
  let mockAwareness: MockAwareness;
  let mockProvider: Partial<HocuspocusProvider>;
  let refreshFn: ReturnType<typeof vi.fn>;
  const callRefresh: () => Promise<void> = async () => {
    await (refreshFn as unknown as (...args: unknown[]) => Promise<void>)();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockAwareness = new MockAwareness();
    mockProvider = {
      awareness: mockAwareness as unknown as HocuspocusProvider["awareness"],
    };
    refreshFn = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("1. Participant joins: triggers refresh after debounce", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 300,
        fallbackIntervalMs: 30000,
      })
    );

    expect(refreshFn).toHaveBeenCalledTimes(0);

    // Remote participant 2 joins
    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob Guest" } });
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);

    // Advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("2. Participant leaves: triggers refresh after debounce", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    mockAwareness.setRemoteState(2, { user: { name: "Bob Guest" } });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 300,
        fallbackIntervalMs: 30000,
      })
    );

    // Remote participant leaves
    act(() => {
      mockAwareness.removeRemoteState(2);
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("3. Cursor movement: does not trigger participant refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    mockAwareness.setRemoteState(2, { user: { name: "Bob Guest" }, cursor: { line: 1 } });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 300,
      })
    );

    // Remote client moves cursor
    act(() => {
      mockAwareness.setRemoteState(2, {
        user: { name: "Bob Guest" },
        cursor: { line: 5, col: 10 },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);
  });

  it("4. Selection-only awareness update: does not trigger participant refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    mockAwareness.setRemoteState(2, { user: { name: "Bob Guest" } });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 300,
      })
    );

    // Remote client updates selection only
    act(() => {
      mockAwareness.setRemoteState(2, {
        user: { name: "Bob Guest" },
        selection: { anchor: 10, head: 25 },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);
  });

  it("5. Metadata-only awareness update: does not trigger participant refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    mockAwareness.setRemoteState(2, { user: { name: "Bob Guest", color: "#3b82f6" } });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 300,
      })
    );

    // Remote client updates color or name metadata without changing client ID
    act(() => {
      mockAwareness.setRemoteState(2, {
        user: { name: "Bob Guest Updated", color: "#10b981" },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);
  });

  it("6. Multiple rapid joins/leaves: coalesces into a single debounced refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 400,
      })
    );

    // Rapid bursts of joins and leaves
    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });
    vi.advanceTimersByTime(100);

    act(() => {
      mockAwareness.setRemoteState(3, { user: { name: "Charlie" } });
    });
    vi.advanceTimersByTime(100);

    act(() => {
      mockAwareness.removeRemoteState(2);
    });
    vi.advanceTimersByTime(100);

    expect(refreshFn).toHaveBeenCalledTimes(0);

    // Finish debounce window
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("7. Visible-tab fallback: triggers periodic refresh after 30 seconds", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        fallbackIntervalMs: 30000,
      })
    );

    expect(refreshFn).toHaveBeenCalledTimes(0);

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("8. Hidden tab: pauses fallback refresh while hidden", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        fallbackIntervalMs: 30000,
      })
    );

    // Switch tab to hidden
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 60 seconds pass while tab is hidden
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);
  });

  it("9. Tab becomes visible: resumes fallback refresh and reconciles pending change", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        fallbackIntervalMs: 30000,
        debounceMs: 200,
      })
    );

    // Tab hidden
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Remote join occurs while tab is hidden
    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });

    // Tab becomes visible again
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("10. HTTP 429: activates backoff and defers subsequent refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    refreshFn.mockRejectedValueOnce({ status: 429, retryAfterSec: 5 });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 100,
      })
    );

    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Another join triggers during 5s backoff
    act(() => {
      mockAwareness.setRemoteState(3, { user: { name: "Charlie" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Still in backoff, not called again immediately
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("11. Retry-After present: specified delay is respected before retrying pending refresh", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    refreshFn.mockRejectedValueOnce({ status: 429, retryAfterSec: 4 });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 100,
      })
    );

    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Pending event during backoff
    act(() => {
      mockAwareness.setRemoteState(3, { user: { name: "Charlie" } });
    });

    // Advance 3.5s (before 4s retry-after)
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Advance remaining 500ms + debounce 100ms
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("12. No Retry-After: capped exponential backoff is applied on 429", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);
    // 429 without retryAfterSec: base 2000ms
    refreshFn.mockRejectedValueOnce({ status: 429 });

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 100,
      })
    );

    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Queue another join during backoff
    act(() => {
      mockAwareness.setRemoteState(3, { user: { name: "Charlie" } });
    });

    // 1500ms into backoff -> not yet called
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Total 2000ms backoff + 100ms debounce elapsed -> retry fires
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("13. Request already running: duplicate parallel refresh is prevented and queued", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    let resolveFirstRequest!: () => void;
    const slowRequest = new Promise<void>((resolve) => {
      resolveFirstRequest = resolve;
    });
    refreshFn.mockReturnValueOnce(slowRequest);

    renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        debounceMs: 100,
      })
    );

    act(() => {
      mockAwareness.setRemoteState(2, { user: { name: "Bob" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Another join event happens while request 1 is still in flight
    act(() => {
      mockAwareness.setRemoteState(3, { user: { name: "Charlie" } });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Duplicate call was prevented
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Resolve first request
    await act(async () => {
      resolveFirstRequest();
    });

    // Queued refresh fires after debounce
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("14. Component unmount: cleans up awareness listeners and all active timers", async () => {
    mockAwareness.setLocalState({ user: { name: "Local Host" } }, 1);

    const { unmount } = renderHook(() =>
      useParticipantSync({
        enabled: true,
        slug: "test-room",
        provider: mockProvider as HocuspocusProvider,
        localClientId: 1,
        onRefresh: callRefresh,
        fallbackIntervalMs: 30000,
        debounceMs: 200,
      })
    );

    expect(mockAwareness.listenerCount).toBe(1);

    unmount();

    expect(mockAwareness.listenerCount).toBe(0);

    // Verify fallback timer was stopped and does not invoke refresh
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });

    expect(refreshFn).toHaveBeenCalledTimes(0);
  });
});
