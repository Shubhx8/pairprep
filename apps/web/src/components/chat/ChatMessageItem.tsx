import React from "react";
import type { ChatMessageItem as ChatMessageType } from "../../hooks/useRoomSocket.js";
import { RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface ChatMessageItemProps {
  message: ChatMessageType;
  isOwn: boolean;
  onRetry?: (clientMsgId: string) => void;
}

export function ChatMessageItem({ message, isOwn, onRetry }: ChatMessageItemProps) {
  const formattedTime = React.useMemo(() => {
    try {
      const date = new Date(message.ts);
      if (isNaN(date.getTime())) return "";
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }, [message.ts]);

  // System message rendering: centered, distinct muted styling (CH-3)
  if (message.kind === "system") {
    return (
      <div
        className="flex justify-center my-2 px-3 py-1.5"
        role="status"
        data-testid={`system-message-${message.id}`}
      >
        <div className="bg-surface-hover/60 border border-border-subtle/60 rounded-full px-3 py-1 text-xs text-text-subtle font-mono text-center max-w-[90%] break-words">
          <span>{message.text}</span>
          {formattedTime && (
            <span className="ml-2 text-[10px] opacity-75">{formattedTime}</span>
          )}
        </div>
      </div>
    );
  }

  // User message: Plain text only. React escapes all text node strings (no dangerouslySetInnerHTML, no HTML execution)
  return (
    <div
      className={cn(
        "flex flex-col my-2 max-w-[85%] group",
        isOwn ? "ml-auto items-end" : "mr-auto items-start"
      )}
      data-testid={`chat-message-${message.id}`}
      data-author={isOwn ? "own" : "other"}
    >
      <div className="flex items-center gap-1.5 mb-1 px-1 text-xs text-text-subtle font-medium">
        <span>{isOwn ? "You" : message.authorName || "Anonymous"}</span>
        {formattedTime && (
          <span className="text-[10px] text-text-subtle/70">{formattedTime}</span>
        )}
      </div>

      <div
        className={cn(
          "px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words shadow-xs border select-text",
          isOwn
            ? "bg-primary/15 text-text-primary border-primary/30 rounded-tr-xs"
            : "bg-surface text-text-primary border-border-subtle rounded-tl-xs",
          message.status === "sending" && "opacity-70",
          message.status === "failed" && "border-destructive/50 bg-destructive/10"
        )}
      >
        <p className="whitespace-pre-wrap font-sans">{message.text}</p>
      </div>

      {/* Message status feedback for own messages */}
      {isOwn && (
        <div className="flex items-center gap-1 mt-1 px-1 text-[11px] text-text-subtle">
          {message.status === "sending" && (
            <span
              className="inline-flex items-center gap-1 text-text-subtle"
              aria-label="Sending message"
            >
              <Clock className="h-3 w-3 animate-spin" />
              <span>Sending...</span>
            </span>
          )}

          {message.status === "failed" && (
            <div className="flex items-center gap-1 text-destructive-text">
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
      )}
    </div>
  );
}
