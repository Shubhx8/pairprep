import React, { useState, useCallback, useId } from "react";
import { Send, Clock, Code } from "lucide-react";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/utils.js";

export const MAX_CHAT_GRAPHEMES = 1000;
export const MAX_CHAT_BYTES = 4000;

const QUICK_REACTIONS = ["👍", "👏", "🚀", "💡", "❓"];

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Counts user-perceived characters (grapheme clusters) using Intl.Segmenter.
 * Falls back to Array.from(str).length if Intl.Segmenter is unavailable.
 */
export function countGraphemes(text: string): number {
  if (!text) return 0;
  if (segmenter) {
    return Array.from(segmenter.segment(text)).length;
  }
  return Array.from(text).length;
}

/**
 * Counts UTF-8 byte length using TextEncoder.
 */
export function countBytes(text: string): number {
  if (!text) return 0;
  return new TextEncoder().encode(text).length;
}

export interface ChatComposerProps {
  onSendMessage: (text: string) => Promise<string | null>;
  disabled?: boolean;
  disabledReason?: string;
  isRateLimited?: boolean;
  rateLimitCountdown?: number; // in seconds
  inputRef?: React.Ref<HTMLTextAreaElement>;
  className?: string;
}

export function ChatComposer({
  onSendMessage,
  disabled = false,
  disabledReason,
  isRateLimited = false,
  rateLimitCountdown = 0,
  inputRef,
  className,
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaId = useId();

  const graphemeCount = countGraphemes(text);
  const byteCount = countBytes(text);

  const isOverGraphemeLimit = graphemeCount > MAX_CHAT_GRAPHEMES;
  const isOverByteLimit = byteCount > MAX_CHAT_BYTES;
  const isOverLimit = isOverGraphemeLimit || isOverByteLimit;

  const isEffectivelyDisabled = disabled || isRateLimited || isSubmitting;
  const canSend = !isEffectivelyDisabled && !isOverLimit && text.trim().length > 0;

  const handleSend = useCallback(async () => {
    if (!canSend) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      setIsSubmitting(true);
      await onSendMessage(trimmed);
      setText("");
    } finally {
      setIsSubmitting(false);
    }
  }, [canSend, text, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) {
        void handleSend();
      }
    }
  };

  const handleInsertEmoji = (emoji: string) => {
    if (isEffectivelyDisabled) return;
    setText((prev) => (prev ? `${prev} ${emoji}` : emoji));
  };

  const handleInsertCodeSnippet = () => {
    if (isEffectivelyDisabled) return;
    setText((prev) =>
      prev ? `${prev}\n\`\`\`\n// code\n\`\`\`\n` : "```\n// code\n```\n"
    );
  };

  return (
    <div
      className={cn(
        "p-3 border-t border-border-subtle bg-surface select-none",
        className
      )}
    >
      {/* Rate limit warning banner */}
      {isRateLimited && rateLimitCountdown > 0 && (
        <div
          role="alert"
          className="flex items-center gap-1.5 p-2 mb-2 text-xs rounded-md bg-warning/15 border border-warning/30 text-warning"
          data-testid="rate-limit-banner"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 animate-pulse" />
          <span>
            Rate limited. Please wait {rateLimitCountdown}s before sending again.
          </span>
        </div>
      )}

      {/* General disabled reason banner (room ended, reconnecting) */}
      {disabled && disabledReason && (
        <div
          className="p-2 mb-2 text-xs rounded-md bg-surface-hover/70 border border-border-subtle text-text-subtle text-center"
          data-testid="composer-disabled-banner"
        >
          <span>{disabledReason}</span>
        </div>
      )}

      {/* Quick Reactions & Code Helper Bar */}
      {!disabled && !isRateLimited && (
        <div className="flex items-center justify-between gap-1 mb-2 px-0.5">
          <div className="flex items-center gap-1">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => handleInsertEmoji(emoji)}
                className="h-6 w-6 rounded hover:bg-surface-hover flex items-center justify-center text-xs transition-colors cursor-pointer"
                title={`Insert ${emoji}`}
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleInsertCodeSnippet}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono text-text-subtle hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
            title="Insert Code Block"
            aria-label="Insert Code Block"
          >
            <Code className="h-3 w-3" />
            <span>Code</span>
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
        className="flex flex-col gap-2"
      >
        <div className="relative">
          <label htmlFor={textareaId} className="sr-only">
            Send a message
          </label>
          <textarea
            ref={inputRef}
            id={textareaId}
            aria-label="Send a message"
            aria-invalid={isOverLimit}
            aria-describedby={`${textareaId}-counter`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isEffectivelyDisabled}
            placeholder={
              disabled
                ? disabledReason || "Chat is disabled"
                : isRateLimited
                  ? `Rate limited (${rateLimitCountdown}s)...`
                  : "Type a message... (Enter to send, Shift+Enter for newline)"
            }
            rows={2}
            className={cn(
              "w-full resize-none rounded-lg bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-subtle border border-border-input focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed transition-all",
              isOverLimit &&
                "border-destructive text-destructive-text focus:ring-destructive"
            )}
            data-testid="chat-composer-textarea"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          {/* Character & Byte Counter */}
          <div
            id={`${textareaId}-counter`}
            className="text-[11px] font-mono text-text-subtle"
            data-testid="chat-composer-counter"
          >
            <span className={cn(isOverGraphemeLimit && "text-destructive font-semibold")}>
              {graphemeCount.toLocaleString()} / {MAX_CHAT_GRAPHEMES.toLocaleString()}
            </span>
            {isOverByteLimit && (
              <span className="ml-2 text-destructive font-semibold">
                ({byteCount} / {MAX_CHAT_BYTES} bytes limit exceeded)
              </span>
            )}
          </div>

          <Button
            type="submit"
            size="sm"
            disabled={!canSend}
            isLoading={isSubmitting}
            aria-label="Send message"
            data-testid="chat-composer-send-button"
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            <span>Send</span>
          </Button>
        </div>
      </form>
    </div>
  );
}
