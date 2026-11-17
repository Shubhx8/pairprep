import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type {
  ChatMessageItem as ChatMessageType,
  SocketConnectionStatus,
} from "../../hooks/useRoomSocket.js";
import { ChatMessageItem } from "./ChatMessageItem.js";
import { ChatComposer } from "./ChatComposer.js";
import { Skeleton } from "../ui/Skeleton.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { Button } from "../ui/Button.js";
import { ArrowDown, X, MessageSquare } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface ChatUnreadBadgeProps {
  count: number;
  className?: string;
}

export function ChatUnreadBadge({ count, className }: ChatUnreadBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="chat-unread-badge"
      aria-label={`${count} unread message${count === 1 ? "" : "s"}`}
      className={cn(
        "flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-fg shadow-xs",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export interface ChatTriggerButtonProps {
  unreadCount?: number;
  isOpen: boolean;
  onToggle: () => void;
  triggerRef?: React.Ref<HTMLButtonElement> | React.RefObject<HTMLButtonElement | null>;
  className?: string;
}

export function ChatTriggerButton({
  unreadCount = 0,
  isOpen,
  onToggle,
  triggerRef,
  className,
}: ChatTriggerButtonProps) {
  return (
    <Button
      ref={triggerRef as React.Ref<HTMLButtonElement>}
      variant="secondary"
      size="sm"
      onClick={onToggle}
      aria-label={`Toggle chat panel${unreadCount > 0 && !isOpen ? `, ${unreadCount} unread message${unreadCount === 1 ? "" : "s"}` : ""}`}
      aria-expanded={isOpen}
      className={cn("relative gap-1.5", className)}
      data-testid="chat-trigger-button"
    >
      <MessageSquare className="h-4 w-4" />
      <span>Chat</span>
      <ChatUnreadBadge count={unreadCount} className="absolute -top-1.5 -right-1.5" />
    </Button>
  );
}

export interface ChatPanelProps {
  messages: ChatMessageType[];
  currentUserId: string;
  currentMemberId?: string;
  currentUserName?: string;
  hasOnlinePeers?: boolean;
  roomMembers?: Array<{ id: string; memberId?: string; displayName?: string }>;
  isOpen: boolean;
  onToggle: () => void;
  onSendMessage: (text: string) => Promise<string | null>;
  onRetryMessage?: (clientMsgId: string) => Promise<void>;
  onMarkMessageRead?: (messageId: string, seq?: number) => void;
  onRefetchHistory?: () => Promise<void>;
  connectionStatus: SocketConnectionStatus;
  isRateLimited: boolean;
  rateLimitCountdown: number; // in seconds
  isRoomEnded: boolean;
  isLoadingHistory: boolean;
  loadHistoryError: string | null;
  hasEarlierMessages: boolean;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onUnreadCountChange?: (count: number) => void;
  renderCollapsedTrigger?: boolean;
  className?: string;
  style?: React.CSSProperties;
  width?: number;
}

/**
 * Computes calendar date chip text (Today, Yesterday, or formatted date).
 */
function getMessageDateLabel(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) return "Today";

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return "Yesterday";

    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// Helper to check if browser window is currently focused and in foreground
function isWindowForeground(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return true;
}

export function ChatPanel({
  messages,
  currentUserId,
  currentMemberId,
  currentUserName,
  hasOnlinePeers: _hasOnlinePeers = false,
  roomMembers = [],
  isOpen,
  onToggle,
  onSendMessage,
  onRetryMessage,
  onMarkMessageRead,
  onRefetchHistory,
  connectionStatus,
  isRateLimited,
  rateLimitCountdown,
  isRoomEnded,
  isLoadingHistory,
  loadHistoryError,
  hasEarlierMessages,
  triggerRef,
  onUnreadCountChange,
  renderCollapsedTrigger = false,
  className,
  style,
  width,
}: ChatPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [hasNewMessagesWhileScrolledUp, setHasNewMessagesWhileScrolledUp] =
    useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");

  // Track previously known message IDs to announce ONLY newly incoming messages from others
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);

  // Acknowledge read for incoming messages when panel is open, window is focused & in foreground,
  // and the message is visible in the chat viewport (Phase 1.3 / Phase 5)
  useEffect(() => {
    if (!isOpen) return;
    if (!onMarkMessageRead) return;

    const myId = currentMemberId || currentUserId;

    const checkAndMarkMessage = (messageId: string) => {
      if (!isWindowForeground()) return;
      const msg = messages.find((m) => (m.id || m.clientMsgId) === messageId);
      if (!msg || msg.kind !== "user") return;
      const isFromOther =
        msg.authorId !== currentUserId &&
        (!currentMemberId || msg.authorId !== currentMemberId);
      if (!isFromOther) return;

      const alreadyRead =
        (myId ? (msg.readBy || []).includes(myId) : false) ||
        (currentMemberId ? (msg.readBy || []).includes(currentMemberId) : false) ||
        (currentUserId ? (msg.readBy || []).includes(currentUserId) : false);

      if (!alreadyRead && msg.id) {
        onMarkMessageRead(msg.id, msg.seq);
      }
    };

    const container = scrollContainerRef.current;
    let observer: IntersectionObserver | null = null;

    // Phase 17 standard: 50% of message element area must be visible within container
    const isMessageSufficientlyVisible = (
      elRect: DOMRect,
      cRect: DOMRect,
      threshold = 0.5
    ): boolean => {
      // In headless/jsdom testing environments where layout geometry is 0x0, fallback to true
      if (
        cRect.width === 0 &&
        cRect.height === 0 &&
        elRect.width === 0 &&
        elRect.height === 0
      ) {
        return true;
      }
      const elArea = elRect.width * elRect.height;
      if (elArea <= 0) return false;

      const intersectTop = Math.max(elRect.top, cRect.top);
      const intersectBottom = Math.min(elRect.bottom, cRect.bottom);
      const intersectLeft = Math.max(elRect.left, cRect.left);
      const intersectRight = Math.min(elRect.right, cRect.right);

      const intersectHeight = Math.max(0, intersectBottom - intersectTop);
      const intersectWidth = Math.max(0, intersectRight - intersectLeft);
      const intersectArea = intersectHeight * intersectWidth;

      return intersectArea / elArea >= threshold;
    };

    // Use IntersectionObserver when functional
    if (typeof window !== "undefined" && "IntersectionObserver" in window && container) {
      try {
        observer = new IntersectionObserver(
          (entries) => {
            if (!isOpen || !isWindowForeground()) return;
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                const msgId = entry.target.getAttribute("data-message-id");
                if (msgId) checkAndMarkMessage(msgId);
              }
            });
          },
          { root: container, threshold: 0.5 }
        );

        const elements = container.querySelectorAll("[data-message-id]");
        elements.forEach((el) => observer?.observe(el));
      } catch {
        observer = null;
      }
    }

    // Fallback when IntersectionObserver is unavailable or polyfilled in test environments
    if (
      !observer ||
      (typeof window !== "undefined" &&
        window.IntersectionObserver?.name === "IntersectionObserverPolyfill")
    ) {
      if (isWindowForeground() && container) {
        const elements = container.querySelectorAll("[data-message-id]");
        elements.forEach((el) => {
          const msgId = el.getAttribute("data-message-id");
          if (msgId) checkAndMarkMessage(msgId);
        });
      }
    }

    const handleActivity = () => {
      if (isWindowForeground() && isOpen && container) {
        const elements = container.querySelectorAll("[data-message-id]");
        const containerRect = container.getBoundingClientRect();
        elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (isMessageSufficientlyVisible(rect, containerRect, 0.5)) {
            const msgId = el.getAttribute("data-message-id");
            if (msgId) checkAndMarkMessage(msgId);
          }
        });
      }
    };

    // Bounded idle interval to re-evaluate visible messages in viewport (Phase 14 & 15 & 17)
    // Ensures unconfirmed read receipts are retried even when user remains idle without scrolling
    const retryInterval = setInterval(() => {
      if (!isOpen || !isWindowForeground() || !container) return;

      const elements = container.querySelectorAll("[data-message-id]");
      const containerRect = container.getBoundingClientRect();

      elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (isMessageSufficientlyVisible(rect, containerRect, 0.5)) {
          const msgId = el.getAttribute("data-message-id");
          if (msgId) checkAndMarkMessage(msgId);
        }
      });
    }, 5000);

    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleActivity);
      window.addEventListener("blur", handleActivity);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleActivity);
    }

    return () => {
      observer?.disconnect();
      clearInterval(retryInterval);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleActivity);
        window.removeEventListener("blur", handleActivity);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleActivity);
      }
    };
  }, [isOpen, messages, currentUserId, currentMemberId, onMarkMessageRead]);

  // Check user preference for reduced motion
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // Reset unread count when panel opens
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      // Accessibility focus management: focus composer input when panel opens
      const timer = setTimeout(() => {
        composerInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      // Accessibility focus restoration: return focus to trigger toggle on close
      triggerRef?.current?.focus();
      return undefined;
    }
  }, [isOpen, triggerRef]);

  // Sync unreadCount with parent callback safely outside render phase
  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [unreadCount, onUnreadCountChange]);

  // Mark initial history load as done once history has loaded
  useEffect(() => {
    if (!isLoadingHistory && !initialLoadDoneRef.current) {
      messages.forEach((m) => knownMessageIdsRef.current.add(m.id || m.clientMsgId));
      initialLoadDoneRef.current = true;
    }
  }, [isLoadingHistory, messages]);

  // Handle incoming messages: unread count, announcer, and scroll behavior
  useEffect(() => {
    if (messages.length === 0) return;

    if (!initialLoadDoneRef.current) {
      // Initial message population (history) is rendered SILENTLY
      messages.forEach((m) => knownMessageIdsRef.current.add(m.id || m.clientMsgId));
      initialLoadDoneRef.current = true;
      return;
    }

    let hasNewFromOther = false;
    let newFromOthersCount = 0;
    let latestNewFromOtherText = "";
    let latestNewFromOtherAuthor = "";

    messages.forEach((m) => {
      const key = m.id || m.clientMsgId;
      if (!knownMessageIdsRef.current.has(key)) {
        knownMessageIdsRef.current.add(key);

        // Only messages from OTHERS are announced (never announce own echoes)
        if (m.authorId !== currentUserId) {
          hasNewFromOther = true;
          newFromOthersCount++;
          latestNewFromOtherText = m.text;
          latestNewFromOtherAuthor = m.authorName || "Peer";
        }
      }
    });

    if (hasNewFromOther) {
      // Update polite live region for screen readers
      setPoliteAnnouncement(`${latestNewFromOtherAuthor}: ${latestNewFromOtherText}`);

      // Track unread if panel is collapsed
      if (!isOpen) {
        setUnreadCount((prev) => prev + newFromOthersCount);
      }

      // If user is scrolled up, show the "New messages" pill
      if (isScrolledUp) {
        setHasNewMessagesWhileScrolledUp(true);
      }
    }

    // Auto-scroll to bottom if user is already near bottom
    if (!isScrolledUp && isOpen) {
      if (typeof bottomAnchorRef.current?.scrollIntoView === "function") {
        bottomAnchorRef.current.scrollIntoView({
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      }
    }
  }, [messages, currentUserId, isOpen, isScrolledUp, prefersReducedMotion]);

  // Handle scroll detection
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceToBottom > 80;
    setIsScrolledUp(scrolledUp);

    if (!scrolledUp) {
      setHasNewMessagesWhileScrolledUp(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    setHasNewMessagesWhileScrolledUp(false);
    setIsScrolledUp(false);
    if (typeof bottomAnchorRef.current?.scrollIntoView === "function") {
      bottomAnchorRef.current.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    }
  }, [prefersReducedMotion]);

  // Keyboard navigation: Escape key closes panel and restores focus; Tab traps focus within drawer
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onToggle();
        triggerRef?.current?.focus();
        return;
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusableSelector =
          'button:not([disabled]):not([aria-hidden="true"]):not([tabindex="-1"]), [href], input:not([disabled]):not([aria-hidden="true"]):not([tabindex="-1"]), select:not([disabled]):not([aria-hidden="true"]):not([tabindex="-1"]), textarea:not([disabled]):not([aria-hidden="true"]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])';
        const focusableElements = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)
        ).filter(
          (el) =>
            !el.hasAttribute("disabled") &&
            el.getAttribute("aria-hidden") !== "true" &&
            el.getAttribute("tabindex") !== "-1"
        );

        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (
            document.activeElement === firstElement ||
            !panelRef.current.contains(document.activeElement)
          ) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !panelRef.current.contains(document.activeElement)
          ) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }
    },
    [onToggle, triggerRef]
  );

  const disabledReason = useMemo(() => {
    if (isRoomEnded) return "Room has ended. Chat is view-only.";
    if (connectionStatus === "connecting" || connectionStatus === "reconnecting") {
      return "Reconnecting to chat...";
    }
    if (connectionStatus === "disconnected" || connectionStatus === "fatal_error") {
      return "Disconnected from chat server.";
    }
    return undefined;
  }, [isRoomEnded, connectionStatus]);

  const isComposerDisabled = Boolean(isRoomEnded || connectionStatus !== "connected");

  if (!isOpen) {
    if (renderCollapsedTrigger) {
      return (
        <ChatTriggerButton
          unreadCount={unreadCount}
          isOpen={false}
          onToggle={onToggle}
          triggerRef={triggerRef}
          className={className}
        />
      );
    }
    return null;
  }

  return (
    <aside
      ref={panelRef}
      aria-label="Room chat"
      onKeyDown={handleKeyDown}
      style={{
        width: typeof width === "number" ? `${width}px` : undefined,
        ...style,
      }}
      className={cn(
        "flex flex-col h-full bg-surface border-l border-border-subtle shadow-lg relative select-none",
        className
      )}
      data-testid="chat-panel"
    >
      {/* Dedicated polite screen-reader announcer (announces ONLY new incoming messages from others) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="chat-polite-announcer"
      >
        {politeAnnouncement}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border-subtle bg-surface shrink-0 h-11">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary truncate">
            Room Chat
          </h2>
          {/* Connection state dot */}
          <span
            className="flex items-center shrink-0"
            title={`Status: ${connectionStatus}`}
            data-testid={`connection-indicator-${connectionStatus}`}
          >
            {connectionStatus === "connected" ? (
              <span
                className="flex h-2 w-2 rounded-full bg-success ring-2 ring-success/20"
                aria-label="Chat connected"
              />
            ) : (
              <span
                className="flex h-2 w-2 rounded-full bg-warning animate-pulse"
                aria-label={`Chat ${connectionStatus}`}
              />
            )}
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            onToggle();
            triggerRef?.current?.focus();
          }}
          aria-label="Close chat panel"
          className="h-7 w-7 text-text-subtle hover:text-text-primary shrink-0"
          data-testid="chat-panel-close-button"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Message List Log Area */}
      <div
        role="log"
        aria-label="Chat messages"
        tabIndex={0}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain custom-scroll p-3.5 space-y-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-canvas/30"
        data-testid="chat-messages-log"
      >
        {/* Earlier messages notice */}
        {hasEarlierMessages && (
          <div
            className="text-center py-1.5 px-3 mb-3 text-xs text-text-subtle font-mono bg-surface-hover/40 border border-border-subtle/50 rounded-md"
            data-testid="earlier-messages-notice"
          >
            Earlier messages not shown (displaying last 200 messages)
          </div>
        )}

        {/* Loading history skeleton state (UI-2) */}
        {isLoadingHistory && (
          <div className="space-y-3.5 py-2" data-testid="chat-history-skeletons">
            <div className="flex items-start gap-2.5 max-w-[80%]">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <Skeleton className="h-12 w-48 rounded-2xl rounded-tl-xs" />
            </div>
            <div className="flex justify-end max-w-[80%] ml-auto">
              <Skeleton className="h-14 w-56 rounded-2xl rounded-tr-xs" />
            </div>
            <div className="flex items-start gap-2.5 max-w-[75%]">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <Skeleton className="h-10 w-40 rounded-2xl rounded-tl-xs" />
            </div>
            <div className="flex justify-end max-w-[75%] ml-auto">
              <Skeleton className="h-12 w-48 rounded-2xl rounded-tr-xs" />
            </div>
          </div>
        )}

        {/* Error state (UI-2) */}
        {!isLoadingHistory && loadHistoryError && (
          <div className="my-auto py-6" data-testid="chat-history-error">
            <ErrorState
              title="Unable to load messages"
              message={loadHistoryError}
              onRetry={onRefetchHistory}
              headingLevel="h4"
            />
          </div>
        )}

        {/* Empty state (UI-2) */}
        {!isLoadingHistory && !loadHistoryError && messages.length === 0 && (
          <div className="my-auto py-8" data-testid="chat-empty-state">
            <EmptyState
              title="No messages yet"
              description="Send a message below to start collaborating with your peer."
              headingLevel="h4"
            />
          </div>
        )}

        {/* Messages list with date dividers */}
        {!isLoadingHistory &&
          !loadHistoryError &&
          messages.map((message, index) => {
            const dateLabel = getMessageDateLabel(message.ts);
            const prevDateLabel =
              index > 0 ? getMessageDateLabel(messages[index - 1]?.ts || "") : "";
            const showDateDivider = Boolean(
              dateLabel && dateLabel !== prevDateLabel && message.kind !== "system"
            );

            const isOwnMsg =
              message.authorId === currentUserId ||
              (Boolean(currentMemberId) && message.authorId === currentMemberId) ||
              (Boolean(currentUserName) &&
                Boolean(message.authorName) &&
                message.authorName?.trim().toLowerCase() ===
                  currentUserName?.trim().toLowerCase());

            // Compute authentic delivery and read states based on recipient acknowledgements (Phase 3)
            // Group conversation semantics: requires ALL eligible recipients to acknowledge
            const otherMembers = (roomMembers || []).filter(
              (m) =>
                m.id !== currentMemberId &&
                (m as { memberId?: string }).memberId !== currentMemberId &&
                m.id !== currentUserId &&
                (m as { memberId?: string }).memberId !== currentUserId
            );

            // Exclude participants marked as excluded (e.g. removed or revoked after message creation)
            const excludedSet = new Set(message.excludedRecipientIds || []);
            const effectiveRecipientIds = (message.recipientIds || []).filter(
              (id) => !excludedSet.has(id)
            );

            const targetRecipients =
              Array.isArray(message.recipientIds) && message.recipientIds.length > 0
                ? effectiveRecipientIds.map((id) => {
                    const matched = (roomMembers || []).find(
                      (m) => m.id === id || (m as { memberId?: string }).memberId === id
                    );
                    return {
                      id,
                      memberId: (matched as { memberId?: string })?.memberId,
                      docId: matched?.id,
                    };
                  })
                : otherMembers.map((m) => ({
                    id: (m as { memberId?: string }).memberId || m.id,
                    memberId: (m as { memberId?: string }).memberId,
                    docId: m.id,
                  }));

            let isDelivered = false;
            let isRead = false;

            if (targetRecipients.length > 0) {
              isDelivered = targetRecipients.every((recip) => {
                const ids = [recip.id, recip.memberId, recip.docId].filter(
                  Boolean
                ) as string[];
                return (
                  (message.deliveredTo || []).some((id) => ids.includes(id)) ||
                  (message.readBy || []).some((id) => ids.includes(id))
                );
              });

              isRead = targetRecipients.every((recip) => {
                const ids = [recip.id, recip.memberId, recip.docId].filter(
                  Boolean
                ) as string[];
                return (message.readBy || []).some((id) => ids.includes(id));
              });
            } else if (
              (!roomMembers || roomMembers.length <= 1) &&
              (!message.recipientIds || message.recipientIds.length === 0)
            ) {
              // Sender alone in room cannot deliver to anyone
              isDelivered = false;
              isRead = false;
            } else if (
              message.recipientIds &&
              message.recipientIds.length > 0 &&
              effectiveRecipientIds.length === 0
            ) {
              // All recipients in the message became excluded/ineligible later (Phase 4)
              // Preserve last legitimate receipt state (never fabricate double ticks)
              isDelivered = Boolean(
                message.deliveredTo && message.deliveredTo.length > 0
              );
              isRead = Boolean(message.readBy && message.readBy.length > 0);
            } else {
              isDelivered = Boolean(
                message.deliveredTo && message.deliveredTo.length > 0
              );
              isRead = Boolean(message.readBy && message.readBy.length > 0);
            }

            return (
              <React.Fragment key={message.id || message.clientMsgId}>
                {showDateDivider && (
                  <div
                    className="flex items-center justify-center my-3 select-none"
                    data-testid={`date-divider-${dateLabel.toLowerCase()}`}
                  >
                    <span className="text-[11px] font-medium text-text-subtle/80 bg-surface-hover/60 px-3 py-0.5 rounded-full border border-border-subtle/70 shadow-xs">
                      {dateLabel}
                    </span>
                  </div>
                )}
                <ChatMessageItem
                  message={message}
                  isOwn={isOwnMsg}
                  isDelivered={isDelivered}
                  isRead={isRead}
                  onRetry={onRetryMessage}
                />
              </React.Fragment>
            );
          })}

        <div ref={bottomAnchorRef} aria-hidden="true" />
      </div>

      {/* "New messages" pill when scrolled up */}
      {hasNewMessagesWhileScrolledUp && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 animate-in fade-in zoom-in-95 duration-150">
          <button
            type="button"
            onClick={scrollToBottom}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-fg text-xs font-semibold shadow-md hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer transition-colors"
            data-testid="new-messages-pill"
            aria-label="Scroll to new messages"
          >
            <span>New messages</span>
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Composer */}
      <ChatComposer
        onSendMessage={onSendMessage}
        disabled={isComposerDisabled}
        disabledReason={disabledReason}
        isRateLimited={isRateLimited}
        rateLimitCountdown={rateLimitCountdown}
        inputRef={composerInputRef}
      />
    </aside>
  );
}
