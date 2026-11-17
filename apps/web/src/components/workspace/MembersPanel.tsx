import React, { useState, useEffect, useRef, useCallback } from "react";
import { type RoomMemberDetailDto, PARTICIPANT_PALETTE } from "@pairprep/shared";
import {
  Users,
  X,
  Shield,
  UserCheck,
  Eye,
  Search,
  Wifi,
  Lock,
  UserMinus,
  AlertTriangle,
  MoreVertical,
  Ban,
  ChevronDown,
  Check,
  Loader2,
} from "lucide-react";
import { Button } from "../ui/Button.js";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalFooter,
} from "../ui/Modal.js";
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
  onRemoveMember?: (memberDocId: string) => Promise<void>;
  onKickMember?: (memberDocId: string) => Promise<void>;
  onBanMember?: (memberDocId: string) => Promise<void>;
  onUpdateRole?: (memberDocId: string, newRole: "editor" | "viewer") => Promise<void>;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  copied?: boolean;
  onCopyLink?: () => void;
  className?: string;
  isMobileDrawer?: boolean;
  width?: number;
  style?: React.CSSProperties;
  socketStatus?: string;
}

/**
 * Symmetrical, independently scrollable Members / Participants Panel.
 * Supports desktop horizontal expansion/collapse and mobile focus-trapped drawer.
 * Provides interactive role switching (Editor/Viewer) and three-dot contextual management (Kick/Ban).
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
  onRemoveMember,
  onKickMember,
  onBanMember,
  onUpdateRole,
  triggerRef,
  className,
  isMobileDrawer = false,
  width,
  style,
  socketStatus = "connected",
}: MembersPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Targets for action modals
  const [targetToKick, setTargetToKick] = useState<RoomMemberDetailDto | null>(null);
  const [targetToBan, setTargetToBan] = useState<RoomMemberDetailDto | null>(null);
  const [targetToRemove, setTargetToRemove] = useState<RoomMemberDetailDto | null>(null);

  // Active dropdown menu IDs
  const [openRoleMenuId, setOpenRoleMenuId] = useState<string | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  // Loading & error states
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<{
    memberId: string;
    message: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-members-menu]")) {
        setOpenRoleMenuId(null);
        setOpenActionMenuId(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
        if (openRoleMenuId || openActionMenuId) {
          setOpenRoleMenuId(null);
          setOpenActionMenuId(null);
          return;
        }
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
    [isMobileDrawer, isOpen, openActionMenuId, openRoleMenuId, onToggle, triggerRef]
  );

  const getRoleIcon = (role?: string) => {
    switch (role) {
      case "owner":
        return <Shield className="h-3 w-3 text-primary shrink-0" />;
      case "editor":
        return <UserCheck className="h-3 w-3 text-success shrink-0" />;
      case "viewer":
      default:
        return <Eye className="h-3 w-3 text-text-subtle shrink-0" />;
    }
  };

  const handleRoleChange = async (memberDocId: string, newRole: "editor" | "viewer") => {
    if (!onUpdateRole) return;
    try {
      setUpdatingRoleId(memberDocId);
      setRoleError(null);
      await onUpdateRole(memberDocId, newRole);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update member role";
      setRoleError({ memberId: memberDocId, message: msg });
    } finally {
      setUpdatingRoleId(null);
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

      {/* Role Error Notification Banner */}
      {roleError && (
        <div className="px-3 py-1.5 bg-destructive/10 border-b border-destructive/20 text-[11px] text-destructive flex items-center justify-between">
          <span>{roleError.message}</span>
          <button
            type="button"
            onClick={() => setRoleError(null)}
            className="text-destructive hover:opacity-80 ml-2"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Independently Scrollable Participant List */}
      <div className="flex-1 overflow-y-auto overscroll-contain custom-scroll p-3 space-y-2 text-xs">
        {members.length > 0 ? (
          (filteredMembers.length > 0 ? filteredMembers : members).map((m, idx) => {
            const isCurrent = currentMember?.id
              ? m.id === currentMember.id ||
                Boolean(
                  m.memberId &&
                  (currentMember as { memberId?: string }).memberId &&
                  m.memberId === (currentMember as { memberId?: string }).memberId
                )
              : false;
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

            const isOwnerViewer = currentMember?.role === "owner";
            const canManage = isOwnerViewer && !isCurrent && m.role !== "owner";

            return (
              <div
                key={m.id}
                data-testid={`participant-${m.id}`}
                className="flex items-center justify-between p-2.5 rounded-xl bg-surface-hover/20 hover:bg-surface-hover/40 border border-border-subtle/40 hover:border-border-subtle transition-all group"
              >
                {/* Left: Avatar & Info Stack (Name + Online status beneath) */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0 flex items-center justify-center">
                    <div
                      className="h-8 w-8 rounded-full flex items-center justify-center font-semibold text-xs border border-border-subtle bg-surface-subtle text-text-primary shadow-xs"
                      style={{
                        borderColor: `${participantColor}40`,
                      }}
                    >
                      {m.displayName.charAt(0).toUpperCase()}
                    </div>
                    <span
                      aria-label={statusLabel}
                      title={statusLabel}
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface",
                        memberOnline ? "bg-success" : "bg-text-subtle/40"
                      )}
                    />
                  </div>
                  <div className="flex flex-col min-w-0 justify-center">
                    <div className="flex items-center gap-1.5 leading-tight">
                      <span className="truncate font-semibold text-text-primary text-xs">
                        {m.displayName}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] text-primary font-mono font-semibold shrink-0">
                          (You)
                        </span>
                      )}
                    </div>
                    <span
                      data-testid={`participant-status-${m.id}`}
                      className={cn(
                        "text-[11px] font-medium leading-tight mt-0.5",
                        memberOnline ? "text-success" : "text-text-subtle"
                      )}
                    >
                      {statusLabel}
                    </span>
                  </div>
                </div>

                {/* Right: Role Dropdown + Three-dot Menu */}
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  {/* Role Presentation: Interactive Dropdown for owner on non-owners, Pill Badge otherwise */}
                  {canManage && Boolean(onUpdateRole) ? (
                    <div className="relative" data-members-menu>
                      <button
                        type="button"
                        data-testid={`role-dropdown-${m.id}`}
                        aria-label={`Change role for ${m.displayName}, current role is ${m.role}`}
                        disabled={updatingRoleId === m.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenActionMenuId(null);
                          setOpenRoleMenuId(openRoleMenuId === m.id ? null : m.id);
                        }}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1 focus:outline-none focus:ring-1 focus:ring-primary/60",
                          m.role === "editor"
                            ? "bg-success/10 text-success border border-success/30 hover:bg-success/20"
                            : m.role === "viewer"
                              ? "bg-surface-subtle text-text-secondary border border-border-subtle hover:bg-surface-hover hover:text-text-primary"
                              : "bg-surface-subtle text-text-secondary border border-border-subtle hover:border-primary/50",
                          openRoleMenuId === m.id && "ring-1 ring-primary/60"
                        )}
                      >
                        {updatingRoleId === m.id ? (
                          <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                        ) : null}
                        <span className="capitalize">{m.role}</span>
                        <ChevronDown className="h-3 w-3 stroke-[2] opacity-80 shrink-0" />
                      </button>

                      {/* Floating Role Selection Menu */}
                      {openRoleMenuId === m.id && (
                        <div
                          data-testid={`role-menu-${m.id}`}
                          className="absolute right-0 top-full mt-1.5 w-32 bg-surface border border-border-subtle rounded-xl shadow-2xl p-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                        >
                          <button
                            type="button"
                            data-testid={`role-option-editor-${m.id}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setOpenRoleMenuId(null);
                              if (m.role === "editor") return;
                              await handleRoleChange(m.id, "editor");
                            }}
                            className={cn(
                              "w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors cursor-pointer",
                              m.role === "editor"
                                ? "text-success font-medium bg-success/10"
                                : "text-text-primary hover:text-success hover:bg-surface-hover"
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <UserCheck className="h-3.5 w-3.5 text-success" />
                              Editor
                            </span>
                            {m.role === "editor" && (
                              <Check className="h-3.5 w-3.5 text-success" />
                            )}
                          </button>

                          <button
                            type="button"
                            data-testid={`role-option-viewer-${m.id}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setOpenRoleMenuId(null);
                              if (m.role === "viewer") return;
                              await handleRoleChange(m.id, "viewer");
                            }}
                            className={cn(
                              "w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors cursor-pointer mt-0.5",
                              m.role === "viewer"
                                ? "text-text-primary font-medium bg-surface-active"
                                : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <Eye className="h-3.5 w-3.5 text-text-subtle" />
                              Viewer
                            </span>
                            {m.role === "viewer" && (
                              <Check className="h-3.5 w-3.5 text-text-primary" />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span
                      data-testid={`participant-role-${m.id}`}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs font-medium capitalize flex items-center gap-1.5 border",
                        m.role === "owner"
                          ? "bg-primary/10 text-primary border-primary/20 font-semibold uppercase tracking-wider text-[11px]"
                          : m.role === "editor"
                            ? "bg-success/10 text-success border-success/30"
                            : "bg-surface-subtle text-text-subtle border-border-subtle"
                      )}
                    >
                      {getRoleIcon(m.role)}
                      <span>{m.role}</span>
                    </span>
                  )}

                  {/* Three-dot Contextual Actions Menu (Kick & Ban) */}
                  {canManage && (
                    <div className="relative" data-members-menu>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenRoleMenuId(null);
                          setOpenActionMenuId(openActionMenuId === m.id ? null : m.id);
                        }}
                        aria-label={`Actions for ${m.displayName}`}
                        title={`Actions for ${m.displayName}`}
                        className={cn(
                          "h-7 w-7 text-text-subtle hover:text-text-primary hover:bg-surface-hover active:scale-95 transition-all shrink-0 rounded-md",
                          openActionMenuId === m.id &&
                            "bg-surface-hover text-text-primary"
                        )}
                        data-testid={`member-actions-${m.id}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>

                      {/* Hidden button with legacy data-testid for backward test compatibility */}
                      <button
                        type="button"
                        className="sr-only"
                        data-testid={`remove-member-${m.id}`}
                        aria-label={`Remove ${m.displayName}`}
                        onClick={() => {
                          setModalError(null);
                          setTargetToRemove(m);
                        }}
                      />

                      {/* Floating Contextual Menu */}
                      {openActionMenuId === m.id && (
                        <div
                          data-testid={`action-menu-${m.id}`}
                          className="absolute right-0 top-full mt-1.5 w-40 bg-surface border border-border-subtle rounded-xl shadow-2xl p-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                        >
                          {(Boolean(onKickMember) || Boolean(onRemoveMember)) && (
                            <button
                              type="button"
                              data-testid={`kick-member-option-${m.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenActionMenuId(null);
                                setModalError(null);
                                setTargetToKick(m);
                              }}
                              className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 text-text-primary hover:text-warning hover:bg-warning/10 transition-colors cursor-pointer group"
                            >
                              <UserMinus className="h-3.5 w-3.5 text-warning shrink-0 group-hover:scale-105 transition-transform" />
                              <span className="font-medium">Kick member</span>
                            </button>
                          )}

                          {(Boolean(onBanMember) || Boolean(onRemoveMember)) && (
                            <>
                              <div className="my-0.5 border-t border-border-subtle/40" />
                              <button
                                type="button"
                                data-testid={`ban-member-option-${m.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenActionMenuId(null);
                                  setModalError(null);
                                  setTargetToBan(m);
                                }}
                                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 text-destructive hover:bg-destructive/10 transition-colors cursor-pointer group"
                              >
                                <Ban className="h-3.5 w-3.5 text-destructive shrink-0 group-hover:scale-105 transition-transform" />
                                <span className="font-medium">Permanently ban</span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface-hover/20 border border-border-subtle/40 text-xs">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative shrink-0 flex items-center justify-center">
                <div className="h-8 w-8 rounded-full bg-surface-subtle border border-border-subtle flex items-center justify-center font-semibold text-xs text-text-primary">
                  {currentMember?.displayName.charAt(0).toUpperCase() || "Y"}
                </div>
                <span
                  aria-label={isLocalConnected ? "Online" : "Offline"}
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface",
                    isLocalConnected ? "bg-success" : "bg-text-subtle/40"
                  )}
                />
              </div>
              <div className="flex flex-col min-w-0 justify-center">
                <div className="flex items-center gap-1.5 leading-tight">
                  <span className="font-semibold text-text-primary truncate text-xs">
                    {currentMember?.displayName || "You"}
                  </span>
                  <span className="text-[10px] text-primary font-mono font-semibold shrink-0">
                    (You)
                  </span>
                </div>
                <span
                  className={cn(
                    "text-[11px] font-medium leading-tight mt-0.5",
                    isLocalConnected ? "text-success" : "text-text-subtle"
                  )}
                >
                  {isLocalConnected ? "Online" : "Offline"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              <span
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 border",
                  currentMember?.role === "owner"
                    ? "bg-primary/10 text-primary border-primary/20"
                    : "bg-surface-subtle text-text-subtle border-border-subtle"
                )}
              >
                {getRoleIcon(currentMember?.role)}
                <span>{currentMember?.role || "editor"}</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Pinned Footer: Session Security & Sync Stats */}
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
              Real-time Events
            </span>
            <span
              className={cn(
                "font-semibold flex items-center gap-1",
                socketStatus === "connected"
                  ? "text-success"
                  : socketStatus === "connecting" || socketStatus === "reconnecting"
                    ? "text-warning"
                    : "text-text-subtle"
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  socketStatus === "connected"
                    ? "bg-success"
                    : socketStatus === "connecting" || socketStatus === "reconnecting"
                      ? "bg-warning animate-pulse"
                      : "bg-text-subtle"
                )}
              />
              {socketStatus === "connected"
                ? "Connected"
                : socketStatus === "connecting" || socketStatus === "reconnecting"
                  ? "Reconnecting"
                  : "Disconnected"}
            </span>
          </div>
        </div>
      </div>

      {/* 1. Kick Member Confirmation Dialog */}
      {targetToKick && (
        <Modal
          open={Boolean(targetToKick)}
          onOpenChange={(open) => {
            if (!open && !isSubmitting) {
              setTargetToKick(null);
              setModalError(null);
            }
          }}
        >
          <ModalContent data-testid="kick-member-modal" className="sm:max-w-md">
            <ModalHeader>
              <div className="flex items-center gap-2 text-warning">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <ModalTitle>Kick member?</ModalTitle>
              </div>
              <ModalDescription className="text-text-subtle text-xs mt-2">
                This member will be removed from the active room and temporarily prevented
                from rejoining. They may rejoin after the restriction expires.
              </ModalDescription>
            </ModalHeader>
            {modalError && (
              <p
                data-testid="kick-error-message"
                className="text-xs text-destructive bg-destructive/10 p-2 rounded border border-destructive/20 mt-2"
              >
                {modalError}
              </p>
            )}
            <ModalFooter className="mt-4 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => {
                  setTargetToKick(null);
                  setModalError(null);
                }}
                data-testid="cancel-kick-button"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={isSubmitting}
                className="bg-warning hover:bg-warning/90 text-primary-foreground font-medium"
                onClick={async () => {
                  const kickFn = onKickMember || onRemoveMember;
                  if (!kickFn) return;
                  try {
                    setIsSubmitting(true);
                    setModalError(null);
                    await kickFn(targetToKick.id);
                    setTargetToKick(null);
                  } catch (err: unknown) {
                    const message =
                      err instanceof Error ? err.message : "Failed to kick member";
                    setModalError(message);
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                data-testid="confirm-kick-button"
              >
                {isSubmitting ? "Kicking..." : "Kick member"}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}

      {/* 2. Permanent Ban Confirmation Dialog */}
      {targetToBan && (
        <Modal
          open={Boolean(targetToBan)}
          onOpenChange={(open) => {
            if (!open && !isSubmitting) {
              setTargetToBan(null);
              setModalError(null);
            }
          }}
        >
          <ModalContent data-testid="ban-member-modal" className="sm:max-w-md">
            <ModalHeader>
              <div className="flex items-center gap-2 text-destructive">
                <Ban className="h-5 w-5 shrink-0" />
                <ModalTitle>Permanently ban member?</ModalTitle>
              </div>
              <ModalDescription className="text-text-subtle text-xs mt-2">
                This member will be removed from the room and permanently prevented from
                rejoining.
              </ModalDescription>
            </ModalHeader>
            {modalError && (
              <p
                data-testid="ban-error-message"
                className="text-xs text-destructive bg-destructive/10 p-2 rounded border border-destructive/20 mt-2"
              >
                {modalError}
              </p>
            )}
            <ModalFooter className="mt-4 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => {
                  setTargetToBan(null);
                  setModalError(null);
                }}
                data-testid="cancel-ban-button"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isSubmitting}
                onClick={async () => {
                  const banFn = onBanMember || onRemoveMember;
                  if (!banFn) return;
                  try {
                    setIsSubmitting(true);
                    setModalError(null);
                    await banFn(targetToBan.id);
                    setTargetToBan(null);
                  } catch (err: unknown) {
                    const message =
                      err instanceof Error ? err.message : "Failed to ban member";
                    setModalError(message);
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                data-testid="confirm-ban-button"
              >
                {isSubmitting ? "Banning..." : "Permanently ban"}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}

      {/* 3. Legacy Remove Member Confirmation Modal (backward compatibility) */}
      {targetToRemove && (
        <Modal
          open={Boolean(targetToRemove)}
          onOpenChange={(open) => {
            if (!open && !isSubmitting) {
              setTargetToRemove(null);
              setModalError(null);
            }
          }}
        >
          <ModalContent data-testid="remove-member-modal" className="sm:max-w-md">
            <ModalHeader>
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <ModalTitle>Remove Participant</ModalTitle>
              </div>
              <ModalDescription className="text-text-subtle text-xs mt-2">
                Are you sure you want to remove{" "}
                <span className="font-semibold text-text-primary">
                  {targetToRemove.displayName}
                </span>{" "}
                from this room? They will immediately lose access and will not be able to
                rejoin.
              </ModalDescription>
            </ModalHeader>
            {modalError && (
              <p
                data-testid="remove-error-message"
                className="text-xs text-destructive bg-destructive/10 p-2 rounded border border-destructive/20 mt-2"
              >
                {modalError}
              </p>
            )}
            <ModalFooter className="mt-4 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isSubmitting}
                onClick={() => {
                  setTargetToRemove(null);
                  setModalError(null);
                }}
                data-testid="cancel-remove-button"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isSubmitting}
                onClick={async () => {
                  const removeFn = onRemoveMember || onBanMember;
                  if (!removeFn) return;
                  try {
                    setIsSubmitting(true);
                    setModalError(null);
                    await removeFn(targetToRemove.id);
                    setTargetToRemove(null);
                  } catch (err: unknown) {
                    const message =
                      err instanceof Error ? err.message : "Failed to remove member";
                    setModalError(message);
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                data-testid="confirm-remove-button"
              >
                {isSubmitting ? "Removing..." : "Remove"}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </aside>
  );
}
