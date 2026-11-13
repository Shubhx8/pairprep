import { useEffect, useRef } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

export interface UseParticipantSyncOptions {
  enabled: boolean;
  slug: string | null;
  provider: HocuspocusProvider | null;
  localClientId?: number;
  onRefresh: () => Promise<void>;
  fallbackIntervalMs?: number; // default 30000 (30 seconds)
  debounceMs?: number; // default 500ms
}

/**
 * Event-driven participant synchronization hook for PairPrep rooms (Finding 1).
 *
 * Implements:
 * 1. Awareness-driven participant updates: Re-fetches room data only when remote client
 *    IDs join or leave in Yjs awareness (filters out cursor, selection, and metadata updates).
 * 2. Debouncing and coalescing: Groups rapid participant changes to prevent request bursts.
 * 3. 30-second fallback: Reconciles participant list periodically while tab is visible.
 * 4. Visibility awareness: Pauses fallback polling when tab is hidden; resumes when visible.
 * 5. HTTP 429 backoff: Honors Retry-After header or applies capped exponential backoff.
 * 6. Concurrency & cleanup: Prevents duplicate parallel requests and cleans up all timers.
 */
export function useParticipantSync({
  enabled,
  slug,
  provider,
  localClientId,
  onRefresh,
  fallbackIntervalMs = 30000,
  debounceMs = 500,
}: UseParticipantSyncOptions): void {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Track known remote client IDs to detect true join/leave transitions
  const prevRemoteClientIdsRef = useRef<Set<number>>(new Set());

  // Concurrency & timer management
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffCountRef = useRef(0);
  const isBackingOffRef = useRef(false);

  useEffect(() => {
    if (!enabled || !slug) {
      return;
    }

    const awareness = provider?.awareness ?? null;

    // Helper to execute refresh safely with concurrency locking & 429 backoff
    const executeRefresh = async () => {
      if (inFlightRef.current) {
        pendingRefreshRef.current = true;
        return;
      }

      if (isBackingOffRef.current) {
        pendingRefreshRef.current = true;
        return;
      }

      inFlightRef.current = true;
      try {
        await onRefreshRef.current();
        // Success: reset backoff count and state
        backoffCountRef.current = 0;
        isBackingOffRef.current = false;
      } catch (err: unknown) {
        const error = err as { status?: number; retryAfterSec?: number };
        if (error?.status === 429) {
          isBackingOffRef.current = true;
          const retryDelayMs =
            typeof error.retryAfterSec === "number" && error.retryAfterSec > 0
              ? error.retryAfterSec * 1000
              : Math.min(60000, 2000 * Math.pow(2, backoffCountRef.current));
          backoffCountRef.current += 1;

          if (backoffTimerRef.current) clearTimeout(backoffTimerRef.current);
          backoffTimerRef.current = setTimeout(() => {
            isBackingOffRef.current = false;
            if (pendingRefreshRef.current) {
              pendingRefreshRef.current = false;
              scheduleRefresh();
            }
          }, retryDelayMs);
        }
      } finally {
        inFlightRef.current = false;
        // If a membership change happened while request was running, schedule it
        if (pendingRefreshRef.current && !isBackingOffRef.current) {
          pendingRefreshRef.current = false;
          scheduleRefresh();
        }
      }
    };

    const scheduleRefresh = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        executeRefresh();
      }, debounceMs);
    };

    // 1. Fallback 30-second timer (active only when tab is visible)
    const startFallback = () => {
      stopFallback();
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      fallbackTimerRef.current = setInterval(() => {
        executeRefresh();
      }, fallbackIntervalMs);
    };

    const stopFallback = () => {
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };

    // 2. Visibility change handling
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopFallback();
      } else {
        startFallback();
        // Tab became visible: check if there was a pending refresh or reconcile
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          scheduleRefresh();
        }
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      startFallback();
    }

    // 3. Awareness change handling: only trigger on remote membership joins/leaves
    const getRemoteClientIds = (): Set<number> => {
      const ids = new Set<number>();
      if (!awareness) return ids;
      awareness.getStates().forEach((_, clientId) => {
        if (localClientId === undefined || clientId !== localClientId) {
          ids.add(clientId);
        }
      });
      return ids;
    };

    // Initialize baseline remote client IDs
    prevRemoteClientIdsRef.current = getRemoteClientIds();

    const handleAwarenessChange = () => {
      const currentIds = getRemoteClientIds();
      const prevIds = prevRemoteClientIdsRef.current;

      let membershipChanged = false;
      if (currentIds.size !== prevIds.size) {
        membershipChanged = true;
      } else {
        for (const id of currentIds) {
          if (!prevIds.has(id)) {
            membershipChanged = true;
            break;
          }
        }
      }

      prevRemoteClientIdsRef.current = currentIds;

      if (membershipChanged) {
        scheduleRefresh();
      }
    };

    if (awareness) {
      awareness.on("change", handleAwarenessChange);
    }

    return () => {
      if (awareness) {
        awareness.off("change", handleAwarenessChange);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      stopFallback();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (backoffTimerRef.current) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
      inFlightRef.current = false;
      pendingRefreshRef.current = false;
      isBackingOffRef.current = false;
    };
  }, [enabled, slug, provider, localClientId, fallbackIntervalMs, debounceMs]);
}
