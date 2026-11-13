import { useState, useEffect } from "react";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
  type onStatusParameters,
  type onSyncedParameters,
  type onAuthenticationFailedParameters,
  type onCloseParameters,
} from "@hocuspocus/provider";
import { getSyncUrl } from "../lib/syncUrl.js";
import { isValidRoomId } from "../lib/roomId.js";
import { formatSyncCloseError } from "../lib/syncErrors.js";

export type RoomSyncStatus =
  "connecting" | "connected" | "reconnecting" | "offline" | "disconnected" | "error";

export { HocuspocusProvider, HocuspocusProviderWebsocket, Y };

export interface UseRoomSyncOptions {
  roomId: string | null | undefined;
  enabled?: boolean;
  url?: string;
  WebSocketPolyfill?: unknown;
}

export interface UseRoomSyncResult {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: RoomSyncStatus;
  isSynced: boolean;
  error: Error | null;
}

/**
 * Reusable React hook for managing the Hocuspocus WebSocket connection
 * and Yjs document lifecycle for a PairPrep room.
 *
 * Enforces:
 * - Room ObjectId validation (/^[0-9a-fA-F]{24}$/) prior to provider creation.
 * - Single document & provider ownership per lifecycle.
 * - Idempotent cleanup and React StrictMode resilience.
 * - Browser online/offline event synchronization.
 */
