import React from "react";
import type { ChatMessageItem as ChatMessageType } from "../../hooks/useRoomSocket.js";
import { RefreshCw, Clock, AlertTriangle, Check, CheckCheck } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { PARTICIPANT_PALETTE } from "@pairprep/shared";

export interface ChatMessageItemProps {
  message: ChatMessageType;
  isOwn: boolean;
  isDelivered?: boolean;
  isRead?: boolean;
  hasOnlinePeers?: boolean;
  onRetry?: (clientMsgId: string) => void;
}

export function ChatMessageItem({
  message,
  isOwn,
  isDelivered = false,
  isRead = false,
  onRetry,
}: ChatMessageItemProps) {
  const formattedTime = React.useMemo(() => {
    try {
      const date = new Date(message.ts);
      if (isNaN(date.getTime())) return "";
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }, [message.ts]);

  // Deterministic color for peer author name
  const authorColor = React.useMemo(() => {
    const key = message.authorId || message.authorName || "anonymous";
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % PARTICIPANT_PALETTE.length;
    return PARTICIPANT_PALETTE[index] || (PARTICIPANT_PALETTE[0] as string);
  }, [message.authorId, message.authorName]);

  // Delivery status calculation conforming to WhatsApp protocol:
  // 1. sending: spinning clock icon
  // 2. failed: error triangle + retry action
  // 3. read: double blue tick (✓✓ in WhatsApp Blue) when viewed/read by recipient(s)
  // 4. delivered: double gray tick (✓✓) when delivered to recipient(s)
  // 5. sent: single gray tick (✓) confirmed on server, awaiting delivery
  const deliveryState = React.useMemo(() => {
    if (message.status === "sending") return "sending";
    if (message.status === "failed") return "failed";

    if (isRead) {
      return "read"; // Double blue tick (confirmed read by all recipients)
    }

    if (isDelivered) {
      return "delivered"; // Double gray tick (confirmed delivered to all recipients)
    }

    return "sent"; // Single gray tick (confirmed on server, pending delivery)
  }, [message.status, isDelivered, isRead]);

  // System message rendering: centered, distinct muted styling (CH-3)
  if (message.kind === "system") {
    return (
      <div
        className="flex justify-center my-2 px-3 py-1"
        role="status"
        data-testid={`system-message-${message.id}`}
      >
        <div className="bg-surface-hover/70 border border-border-subtle/70 rounded-full px-3 py-0.5 text-xs text-text-subtle font-mono text-center max-w-[90%] break-words shadow-xs">
          <span>{message.text}</span>
          {formattedTime && (
            <span className="ml-2 text-[10px] opacity-75 font-sans">{formattedTime}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col my-1.5 max-w-[85%] group transition-all",
        isOwn ? "ml-auto items-end" : "mr-auto items-start"
      )}
      data-testid={`chat-message-${message.id}`}
      data-author={isOwn ? "own" : "other"}
      data-message-id={message.id || message.clientMsgId}
    >
      {/* Header: Name (You or Peer Name in distinct color) */}
      <div className="flex items-center gap-1.5 mb-0.5 px-1 text-xs">
        {isOwn ? (
          <span className="font-semibold text-text-secondary text-[11px]">You</span>
        ) : (
          <span
            className="font-semibold text-xs tracking-tight"
            style={{ color: authorColor }}
          >
            {message.authorName || "Anonymous"}
          </span>
        )}
      </div>

      {/* Bubble container - compact w-fit WhatsApp inspired styling */}
      <div
        className={cn(
          "w-fit max-w-full px-3.5 py-1.5 rounded-2xl text-sm leading-relaxed break-words shadow-xs select-text transition-all",
          isOwn
            ? "bg-primary text-primary-fg rounded-tr-xs font-normal"
            : "bg-surface text-text-primary border border-border-subtle hover:border-border-subtle/80 rounded-tl-xs",
          message.status === "sending" && "opacity-80",
          message.status === "failed" &&
            "border border-destructive/50 bg-destructive text-destructive-fg"
        )}
      >
        {/* Message text */}
        <p className="whitespace-pre-wrap font-sans inline">{message.text}</p>

        {/* WhatsApp-style Timestamp and Single / Double / Blue Tick inside the bubble */}
        <span className="inline-flex items-center gap-1 ml-2.5 float-right mt-1 text-[10px] select-none">
          <span
            className={cn(
              "font-mono text-[10px]",
              isOwn ? "text-primary-fg/80" : "text-text-subtle/70"
            )}
          >
            {formattedTime}
          </span>

          {isOwn && (
            <span className="inline-flex items-center">
              {deliveryState === "sending" && (
                <Clock
                  className="h-3 w-3 animate-spin text-primary-fg/70"
                  aria-label="Sending message"
                />
              )}

              {deliveryState === "failed" && (
                <AlertTriangle
                  className="h-3 w-3 text-destructive-fg"
                  aria-label="Failed to send"
                />
              )}

              {deliveryState === "sent" && (
                /* WhatsApp Single Tick (✓): Server received & stored, awaiting recipient delivery */
                <Check
                  className="h-3.5 w-3.5 text-primary-fg/75"
                  aria-label="Sent"
                  data-testid={`tick-single-${message.id || message.clientMsgId}`}
                />
              )}

              {deliveryState === "delivered" && (
                /* WhatsApp Double Gray Tick (✓✓): Delivered to recipient(s) */
                <CheckCheck
                  className="h-3.5 w-3.5 text-primary-fg/75"
                  aria-label="Delivered"
                  data-testid={`tick-delivered-${message.id || message.clientMsgId}`}
                />
              )}

              {deliveryState === "read" && (
                /* WhatsApp Double Blue Tick (✓✓ in Blue): Viewed by peers */
                <CheckCheck
                  className="h-3.5 w-3.5"
                  style={{ color: PARTICIPANT_PALETTE[0] }}
                  aria-label="Read"
                  data-testid={`tick-read-${message.id || message.clientMsgId}`}
                />
              )}
            </span>
          )}
        </span>
      </div>

      {/* Failed retry action */}
      {isOwn && message.status === "failed" && (
        <div className="flex items-center gap-1 mt-1 px-1 text-[11px] text-destructive-text">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          <span>Failed to send</span>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.clientMsgId)}
              className="inline-flex items-center gap-0.5 ml-1 font-semibold underline hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded cursor-pointer"
              aria-label={`Retry sending: ${message.text}`}
              data-testid={`retry-button-${message.clientMsgId}`}
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
