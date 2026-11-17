import { useState, useEffect, useRef, useCallback } from "react";
import type { Socket } from "socket.io-client";
import type {
  RoomMemberDetailDto,
  UserRole,
  EventAck,
  ChatSendAckData,
  ChatDeliveredAckData,
  ChatReadAckData,
  ChatHistoryResponse,
  PresenceSnapshotPayload,
  PresenceStatusPayload,
  RoomMemberJoinedPayload,
  RoomMemberLeftPayload,
  RoomRoleChangedPayload,
  RoomStatusChangedPayload,
  RoomDeletedPayload,
  ChatMessagePayload,
  EventErrorDto,
} from "@pairprep/shared";
import { apiClient } from "../lib/apiClient.js";

export interface ChatMessageItem {
  id: string; // clientMsgId while pending, server messageId once confirmed
  clientMsgId: string;
  roomId: string;
  authorId: string;
  authorName?: string;
  seq?: number;
  text: string;
  ts: string;
  kind: "user" | "system";
  status: "sending" | "sent" | "failed";
  opId?: string;
  recipientIds?: string[];
  excludedRecipientIds?: string[];
  deliveredTo?: string[];
  readBy?: string[];
}

export type SocketConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "fatal_error";

export interface UseRoomSocketOptions {
  roomId: string | null;
  slug: string | null;
  currentMember: RoomMemberDetailDto | null;
  enabled: boolean;
  onRoleChanged?: (newRole: UserRole, memberId?: string) => void;
  onMemberRemoved?: (memberId: string) => void;
  onRoomEnded?: () => void;
  onRoomDeleted?: () => void;
  onMembersUpdated?: (members: RoomMemberDetailDto[]) => void;
  onMemberJoined?: (member: RoomMemberJoinedPayload["member"]) => void;
  onMemberLeft?: (memberId: string, reason?: string) => void;
  onPresenceSnapshot?: (payload: PresenceSnapshotPayload) => void;
  onPresenceStatus?: (payload: PresenceStatusPayload) => void;
  syncProvider?: { disconnect: () => void; destroy: () => void } | null;
  // Optional test override for custom socket URL/factory
  serverUrl?: string;
}

export interface UseRoomSocketReturn {
  connectionStatus: SocketConnectionStatus;
  messages: ChatMessageItem[];
  onlineMemberIds: Set<string>;
  isRateLimited: boolean;
  rateLimitCountdown: number; // in seconds
  isRoomEnded: boolean;
  isLoadingHistory: boolean;
  loadHistoryError: string | null;
  hasEarlierMessages: boolean;
  sendMessage: (text: string) => Promise<string | null>; // returns clientMsgId
  retryMessage: (clientMsgId: string) => Promise<void>;
  markMessageDelivered: (messageId: string, seq?: number) => void;
  markMessageRead: (messageId: string, seq?: number) => void;
  refetchHistory: () => Promise<void>;
  socketRef: React.MutableRefObject<Socket | null>;
}

const FATAL_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "ROOM_MISMATCH",
  "ORIGIN_FORBIDDEN",
  "ROOM_NOT_FOUND",
  "CONNECTION_LIMIT_EXCEEDED",
]);