export function useRoomSync(options: UseRoomSyncOptions): UseRoomSyncResult {
  const { roomId, enabled = true, url, WebSocketPolyfill } = options;

  const [status, setStatus] = useState<RoomSyncStatus>(() => {
    if (!enabled || !roomId) return "disconnected";
    if (!isValidRoomId(roomId)) return "error";
    if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
    return "connecting";
  });

  const [isSynced, setIsSynced] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(() => {
    if (enabled && roomId && !isValidRoomId(roomId)) {
      return new Error(
        "Invalid room document id: expected 24-character hexadecimal ObjectId"
      );
    }
    return null;
  });

  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  useEffect(() => {
    // 1. Inactive or missing room: clear state and do not construct provider
    if (!enabled || !roomId) {
      setStatus("disconnected");
      setIsSynced(false);
      setError(null);
      setDoc(null);
      setProvider(null);
      return;
    }

    // 2. Malformed roomId (e.g. room URL slug or wrong length): reject before provider creation
    if (!isValidRoomId(roomId)) {
      setStatus("error");
      setIsSynced(false);
      setError(
        new Error("Invalid room document id: expected 24-character hexadecimal ObjectId")
      );
      setDoc(null);
      setProvider(null);
      return;
    }

    let isCurrent = true;
    let hasConnectedOnce = false;
    let browserOffline = typeof navigator !== "undefined" && !navigator.onLine;

    setStatus(browserOffline ? "offline" : "connecting");
    setIsSynced(false);
    setError(null);

    const activeDoc = new Y.Doc();
    const resolvedUrl = getSyncUrl({ overrideUrl: url });

    let activeProvider: HocuspocusProvider | null = null;
    let customWsProvider: HocuspocusProviderWebsocket | null = null;

    try {
      if (WebSocketPolyfill) {
        customWsProvider = new HocuspocusProviderWebsocket({
          url: resolvedUrl,
          WebSocketPolyfill,
        });
      }

      activeProvider = new HocuspocusProvider({
        ...(customWsProvider
          ? { websocketProvider: customWsProvider }
          : { url: resolvedUrl }),
        name: roomId,
        document: activeDoc,
        onStatus({ status: wsStatus }: onStatusParameters) {
          if (!isCurrent) return;

          if (browserOffline) {
            setStatus("offline");
            setIsSynced(false);
            if (wsStatus === WebSocketStatus.Connected) {
              const wsProvider =
                customWsProvider || activeProvider?.configuration.websocketProvider;
              if (typeof wsProvider?.disconnect === "function") {
                wsProvider.disconnect();
              }
            }
            return;
          }

          if (wsStatus === WebSocketStatus.Connected) {
            hasConnectedOnce = true;
            setStatus("connected");
          } else if (wsStatus === WebSocketStatus.Connecting) {
            setStatus(hasConnectedOnce ? "reconnecting" : "connecting");
          } else if (wsStatus === WebSocketStatus.Disconnected) {
            if (hasConnectedOnce) {
              setStatus("reconnecting");
            } else {
              setStatus("disconnected");
            }
          }
        },
        onSynced({ state }: onSyncedParameters) {
          if (!isCurrent || browserOffline) return;
          setIsSynced(state);
        },
        onAuthenticationFailed({ reason }: onAuthenticationFailedParameters) {
          if (!isCurrent || browserOffline) return;
          const formatted = formatSyncCloseError(4001, reason);
          setStatus("error");
          setError(new Error(formatted.message));
        },
        onClose({ event }: onCloseParameters) {
          if (!isCurrent || browserOffline) return;
          if (event) {
            const formatted = formatSyncCloseError(event.code, event.reason);
            if (
              event.code === 4001 ||
              event.code === 4003 ||
              event.code === 4004 ||
              event.code === 4029 ||
              event.code === 1001 ||
              event.code === 1009 ||
              formatted.isFatal ||
              event.code >= 4000
            ) {
              setStatus("error");
              setError(new Error(formatted.message));
            }
          }
        },
      });

      if (customWsProvider) {
        activeProvider.attach();
      }

      if (browserOffline) {
        const wsProvider =
          customWsProvider || activeProvider.configuration.websocketProvider;
        if (typeof wsProvider?.disconnect === "function") {
          wsProvider.disconnect();
        }
      }

      setDoc(activeDoc);
      setProvider(activeProvider);
    } catch (err) {
      if (!isCurrent) return;
      if (activeProvider) {
        try {
          activeProvider.destroy();
        } catch (cleanupErr) {
          console.error("[useRoomSync] Provider cleanup error:", cleanupErr);
        }
        activeProvider = null;
      }
      if (customWsProvider) {
        try {
          customWsProvider.destroy();
        } catch (cleanupErr) {
          console.error("[useRoomSync] Custom WebSocket cleanup error:", cleanupErr);
        }
        customWsProvider = null;
      }
      try {
        activeDoc.destroy();
      } catch (cleanupErr) {
        console.error("[useRoomSync] Document cleanup error:", cleanupErr);
      }
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
      setDoc(null);
      setProvider(null);
      return;
    }

    const handleOnline = () => {
      if (!isCurrent) return;
      browserOffline = false;
      setIsSynced(false);
      setStatus(hasConnectedOnce ? "reconnecting" : "connecting");

      const wsProvider =
        customWsProvider || activeProvider?.configuration?.websocketProvider;
      if (typeof wsProvider?.connect === "function") {
        void wsProvider.connect();
      } else if (typeof activeProvider?.connect === "function") {
        void activeProvider.connect();
      }
    };

    const handleOffline = () => {
      if (!isCurrent) return;
      browserOffline = true;
      setIsSynced(false);
      setStatus("offline");

      const wsProvider =
        customWsProvider || activeProvider?.configuration?.websocketProvider;
      if (typeof wsProvider?.disconnect === "function") {
        wsProvider.disconnect();
      } else if (typeof activeProvider?.disconnect === "function") {
        activeProvider.disconnect();
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
    }

    return () => {
      isCurrent = false;

      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      }

      if (activeProvider) {
        try {
          activeProvider.destroy();
        } catch (cleanupErr) {
          console.error("[useRoomSync] Provider cleanup error:", cleanupErr);
        }
      }

      if (customWsProvider) {
        try {
          customWsProvider.destroy();
        } catch (cleanupErr) {
          console.error("[useRoomSync] Custom WebSocket cleanup error:", cleanupErr);
        }
      }

      try {
        activeDoc.destroy();
      } catch (cleanupErr) {
        console.error("[useRoomSync] Document cleanup error:", cleanupErr);
      }
    };
  }, [roomId, enabled, url, WebSocketPolyfill]);

  return {
    doc,
    provider,
    status,
    isSynced,
    error,
  };
}
