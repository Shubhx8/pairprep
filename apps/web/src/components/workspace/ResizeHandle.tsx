import React, { useCallback, useState } from "react";
import { cn } from "../../lib/utils.js";

export interface ResizeHandleProps {
  side: "left" | "right";
  onResize: (newWidth: number) => void;
  onReset?: () => void;
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Accessible, smooth horizontal resize separator for workspace side panels.
 * Supports mouse/touch dragging with pointer capture, keyboard adjustments, and double-click to reset.
 */
export function ResizeHandle({
  side,
  onResize,
  onReset,
  currentWidth,
  minWidth,
  maxWidth,
  className,
  ariaLabel = "Resize workspace sidebar panel",
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startWidth = currentWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        // Left panel right-border: drag right increases width
        // Right panel left-border: drag left increases width
        const rawWidth = side === "left" ? startWidth + deltaX : startWidth - deltaX;
        const clampedWidth = Math.max(minWidth, Math.min(maxWidth, rawWidth));
        onResize(clampedWidth);
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        setIsDragging(false);
        try {
          (e.target as HTMLElement).releasePointerCapture(upEvent.pointerId);
        } catch {
          // pointer already released
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [currentWidth, minWidth, maxWidth, onResize, side]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let delta = 0;
      if (e.key === "ArrowLeft") delta = side === "left" ? -10 : 10;
      if (e.key === "ArrowRight") delta = side === "left" ? 10 : -10;
      if (e.key === "Home") {
        e.preventDefault();
        onResize(minWidth);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        onResize(maxWidth);
        return;
      }
      if (e.key === "Enter" && onReset) {
        e.preventDefault();
        onReset();
        return;
      }

      if (delta !== 0) {
        e.preventDefault();
        const next = Math.max(minWidth, Math.min(maxWidth, currentWidth + delta));
        onResize(next);
      }
    },
    [currentWidth, minWidth, maxWidth, onResize, onReset, side]
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={currentWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      title="Drag to resize, double-click to reset"
      className={cn(
        "hidden lg:flex items-center justify-center relative w-1.5 shrink-0 cursor-col-resize select-none touch-none group transition-colors z-10",
        isDragging && "bg-primary/20",
        className
      )}
    >
      <div
        className={cn(
          "w-[1px] h-full bg-border-subtle group-hover:bg-primary/60 group-focus-visible:bg-primary transition-colors",
          isDragging && "bg-primary w-[2px]"
        )}
      />
    </div>
  );
}
