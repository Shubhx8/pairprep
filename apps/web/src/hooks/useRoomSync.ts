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

export type RoomSyncStatus =
  "connecting" | "connected" | "reconnecting" | "offline" | "disconnected" | "error";

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

    const isBrowserOffline = typeof navigator !== "undefined" && !navigator.onLine;
    setStatus(isBrowserOffline ? "offline" : "connecting");
    setIsSynced(false);
    setError(null);

    const activeDoc = new Y.Doc({ gc: false });
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

          if (wsStatus === WebSocketStatus.Connected) {
            hasConnectedOnce = true;
            setStatus("connected");
          } else if (wsStatus === WebSocketStatus.Connecting) {
            setStatus(hasConnectedOnce ? "reconnecting" : "connecting");
          } else if (wsStatus === WebSocketStatus.Disconnected) {
            if (typeof navigator !== "undefined" && !navigator.onLine) {
              setStatus("offline");
            } else if (hasConnectedOnce) {
              setStatus("reconnecting");
            } else {
              setStatus("disconnected");
            }
          }
        },
        onSynced({ state }: onSyncedParameters) {
          if (!isCurrent) return;
          setIsSynced(state);
        },
        onAuthenticationFailed({ reason }: onAuthenticationFailedParameters) {
          if (!isCurrent) return;
          setStatus("error");
          setError(new Error(`Authentication failed: ${reason}`));
        },
        onClose({ event }: onCloseParameters) {
          if (!isCurrent) return;
          if (
            event &&
            (event.code === 4001 || event.code === 4003 || event.code === 4029)
          ) {
            setStatus("error");
            setError(
              new Error(`Connection closed: ${event.reason || `code ${event.code}`}`)
            );
          }
        },
      });

      setDoc(activeDoc);
      setProvider(activeProvider);
    } catch (err) {
      if (!isCurrent) return;
      try {
        activeDoc.destroy();
      } catch {
        // ignore
      }
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
      setDoc(null);
      setProvider(null);
      return;
    }

    const handleOnline = () => {
      if (!isCurrent) return;
      if (
        activeProvider?.configuration.websocketProvider.status ===
        WebSocketStatus.Connected
      ) {
        setStatus("connected");
      } else {
        setStatus(hasConnectedOnce ? "reconnecting" : "connecting");
      }
    };

    const handleOffline = () => {
      if (!isCurrent) return;
      setStatus("offline");
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
        } catch {
          // ignore
        }
      }

      if (customWsProvider) {
        try {
          customWsProvider.destroy();
        } catch {
          // ignore
        }
      }

      try {
        activeDoc.destroy();
      } catch {
        // ignore
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
