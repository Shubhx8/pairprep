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

export interface ChatPanelProps {
  messages: ChatMessageType[];
  currentUserId: string;
  isOpen: boolean;
  onToggle: () => void;
  onSendMessage: (text: string) => Promise<string | null>;
  onRetryMessage?: (clientMsgId: string) => Promise<void>;
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
  className?: string;
}

export function ChatPanel({
  messages,
  currentUserId,
  isOpen,
  onToggle,
  onSendMessage,
  onRetryMessage,
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
  className,
}: ChatPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [hasNewMessagesWhileScrolledUp, setHasNewMessagesWhileScrolledUp] =
    useState(false);
  const [, setUnreadCount] = useState(0);
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");

  // Track previously known message IDs to announce ONLY newly incoming messages from others
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);

  // Check user preference for reduced motion
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // Reset unread count when panel opens
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      onUnreadCountChange?.(0);
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
  }, [isOpen, triggerRef, onUnreadCountChange]);

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
    let latestNewFromOtherText = "";
    let latestNewFromOtherAuthor = "";

    messages.forEach((m) => {
      const key = m.id || m.clientMsgId;
      if (!knownMessageIdsRef.current.has(key)) {
        knownMessageIdsRef.current.add(key);

        // Only messages from OTHERS are announced (never announce own echoes)
        if (m.authorId !== currentUserId) {
          hasNewFromOther = true;
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
        setUnreadCount((prev) => {
          const next = prev + 1;
          onUnreadCountChange?.(next);
          return next;
        });
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

  // Keyboard navigation: Escape key closes panel and restores focus
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onToggle();
      }
    },
    [onToggle]
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
    return null;
  }

  return (
    <aside
      aria-label="Room chat"
      onKeyDown={handleKeyDown}
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-text-primary">Room Chat</h2>
          {/* Connection state dot */}
          <span
            className="flex items-center"
            title={`Status: ${connectionStatus}`}
            data-testid={`connection-indicator-${connectionStatus}`}
          >
            {connectionStatus === "connected" ? (
              <span
                className="flex h-2 w-2 rounded-full bg-success"
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
          onClick={onToggle}
          aria-label="Close chat panel"
          className="h-8 w-8 text-text-subtle hover:text-text-primary"
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
        className="flex-1 overflow-y-auto p-4 space-y-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          <div className="space-y-3 py-2" data-testid="chat-history-skeletons">
            <Skeleton className="h-10 w-3/4 rounded-2xl" />
            <Skeleton className="h-14 w-2/3 ml-auto rounded-2xl" />
            <Skeleton className="h-10 w-1/2 rounded-2xl" />
            <Skeleton className="h-12 w-3/5 ml-auto rounded-2xl" />
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

        {/* Messages list */}
        {!isLoadingHistory &&
          !loadHistoryError &&
          messages.map((message) => (
            <ChatMessageItem
              key={message.id || message.clientMsgId}
              message={message}
              isOwn={message.authorId === currentUserId}
              onRetry={onRetryMessage}
            />
          ))}

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