export function useRoomSocket({
  roomId,
  slug,
  currentMember,
  enabled,
  onRoleChanged,
  onMemberRemoved,
  onRoomEnded,
  onRoomDeleted,
  onMembersUpdated,
  onMemberJoined,
  onMemberLeft,
  onPresenceSnapshot,
  onPresenceStatus,
  syncProvider,
  serverUrl,
}: UseRoomSocketOptions): UseRoomSocketReturn {
  const [connectionStatus, setConnectionStatus] =
    useState<SocketConnectionStatus>("idle");
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [onlineMemberIds, setOnlineMemberIds] = useState<Set<string>>(new Set());
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0); // in seconds
  const [isRoomEnded, setIsRoomEnded] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadHistoryError, setLoadHistoryError] = useState<string | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const ackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isReconnectingRef = useRef(false);
  const liveBufferRef = useRef<ChatMessageItem[]>([]);
  const isCatchingUpRef = useRef(false);
  const deliberatelyClosedRef = useRef(false);
  const currentMemberRef = useRef(currentMember);
  currentMemberRef.current = currentMember;
  const currentMemberId = currentMember?.id;
  const inFlightDeliveredIdsRef = useRef<Set<string>>(new Set());
  const confirmedDeliveredIdsRef = useRef<Set<string>>(new Set());
  const inFlightReadIdsRef = useRef<Set<string>>(new Set());
  const confirmedReadIdsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessageItem[]>(messages);
  messagesRef.current = messages;
  const acknowledgeUndeliveredMessagesRef = useRef<(items?: ChatMessageItem[]) => void>(
    () => {}
  );

  // Callbacks ref to prevent stale closures
  const callbacksRef = useRef({
    onRoleChanged,
    onMemberRemoved,
    onRoomEnded,
    onRoomDeleted,
    onMembersUpdated,
    onMemberJoined,
    onMemberLeft,
    onPresenceSnapshot,
    onPresenceStatus,
    syncProvider,
  });
  callbacksRef.current = {
    onRoleChanged,
    onMemberRemoved,
    onRoomEnded,
    onRoomDeleted,
    onMembersUpdated,
    onMemberJoined,
    onMemberLeft,
    onPresenceSnapshot,
    onPresenceStatus,
    syncProvider,
  };

  // Helper to permanently destroy connections upon terminal events
  const teardownOnTerminalEvent = useCallback(() => {
    deliberatelyClosedRef.current = true;
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    const sp = callbacksRef.current.syncProvider;
    if (sp) {
      sp.disconnect();
      sp.destroy();
    }
  }, []);

  // Rate limit countdown handler (units: seconds)
  const triggerRateLimitCountdown = useCallback((retryAfterSec: number) => {
    setIsRateLimited(true);
    setRateLimitCountdown(retryAfterSec);

    if (rateLimitTimerRef.current) {
      clearInterval(rateLimitTimerRef.current);
    }

    rateLimitTimerRef.current = setInterval(() => {
      setRateLimitCountdown((prev) => {
        if (prev <= 1) {
          if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current);
          setIsRateLimited(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Fetch initial or catch-up chat history via REST (/api/v1/rooms/:slug/messages?limit=200)
  const fetchChatHistory = useCallback(
    async (targetSlug: string): Promise<ChatMessageItem[]> => {
      setIsLoadingHistory(true);
      setLoadHistoryError(null);
      try {
        const response = await apiClient.get<ChatHistoryResponse>(
          `/api/v1/rooms/${targetSlug}/messages?limit=200`
        );
        setHasEarlierMessages(Boolean(response.hasMore));

        const historyItems: ChatMessageItem[] = response.messages.map((m) => ({
          id: m.id,
          clientMsgId: m.clientMsgId || m.id,
          roomId: m.roomId,
          authorId: m.authorId,
          authorName: m.authorName,
          seq: m.seq,
          text: m.text,
          ts: m.ts,
          kind: m.kind,
          status: "sent" as const,
          opId: m.opId,
          recipientIds: m.recipientIds || [],
          excludedRecipientIds: m.excludedRecipientIds || [],
          deliveredTo: m.deliveredTo || [],
          readBy: m.readBy || [],
        }));
        return historyItems;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to load chat history";
        setLoadHistoryError(message);
        return [];
      } finally {
        setIsLoadingHistory(false);
      }
    },
    []
  );

  // Manual history refetch
  const refetchHistory = useCallback(async () => {
    if (!slug) return;
    const history = await fetchChatHistory(slug);
    if (history.length > 0) {
      setMessages((prev) => {
        // Merge with existing pending messages
        const pending = prev.filter((m) => m.status !== "sent");
        const bySeq = new Map<number, ChatMessageItem>();
        for (const h of history) {
          if (h.seq !== undefined) bySeq.set(h.seq, h);
        }
        const sortedHistory = Array.from(bySeq.values()).sort(
          (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
        );
        return [...sortedHistory, ...pending];
      });
    }
  }, [slug, fetchChatHistory]);

  // Reconnection state reconciliation: refetches room details and last 200 messages
  const reconcileOnReconnect = useCallback(
    async (targetSlug: string) => {
      isCatchingUpRef.current = true;
      liveBufferRef.current = [];

      try {
        // 1. Refetch room details & members to catch up on offline lifecycle changes
        const roomRes = await apiClient.get<{
          room: { id: string; status: string };
          currentMember?: RoomMemberDetailDto;
          members?: RoomMemberDetailDto[];
        }>(`/api/v1/rooms/${targetSlug}`);

        // A. Check if current member was removed while offline
        const curMember = currentMemberRef.current;
        if (!roomRes.currentMember && curMember) {
          teardownOnTerminalEvent();
          callbacksRef.current.onMemberRemoved?.(curMember.id);
          return;
        }

        // B. Check if room ended while offline
        if (roomRes.room.status === "ended") {
          setIsRoomEnded(true);
          callbacksRef.current.onRoomEnded?.();
        }

        // C. Check if role changed while offline
        if (
          roomRes.currentMember &&
          curMember &&
          roomRes.currentMember.role !== curMember.role
        ) {
          callbacksRef.current.onRoleChanged?.(roomRes.currentMember.role);
        }

        // D. Update members list
        if (roomRes.members) {
          callbacksRef.current.onMembersUpdated?.(roomRes.members);
        }

        // 2. Refetch last 200 messages
        const history = await fetchChatHistory(targetSlug);

        // 3. Merge: history + liveBuffer + local pending/failed messages
        setMessages((prev) => {
          const pendingOrFailed = prev.filter(
            (m) => m.status === "sending" || m.status === "failed"
          );

          // Combined confirmed messages keyed by seq
          const confirmedMap = new Map<number, ChatMessageItem>();
          for (const item of history) {
            if (item.seq !== undefined) confirmedMap.set(item.seq, item);
          }
          for (const item of liveBufferRef.current) {
            if (item.seq !== undefined) confirmedMap.set(item.seq, item);
          }

          const sortedConfirmed = Array.from(confirmedMap.values()).sort(
            (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
          );

          // Remove pending messages that have been confirmed by clientMsgId
          const confirmedClientIds = new Set(sortedConfirmed.map((m) => m.clientMsgId));
          const remainingPending = pendingOrFailed.filter(
            (m) => !confirmedClientIds.has(m.clientMsgId)
          );

          return [...sortedConfirmed, ...remainingPending];
        });

        // 4. Auto-resend unacked messages on reconnect
        if (socketRef.current?.connected) {
          setMessages((currentMessages) => {
            const unacked = currentMessages.filter((m) => m.status === "sending");
            for (const msg of unacked) {
              socketRef.current?.emit(
                "chat:send",
                {
                  roomId: msg.roomId,
                  text: msg.text,
                  clientMsgId: msg.clientMsgId,
                },
                (ack: EventAck<ChatSendAckData>) => {
                  if (ack.ok) {
                    setMessages((prev) =>
                      prev.map((item) =>
                        item.clientMsgId === msg.clientMsgId
                          ? {
                              ...item,
                              id: ack.data.messageId,
                              seq: ack.data.seq,
                              ts: ack.data.ts,
                              status: "sent",
                            }
                          : item
                      )
                    );
                  }
                }
              );
            }
            return currentMessages;
          });
        }
      } catch (err) {
        console.error("Failed to reconcile room state on reconnect:", err);
      } finally {
        isCatchingUpRef.current = false;
        liveBufferRef.current = [];
      }
    },
    [fetchChatHistory, teardownOnTerminalEvent]
  );

  // Send message with optimistic preview, 8s ack timeout, and echo-before-ack deduplication
  const sendMessage = useCallback(
    async (text: string): Promise<string | null> => {
      const socket = socketRef.current;
      const curMember = currentMemberRef.current;
      if (!socket || !roomId || !curMember || isRateLimited || isRoomEnded) {
        return null;
      }

      const clientMsgId = crypto.randomUUID();
      const optimisticMsg: ChatMessageItem = {
        id: clientMsgId,
        clientMsgId,
        roomId,
        authorId: curMember.id,
        authorName: curMember.displayName,
        text: text.trim(),
        ts: new Date().toISOString(),
        kind: "user",
        status: "sending",
      };

      // Add optimistic message immediately
      setMessages((prev) => [...prev, optimisticMsg]);

      // 8-second ack timeout: transition to failed if neither ack nor echo resolves it
      const timer = setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMsgId === clientMsgId && m.status === "sending"
              ? { ...m, status: "failed" }
              : m
          )
        );
        ackTimersRef.current.delete(clientMsgId);
      }, 8000);
      ackTimersRef.current.set(clientMsgId, timer);

      // Emit chat:send with canonical clientMsgId
      socket.emit(
        "chat:send",
        {
          roomId,
          text: text.trim(),
          clientMsgId,
        },
        (ack: EventAck<ChatSendAckData>) => {
          // Clear ack timeout
          const existingTimer = ackTimersRef.current.get(clientMsgId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            ackTimersRef.current.delete(clientMsgId);
          }

          if (ack.ok) {
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMsgId === clientMsgId
                  ? {
                      ...m,
                      id: ack.data.messageId,
                      seq: ack.data.seq,
                      ts: ack.data.ts,
                      status: "sent",
                    }
                  : m
              )
            );
          } else {
            // Handle rate limiting (retryAfter in integer seconds)
            if (
              ack.error.code === "RATE_LIMITED" &&
              typeof ack.error.retryAfter === "number"
            ) {
              triggerRateLimitCountdown(ack.error.retryAfter);
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMsgId === clientMsgId ? { ...m, status: "failed" } : m
              )
            );
          }
        }
      );

      return clientMsgId;
    },
    [roomId, isRateLimited, isRoomEnded, triggerRateLimitCountdown]
  );

  // Retry sending a previously failed message with the exact same clientMsgId
  const retryMessage = useCallback(
    async (clientMsgId: string): Promise<void> => {
      const socket = socketRef.current;
      const targetMsg = messages.find((m) => m.clientMsgId === clientMsgId);
      if (!socket || !targetMsg || isRateLimited) return;

      // Update back to sending
      setMessages((prev) =>
        prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, status: "sending" } : m))
      );

      // Set 8-second ack timeout
      const timer = setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMsgId === clientMsgId && m.status === "sending"
              ? { ...m, status: "failed" }
              : m
          )
        );
        ackTimersRef.current.delete(clientMsgId);
      }, 8000);
      ackTimersRef.current.set(clientMsgId, timer);

      socket.emit(
        "chat:send",
        {
          roomId: targetMsg.roomId,
          text: targetMsg.text,
          clientMsgId,
        },
        (ack: EventAck<ChatSendAckData>) => {
          const existingTimer = ackTimersRef.current.get(clientMsgId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            ackTimersRef.current.delete(clientMsgId);
          }

          if (ack.ok) {
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMsgId === clientMsgId
                  ? {
                      ...m,
                      id: ack.data.messageId,
                      seq: ack.data.seq,
                      ts: ack.data.ts,
                      status: "sent",
                    }
                  : m
              )
            );
          } else {
            if (
              ack.error.code === "RATE_LIMITED" &&
              typeof ack.error.retryAfter === "number"
            ) {
              triggerRateLimitCountdown(ack.error.retryAfter);
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMsgId === clientMsgId ? { ...m, status: "failed" } : m
              )
            );
          }
        }
      );
    },
    [messages, isRateLimited, triggerRateLimitCountdown]
  );

  // Acknowledge receipt/delivery of a message with server confirmation & retry recovery (Phase 1 & 2)
  const markMessageDelivered = useCallback(
    (messageId: string, seq?: number) => {
      const socket = socketRef.current;
      if (!socket?.connected || !roomId || !messageId) return;

      // Skip if already server-confirmed or currently in-flight
      if (
        confirmedDeliveredIdsRef.current.has(messageId) ||
        inFlightDeliveredIdsRef.current.has(messageId)
      ) {
        return;
      }

      inFlightDeliveredIdsRef.current.add(messageId);

      // Bounded ack timeout (8s) to release in-flight lock on network silence
      const timer = setTimeout(() => {
        inFlightDeliveredIdsRef.current.delete(messageId);
      }, 8000);

      socket.emit(
        "chat:delivered",
        {
          roomId,
          messageId,
          seq,
        },
        (ack: EventAck<ChatDeliveredAckData>) => {
          clearTimeout(timer);
          inFlightDeliveredIdsRef.current.delete(messageId);
          if (ack && ack.ok) {
            confirmedDeliveredIdsRef.current.add(messageId);
          }
        }
      );
    },
    [roomId]
  );

  // Acknowledge view/read of a message with server confirmation & retry recovery (Phase 1 & 2)
  const markMessageRead = useCallback(
    (messageId: string, seq?: number) => {
      const socket = socketRef.current;
      if (!socket?.connected || !roomId || !messageId) return;

      if (
        confirmedReadIdsRef.current.has(messageId) ||
        inFlightReadIdsRef.current.has(messageId)
      ) {
        return;
      }

      inFlightReadIdsRef.current.add(messageId);

      const timer = setTimeout(() => {
        inFlightReadIdsRef.current.delete(messageId);
      }, 8000);

      socket.emit(
        "chat:read",
        {
          roomId,
          messageId,
          seq,
        },
        (ack: EventAck<ChatReadAckData>) => {
          clearTimeout(timer);
          inFlightReadIdsRef.current.delete(messageId);
          if (ack && ack.ok) {
            confirmedReadIdsRef.current.add(messageId);
            confirmedDeliveredIdsRef.current.add(messageId);
          }
        }
      );
    },
    [roomId]
  );

  // Acknowledge delivery for historical/unacknowledged peer messages (Phase 1.2, 2.3 & Phase 4)
  const acknowledgeUndeliveredMessages = useCallback(
    (items?: ChatMessageItem[]) => {
      const socket = socketRef.current;
      if (!socket?.connected || !roomId) return;
      const curMember = currentMemberRef.current;
      if (!curMember) return;
      const myId = (curMember as { memberId?: string }).memberId || curMember.id;

      const msgsToCheck = items ?? messagesRef.current;
      msgsToCheck.forEach((m) => {
        if (m.kind !== "user") return;
        const isOwn = m.authorId === myId || m.authorId === curMember.id;
        if (isOwn) return;

        // Skip if excluded
        if (
          m.excludedRecipientIds &&
          (m.excludedRecipientIds.includes(myId) ||
            m.excludedRecipientIds.includes(curMember.id))
        ) {
          return;
        }

        if (
          m.recipientIds &&
          m.recipientIds.length > 0 &&
          !m.recipientIds.includes(myId) &&
          !m.recipientIds.includes(curMember.id)
        ) {
          return;
        }

        const alreadyDelivered =
          (m.deliveredTo || []).includes(myId) ||
          (m.deliveredTo || []).includes(curMember.id) ||
          (m.readBy || []).includes(myId) ||
          (m.readBy || []).includes(curMember.id) ||
          confirmedDeliveredIdsRef.current.has(m.id);

        if (!alreadyDelivered && !inFlightDeliveredIdsRef.current.has(m.id)) {
          markMessageDelivered(m.id, m.seq);
        }
      });
    },
    [roomId, markMessageDelivered]
  );
  acknowledgeUndeliveredMessagesRef.current = acknowledgeUndeliveredMessages;

  // Main socket lifecycle effect: lazy load socket.io-client inside room chunk only
  useEffect(() => {
    if (!enabled || !roomId || !slug || !currentMemberId) {
      setConnectionStatus("idle");
      return;
    }

    deliberatelyClosedRef.current = false;
    let isCancelled = false;

    // Load initial chat history on mount
    fetchChatHistory(slug).then((initialHistory) => {
      if (!isCancelled) {
        messagesRef.current = initialHistory;
        setMessages(initialHistory);
        acknowledgeUndeliveredMessagesRef.current(initialHistory);
      }
    });

    // Dynamically import socket.io-client
    let socket: Socket | null = null;

    async function initSocket(): Promise<(() => void) | undefined> {
      try {
        const { io } = await import("socket.io-client");
        if (isCancelled || deliberatelyClosedRef.current) return undefined;

        // Connect via relative path or provided test serverUrl
        socket = io(serverUrl || window.location.origin, {
          path: "/socket.io",
          transports: ["websocket"],
          reconnection: true,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000,
          withCredentials: true,
        });

        socketRef.current = socket;
        setConnectionStatus("connecting");

        // Event listener handlers (stored for strict off() removal)
        const onConnect = () => {
          if (isCancelled) return;
          setConnectionStatus("connected");

          // Join room channel
          socket?.emit("room:join", { roomId }, (ack: EventAck) => {
            if (!ack.ok && ack.error) {
              if (FATAL_ERROR_CODES.has(ack.error.code)) {
                setConnectionStatus("fatal_error");
                socket?.disconnect();
              }
            } else {
              acknowledgeUndeliveredMessagesRef.current(messagesRef.current);
            }
          });

          // If reconnecting from previous disconnect, execute state catch-up
          if (isReconnectingRef.current) {
            isReconnectingRef.current = false;
            if (slug) {
              reconcileOnReconnect(slug);
            }
          }
        };

        const onDisconnect = (_reason: string) => {
          if (isCancelled) return;
          // Clear in-flight tracking so interrupted receipts can be retried on reconnect (Phase 2.2)
          inFlightDeliveredIdsRef.current.clear();
          inFlightReadIdsRef.current.clear();
          if (deliberatelyClosedRef.current) {
            setConnectionStatus("disconnected");
            setOnlineMemberIds(new Set());
            return;
          }
          isReconnectingRef.current = true;
          setConnectionStatus("disconnected");
          setOnlineMemberIds(new Set());
        };

        const onConnectError = (err: Error & { data?: unknown }) => {
          if (isCancelled) return;
          const rawMsg = err.message || "";
          const lowerMsg = rawMsg.toLowerCase();
          // Check for fatal authorization / handshake rejection
          const isFatal =
            FATAL_ERROR_CODES.has(rawMsg) ||
            lowerMsg.includes("unauthorized") ||
            lowerMsg.includes("forbidden") ||
            lowerMsg.includes("origin") ||
            lowerMsg.includes("401") ||
            lowerMsg.includes("403");

          if (isFatal) {
            setConnectionStatus("fatal_error");
            deliberatelyClosedRef.current = true;
            socket?.disconnect();
          } else {
            setConnectionStatus("reconnecting");
          }
        };

        const onChatMessage = (payload: ChatMessagePayload) => {
          if (payload.roomId !== roomId) return;
          const msg = payload.message;

          const newItem: ChatMessageItem = {
            id: msg.id,
            clientMsgId: msg.clientMsgId || msg.id,
            roomId: msg.roomId,
            authorId: msg.authorId,
            authorName: msg.authorName,
            seq: msg.seq,
            text: msg.text,
            ts: msg.ts,
            kind: msg.kind,
            status: "sent",
            opId: msg.opId,
            recipientIds: msg.recipientIds || [],
            excludedRecipientIds: msg.excludedRecipientIds || [],
            deliveredTo: msg.deliveredTo || [],
            readBy: msg.readBy || [],
          };

          // Automatically acknowledge delivery for messages sent by others via reliable protocol (Phase 1 & 2)
          const curMember = currentMemberRef.current;
          const isOwn =
            curMember &&
            (msg.authorId === curMember.id ||
              (curMember as { memberId?: string }).memberId === msg.authorId);
          if (!isOwn && socket?.connected) {
            markMessageDelivered(msg.id, msg.seq);
          }

          // If catch-up REST refresh is running, buffer live event
          if (isCatchingUpRef.current) {
            liveBufferRef.current.push(newItem);
            return;
          }

          // Same-socket echo-before-ack deduplication
          setMessages((prev) => {
            // Check if matches optimistic message by clientMsgId
            const existingIndex = prev.findIndex(
              (m) => m.clientMsgId === newItem.clientMsgId
            );
            if (existingIndex !== -1) {
              // Clear ack timer since message was confirmed by echo
              const timer = ackTimersRef.current.get(newItem.clientMsgId);
              if (timer) {
                clearTimeout(timer);
                ackTimersRef.current.delete(newItem.clientMsgId);
              }
              const updated = [...prev];
              updated[existingIndex] = newItem;
              return updated;
            }

            // Dedupe by seq if already present
            if (newItem.seq !== undefined && prev.some((m) => m.seq === newItem.seq)) {
              return prev;
            }

            return [...prev, newItem];
          });
        };

        const onChatDelivered = (payload: {
          roomId: string;
          messageId: string;
          seq?: number;
          memberId: string;
        }) => {
          if (payload.roomId !== roomId) return;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === payload.messageId || (m.seq && m.seq === payload.seq)) {
                const currentDelivered = new Set(m.deliveredTo || []);
                currentDelivered.add(payload.memberId);
                return { ...m, deliveredTo: Array.from(currentDelivered) };
              }
              return m;
            })
          );
        };

        const onChatRead = (payload: {
          roomId: string;
          messageId: string;
          seq?: number;
          memberId: string;
        }) => {
          if (payload.roomId !== roomId) return;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === payload.messageId || (m.seq && m.seq === payload.seq)) {
                const currentRead = new Set(m.readBy || []);
                currentRead.add(payload.memberId);
                const currentDelivered = new Set(m.deliveredTo || []);
                currentDelivered.add(payload.memberId);
                return {
                  ...m,
                  readBy: Array.from(currentRead),
                  deliveredTo: Array.from(currentDelivered),
                };
              }
              return m;
            })
          );
        };

        const onPresenceSnapshot = (payload: PresenceSnapshotPayload) => {
          if (payload.roomId !== roomId) return;
          const onlineIds = new Set<string>();
          for (const m of payload.members) {
            if (m.isOnline) {
              if (m.memberId) onlineIds.add(m.memberId);
              if ((m as { memberDocId?: string }).memberDocId) {
                onlineIds.add((m as { memberDocId?: string }).memberDocId!);
              }
            }
          }
          setOnlineMemberIds(onlineIds);
          callbacksRef.current.onPresenceSnapshot?.(payload);
        };

        const onPresenceStatus = (payload: PresenceStatusPayload) => {
          if (payload.roomId !== roomId) return;
          setOnlineMemberIds((prev) => {
            const next = new Set(prev);
            const docId = (payload as { memberDocId?: string }).memberDocId;
            if (payload.isOnline) {
              if (payload.memberId) next.add(payload.memberId);
              if (docId) next.add(docId);
            } else {
              if (payload.memberId) next.delete(payload.memberId);
              if (docId) next.delete(docId);
            }
            return next;
          });
          callbacksRef.current.onPresenceStatus?.(payload);
        };

        const onRoomMemberJoined = (payload: RoomMemberJoinedPayload) => {
          if (!payload || typeof payload !== "object") return;
          if (payload.roomId !== roomId) return;
          if (!payload.member || typeof payload.member !== "object") return;
          const memberId =
            typeof payload.member.memberId === "string"
              ? payload.member.memberId.trim()
              : "";
          if (!memberId) return;
          setOnlineMemberIds((prev) => new Set(prev).add(memberId));
          callbacksRef.current.onMemberJoined?.(payload.member);
        };

        const onRoomMemberLeft = (payload: RoomMemberLeftPayload) => {
          if (payload.roomId !== roomId) return;
          setOnlineMemberIds((prev) => {
            const next = new Set(prev);
            next.delete(payload.memberId);
            return next;
          });

          callbacksRef.current.onMemberLeft?.(payload.memberId, payload.reason);

          // Check if current member was removed or kicked
          if (payload.reason === "removed" || payload.reason === "kicked") {
            const isMe =
              currentMember &&
              (payload.memberId === currentMember.id ||
                (currentMember as { memberId?: string }).memberId === payload.memberId);
            if (isMe) {
              teardownOnTerminalEvent();
              callbacksRef.current.onMemberRemoved?.(payload.memberId);
            }
          }
        };

        const onRoomRoleChanged = (payload: RoomRoleChangedPayload) => {
          if (payload.roomId !== roomId) return;
          callbacksRef.current.onRoleChanged?.(payload.role, payload.memberId);
        };

        const onRoomStatusChanged = (payload: RoomStatusChangedPayload) => {
          if (payload.roomId !== roomId) return;
          if (payload.status === "ended") {
            setIsRoomEnded(true);
            callbacksRef.current.onRoomEnded?.();
          }
        };

        const onRoomDeleted = (payload: RoomDeletedPayload) => {
          if (payload.roomId !== roomId) return;
          teardownOnTerminalEvent();
          callbacksRef.current.onRoomDeleted?.();
        };

        const onRoomError = (error: EventErrorDto) => {
          if (FATAL_ERROR_CODES.has(error.code)) {
            setConnectionStatus("fatal_error");
            teardownOnTerminalEvent();
          } else if (
            error.code === "RATE_LIMITED" &&
            typeof error.retryAfter === "number"
          ) {
            triggerRateLimitCountdown(error.retryAfter);
          }
        };

        // Attach listeners
        socket.on("connect", onConnect);
        socket.on("disconnect", onDisconnect);
        socket.on("connect_error", onConnectError);
        socket.on("chat:message", onChatMessage);
        socket.on("chat:delivered", onChatDelivered);
        socket.on("chat:read", onChatRead);
        socket.on("presence:snapshot", onPresenceSnapshot);
        socket.on("presence:status", onPresenceStatus);
        socket.on("room:member_joined", onRoomMemberJoined);
        socket.on("room:member_left", onRoomMemberLeft);
        socket.on("room:role_changed", onRoomRoleChanged);
        socket.on("room:status_changed", onRoomStatusChanged);
        socket.on("room:deleted", onRoomDeleted);
        socket.on("room:error", onRoomError);

        // Store teardown cleanup handler
        return () => {
          socket?.off("connect", onConnect);
          socket?.off("disconnect", onDisconnect);
          socket?.off("connect_error", onConnectError);
          socket?.off("chat:message", onChatMessage);
          socket?.off("chat:delivered", onChatDelivered);
          socket?.off("chat:read", onChatRead);
          socket?.off("presence:snapshot", onPresenceSnapshot);
          socket?.off("presence:status", onPresenceStatus);
          socket?.off("room:member_joined", onRoomMemberJoined);
          socket?.off("room:member_left", onRoomMemberLeft);
          socket?.off("room:role_changed", onRoomRoleChanged);
          socket?.off("room:status_changed", onRoomStatusChanged);
          socket?.off("room:deleted", onRoomDeleted);
          socket?.off("room:error", onRoomError);
        };
      } catch (err) {
        console.error("Failed to initialize Socket.IO client:", err);
        return undefined;
      }
    }

    const cleanupListenersPromise = initSocket();

    return () => {
      isCancelled = true;
      deliberatelyClosedRef.current = true;

      // Clear all active ack timers
      for (const timer of ackTimersRef.current.values()) {
        clearTimeout(timer);
      }
      ackTimersRef.current.clear();

      if (rateLimitTimerRef.current) {
        clearInterval(rateLimitTimerRef.current);
      }

      cleanupListenersPromise.then((removeListeners) => {
        if (typeof removeListeners === "function") {
          removeListeners();
        }
      });

      if (socket) {
        socket.disconnect();
      }
      socketRef.current = null;
      setConnectionStatus("disconnected");
    };
  }, [
    enabled,
    roomId,
    slug,
    currentMemberId,
    serverUrl,
    fetchChatHistory,
    reconcileOnReconnect,
    teardownOnTerminalEvent,
    triggerRateLimitCountdown,
  ]);

  return {
    connectionStatus,
    messages,
    onlineMemberIds,
    isRateLimited,
    rateLimitCountdown,
    isRoomEnded,
    isLoadingHistory,
    loadHistoryError,
    hasEarlierMessages,
    sendMessage,
    retryMessage,
    markMessageDelivered,
    markMessageRead,
    refetchHistory,
    socketRef,
  };
}
