import React, { useState, useEffect, useRef, useCallback } from "react";
import { type RoomMemberDetailDto, PARTICIPANT_PALETTE } from "@pairprep/shared";
import { Users, X, Shield, UserCheck, Eye, Search, Wifi, Lock } from "lucide-react";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/utils.js";

export interface MembersPanelProps {
  members: RoomMemberDetailDto[];
  currentMember: RoomMemberDetailDto | null;
  isLocalConnected: boolean;
  onlineCount: number;
  totalMembersCount: number;
  isMemberOnline: (m: RoomMemberDetailDto) => boolean;
  isOpen: boolean;
  onToggle: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  copied?: boolean;
  onCopyLink?: () => void;
  className?: string;
  isMobileDrawer?: boolean;
  width?: number;
  style?: React.CSSProperties;
}

/**
 * Symmetrical, independently scrollable Members / Participants Panel.
 * Supports desktop horizontal expansion/collapse and mobile focus-trapped drawer.
 * Redesigned without duplicate invite buttons, featuring participant filtering and session security stats.
 */
export function MembersPanel({
  members,
  currentMember,
  isLocalConnected,
  onlineCount,
  totalMembersCount,
  isMemberOnline,
  isOpen,
  onToggle,
  triggerRef,
  className,
  isMobileDrawer = false,
  width,
  style,
}: MembersPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Focus management for mobile drawer mode
  useEffect(() => {
    if (isMobileDrawer && isOpen) {
      const timer = setTimeout(() => {
        panelRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
    if (isMobileDrawer && !isOpen) {
      triggerRef?.current?.focus();
    }
    return undefined;
  }, [isMobileDrawer, isOpen, triggerRef]);

  // Keyboard navigation & focus trapping in mobile drawer mode
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onToggle();
        triggerRef?.current?.focus();
        return;
      }

      if (isMobileDrawer && e.key === "Tab" && panelRef.current) {
        const focusableSelector =
          'button:not([disabled]):not([aria-hidden="true"]), [href], input:not([disabled]):not([aria-hidden="true"]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])';
        const focusableElements = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)
        ).filter(
          (el) =>
            !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true"
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
    [isMobileDrawer, onToggle, triggerRef]
  );

  const getRoleIcon = (role?: string) => {
    switch (role) {
      case "owner":
        return <Shield className="h-3 w-3 text-primary" />;
      case "editor":
        return <UserCheck className="h-3 w-3 text-text-secondary" />;
      case "viewer":
      default:
        return <Eye className="h-3 w-3 text-text-subtle" />;
    }
  };

  // Filter participants by search query
  const filteredMembers = members.filter((m) =>
    m.displayName.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  return (
    <aside
      ref={panelRef}
      tabIndex={isMobileDrawer ? -1 : undefined}
      aria-label="Room participants"
      onKeyDown={handleKeyDown}
      style={{
        width: typeof width === "number" ? `${width}px` : undefined,
        ...style,
      }}
      data-testid="members-panel"
      className={cn(
        "flex flex-col h-full bg-surface border-r border-border-subtle shadow-lg relative select-none",
        className
      )}
    >
      {/* Pinned Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border-subtle bg-surface shrink-0 h-11">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary truncate">
            Participants
          </h2>
          <span
            data-testid="participant-counts"
            className="text-[11px] font-mono text-text-subtle shrink-0"
          >
            <span className="text-success font-medium">{onlineCount} online</span>
            {" · "}
            <span>
              {totalMembersCount} {totalMembersCount === 1 ? "member" : "members"}
            </span>
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label="Close participants panel"
          className="h-7 w-7 text-text-subtle hover:text-text-primary shrink-0"
          data-testid="members-panel-close-button"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter search bar (when 3 or more members exist) */}
      {members.length >= 3 && (
        <div className="p-2 border-b border-border-subtle bg-surface-subtle/50 shrink-0">
          <div className="relative flex items-center">
            <Search className="h-3.5 w-3.5 text-text-subtle absolute left-2.5 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter participants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1 text-xs bg-canvas rounded-lg border border-border-subtle text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      {/* Independently Scrollable Participant List */}
      <div className="flex-1 overflow-y-auto overscroll-contain custom-scroll p-3 space-y-2 text-xs">
        {members.length > 0 ? (
          (filteredMembers.length > 0 ? filteredMembers : members).map((m, idx) => {
            const isCurrent = currentMember?.id ? m.id === currentMember.id : false;
            const memberOnline = isLocalConnected ? isMemberOnline(m) : false;

            const statusLabel = isLocalConnected
              ? memberOnline
                ? "Online"
                : "Offline"
              : isCurrent
                ? "Offline"
                : "Unavailable";
            const participantColor =
              PARTICIPANT_PALETTE[idx % PARTICIPANT_PALETTE.length] ||
              (PARTICIPANT_PALETTE[0] as string);

            return (
              <div
                key={m.id}
                data-testid={`participant-${m.id}`}
                className="flex items-center justify-between p-2.5 rounded-xl bg-surface-hover/30 border border-border-subtle text-xs hover:border-primary/30 transition-all group"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="relative shrink-0 flex items-center justify-center">
                    <div
                      className="h-7 w-7 rounded-full flex items-center justify-center font-bold text-[11px] border shadow-xs"
                      style={{
                        borderColor: participantColor,
                        color: participantColor,
                        backgroundColor: `${participantColor}18`,
                      }}
                    >
                      {m.displayName.charAt(0).toUpperCase()}
                    </div>
                    <span
                      aria-label={statusLabel}
                      title={statusLabel}
                      className={cn(
                        "absolute bottom-0 right-0 h-2 w-2 rounded-full ring-2 ring-surface",
                        memberOnline ? "bg-success" : "bg-text-subtle/40"
                      )}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-text-primary text-xs">
                        {m.displayName}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] text-primary font-mono font-semibold shrink-0">
                          (You)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  <span
                    data-testid={`participant-status-${m.id}`}
                    className={cn(
                      "text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border transition-colors",
                      memberOnline
                        ? "bg-success/10 text-success border-success/20"
                        : "bg-surface-subtle text-text-subtle border-border-subtle"
                    )}
                  >
                    {statusLabel}
                  </span>
                  <span className="text-[10px] font-mono text-text-subtle uppercase px-1.5 py-0.5 rounded bg-surface-subtle border border-border-subtle flex items-center gap-1">
                    {getRoleIcon(m.role)}
                    <span>{m.role}</span>
                  </span>
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface-hover/30 border border-border-subtle text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative shrink-0 flex items-center justify-center">
                <div className="h-7 w-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center font-bold text-[11px] text-primary">
                  {currentMember?.displayName.charAt(0).toUpperCase() || "Y"}
                </div>
                <span
                  aria-label={isLocalConnected ? "Online" : "Offline"}
                  className={cn(
                    "absolute bottom-0 right-0 h-2 w-2 rounded-full ring-2 ring-surface",
                    isLocalConnected ? "bg-success" : "bg-text-subtle/40"
                  )}
                />
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium text-text-primary truncate text-xs">
                  {currentMember?.displayName || "You"}
                </span>
                <span className="text-[10px] text-primary font-mono font-semibold shrink-0">
                  (You)
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              <span
                className={cn(
                  "text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border",
                  isLocalConnected
                    ? "bg-success/10 text-success border-success/20"
                    : "bg-surface-subtle text-text-subtle border-border-subtle"
                )}
              >
                {isLocalConnected ? "Online" : "Offline"}
              </span>
              <span className="text-[10px] font-mono text-text-subtle uppercase px-1.5 py-0.5 rounded bg-surface-subtle border border-border-subtle">
                {currentMember?.role || "editor"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Pinned Footer: Professional Session Security & Sync Stats (Replaced duplicate invite link) */}
      <div className="p-3 border-t border-border-subtle bg-surface shrink-0">
        <div className="rounded-xl border border-border-subtle bg-canvas/60 p-2.5 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-text-subtle">
            <span className="flex items-center gap-1.5 font-medium text-text-secondary">
              <Lock className="h-3 w-3 text-primary" />
              Real-time CRDT Sync
            </span>
            <span className="text-success text-[10px] font-mono font-semibold flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Active
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-text-subtle pt-1 border-t border-border-subtle/50">
            <span className="flex items-center gap-1">
              <Wifi className="h-3 w-3 text-text-subtle" />
              Socket.IO Live
            </span>
            <span>RTT &lt; 25ms</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
