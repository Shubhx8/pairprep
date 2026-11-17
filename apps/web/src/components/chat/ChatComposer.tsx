import React, { useState, useCallback, useId } from "react";
import { SendHorizontal, Clock, Code, Smile } from "lucide-react";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/utils.js";

export const MAX_CHAT_GRAPHEMES = 1000;
export const MAX_CHAT_BYTES = 4000;

export interface ChatComposerProps {
  onSendMessage: (text: string) => Promise<string | null>;
  disabled?: boolean;
  disabledReason?: string;
  isRateLimited?: boolean;
  rateLimitCountdown?: number;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

const QUICK_EMOJIS = ["👍", "😎", "🚀", "💡", "❤️", "🎉", "❓", "😊"];

/**
 * Counts user-perceived characters (grapheme clusters) using Intl.Segmenter.
 */
export function countGraphemes(text: string): number {
  if (!text) return 0;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(text)) {
      count++;
    }
    return count;
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
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
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
      setShowEmojiPicker(false);
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
    const el = inputRef?.current;
    if (
      el &&
      typeof el.selectionStart === "number" &&
      typeof el.selectionEnd === "number"
    ) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = text.substring(0, start);
      const after = text.substring(end);
      const newText = `${before}${emoji}${after}`;
      setText(newText);
      setTimeout(() => {
        el.focus();
        const cursor = start + emoji.length;
        el.setSelectionRange(cursor, cursor);
      }, 0);
    } else {
      setText((prev) => (prev ? `${prev} ${emoji}` : emoji));
    }
  };

  const handleInsertCodeSnippet = () => {
    if (isEffectivelyDisabled) return;
    const el = inputRef?.current;
    if (
      el &&
      typeof el.selectionStart === "number" &&
      typeof el.selectionEnd === "number"
    ) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const selected = text.substring(start, end);
      const before = text.substring(0, start);
      const after = text.substring(end);
      const codeBlock = selected ? `\`\`\`\n${selected}\n\`\`\`` : "```\n// code\n```";
      const newText = `${before}${codeBlock}${after}`;
      setText(newText);
      setTimeout(() => {
        el.focus();
        const cursor = start + codeBlock.length;
        el.setSelectionRange(cursor, cursor);
      }, 0);
    } else {
      setText((prev) =>
        prev ? `${prev}\n\`\`\`\n// code\n\`\`\`\n` : "```\n// code\n```\n"
      );
    }
  };

  return (
    <div
      className={cn(
        "p-2.5 border-t border-border-subtle bg-surface select-none",
        className
      )}
    >
      {/* Rate limit warning banner */}
      {isRateLimited && rateLimitCountdown > 0 && (
        <div
          role="alert"
          className="flex items-center gap-1.5 p-2 mb-2 text-xs rounded-xl bg-warning/15 border border-warning/30 text-warning"
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
          className="p-2 mb-2 text-xs rounded-xl bg-surface-hover/70 border border-border-subtle text-text-subtle text-center"
          data-testid="composer-disabled-banner"
        >
          <span>{disabledReason}</span>
        </div>
      )}

      {/* Compact, modern Card Container */}
      <div className="rounded-xl border border-border-subtle bg-canvas/40 hover:border-border-subtle/80 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20 transition-all p-2 flex flex-col gap-1 shadow-xs">
        {/* Quick Emoji Tray (toggled or active) */}
        {showEmojiPicker && !isEffectivelyDisabled && (
          <div className="flex items-center gap-1 pb-1 mb-1 border-b border-border-subtle/60 overflow-x-auto custom-scroll animate-in fade-in duration-150">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                tabIndex={-1}
                onClick={() => handleInsertEmoji(emoji)}
                className="h-6 w-6 rounded hover:bg-surface-hover active:scale-95 flex items-center justify-center text-sm transition-all cursor-pointer shrink-0"
                title={`Insert ${emoji}`}
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
          className="flex flex-col gap-1.5"
        >
          <div className="relative">
            <label htmlFor={textareaId} className="sr-only">
              Send a message
            </label>
            <textarea
              ref={inputRef as React.LegacyRef<HTMLTextAreaElement>}
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
                    : "Write a message... (Enter to send, Shift+Enter for newline)"
              }
              rows={1}
              className={cn(
                "w-full resize-none rounded-lg bg-transparent px-1.5 py-0.5 text-sm min-h-[34px] max-h-28 text-text-primary placeholder:text-text-subtle/70 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed custom-scroll transition-colors",
                isOverLimit &&
                  "text-destructive-text placeholder:text-destructive-text/50"
              )}
              data-testid="chat-composer-textarea"
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-border-subtle/40">
            {/* Character & Byte Counter */}
            <div
              id={`${textareaId}-counter`}
              className="text-[11px] font-mono text-text-subtle/70 px-1"
              data-testid="chat-composer-counter"
            >
              <span
                className={cn(isOverGraphemeLimit && "text-destructive font-semibold")}
              >
                {graphemeCount.toLocaleString()} / {MAX_CHAT_GRAPHEMES.toLocaleString()}
              </span>
              {isOverByteLimit && (
                <span className="ml-2 text-destructive font-semibold">
                  ({byteCount} / {MAX_CHAT_BYTES} bytes limit exceeded)
                </span>
              )}
            </div>

            {/* Right Actions: Emoji, Code, Send */}
            <div className="flex items-center gap-1">
              {!disabled && !isRateLimited && (
                <>
                  {/* Emoji Toggle Button */}
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowEmojiPicker((prev) => !prev)}
                    className={cn(
                      "h-6 w-6 rounded flex items-center justify-center transition-colors cursor-pointer",
                      showEmojiPicker
                        ? "bg-surface-hover text-primary"
                        : "text-text-subtle hover:text-text-primary hover:bg-surface-hover"
                    )}
                    title="Insert emoji"
                    aria-label="Insert emoji"
                  >
                    <Smile className="h-3.5 w-3.5" />
                  </button>

                  {/* Code Snippet Helper Button */}
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={handleInsertCodeSnippet}
                    className="h-6 w-6 rounded flex items-center justify-center text-text-subtle hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
                    title="Insert Code Block"
                    aria-label="Insert Code Block"
                  >
                    <Code className="h-3.5 w-3.5" />
                  </button>
                </>
              )}

              {/* Send Button */}
              <Button
                type="submit"
                size="sm"
                disabled={!canSend}
                isLoading={isSubmitting}
                aria-label="Send message"
                data-testid="chat-composer-send-button"
                className="rounded-lg px-3 py-1 h-6 text-xs font-semibold gap-1 shadow-sm active:scale-[0.96] transition-all cursor-pointer"
              >
                <span className="hidden sm:inline">Send</span>
                <SendHorizontal className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
