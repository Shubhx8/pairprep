import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type FormEvent,
} from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../lib/authContext.js";
import { apiClient, ApiClientError } from "../lib/apiClient.js";
import type {
  RoomDto,
  PublicRoomDto,
  RoomMemberDetailDto,
  UserRole,
} from "@pairprep/shared";
import { PARTICIPANT_PALETTE } from "@pairprep/shared";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import type { SupportedEditorLanguage } from "../components/CodeEditor.js";
import { useRoomSync } from "../hooks/useRoomSync.js";
import { useParticipantSync } from "../hooks/useParticipantSync.js";
import { useRoomSocket } from "../hooks/useRoomSocket.js";
import { ChatPanel, ChatUnreadBadge } from "../components/chat/index.js";
import { MembersPanel } from "../components/workspace/MembersPanel.js";
import { ResizeHandle } from "../components/workspace/ResizeHandle.js";
import { cn } from "../lib/utils.js";
import { isValidRoomId } from "../lib/roomId.js";

// PRD Performance & Section 14: Dynamic lazy-loading boundary for Monaco collaborative editor
const CollaborativeEditor = lazy(() => import("../components/CollaborativeEditor.js"));
import {
  Code2,
  Users,
  Copy,
  Check,
  AlertTriangle,
  Lock,
  ArrowLeft,
  Sparkles,
  Terminal,
  MessageSquare,
} from "lucide-react";

export default function RoomPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();

  const [room, setRoom] = useState<RoomDto | PublicRoomDto | null>(null);
  const [currentMember, setCurrentMember] = useState<RoomMemberDetailDto | null>(null);
  const [members, setMembers] = useState<RoomMemberDetailDto[]>([]);
  const [onlineMemberCount, setOnlineMemberCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{
    code: string;
    message: string;
    retryAfterSec?: number;
  } | null>(null);

  const [guestName, setGuestName] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [selectedLanguage, setSelectedLanguage] =
    useState<SupportedEditorLanguage | null>(null);

  // Three-column collaborative workspace layout states
  // On desktop (>= 1024px) start with members panel open; on mobile (< 1024px) start with drawers closed
  const [isMembersOpen, setIsMembersOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true
  );
  const [membersWidth, setMembersWidth] = useState(280);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(320);
  const [unreadCount, setUnreadCount] = useState(0);
  const membersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const chatTriggerRef = useRef<HTMLButtonElement | null>(null);

  const toggleMembers = useCallback(() => {
    setIsMembersOpen((prev) => {
      const next = !prev;
      if (next && typeof window !== "undefined" && window.innerWidth < 1024) {
        setIsChatOpen(false);
      }
      return next;
    });
  }, []);

  const toggleChat = useCallback(() => {
    setIsChatOpen((prev) => {
      const next = !prev;
      if (next && typeof window !== "undefined" && window.innerWidth < 1024) {
        setIsMembersOpen(false);
      }
      return next;
    });
  }, []);
  const [lifecycleNotice, setLifecycleNotice] = useState<{
    type: "removed" | "deleted" | "ended";
    message: string;
  } | null>(null);

  const currentMemberRef = useRef(currentMember);
  useEffect(() => {
    currentMemberRef.current = currentMember;
  }, [currentMember]);

  // Sync client hook: only enabled when visitor is an active room member with valid 24-char ObjectId
  const roomId = room && "id" in room && isValidRoomId(room.id) ? room.id : null;
  const isSyncEnabled = Boolean(currentMember && roomId);
  const sync = useRoomSync({ roomId, enabled: isSyncEnabled });

  // Room socket hook: enabled only when visitor is an active room member with valid 24-char ObjectId
  const isSocketEnabled = Boolean(currentMember && roomId && slug);
  const roomSocket = useRoomSocket({
    roomId,
    slug: slug ?? null,
    currentMember,
    enabled: isSocketEnabled,
    onRoleChanged: (newRole: UserRole, memberId?: string) => {
      const myId = currentMemberRef.current?.id;
      if (!memberId || (myId && memberId === myId)) {
        setCurrentMember((prev) => (prev ? { ...prev, role: newRole } : prev));
      }
      setMembers((prev) =>
        prev.map((m) => (!memberId || m.id === memberId ? { ...m, role: newRole } : m))
      );
    },
    onMemberRemoved: (memberId: string) => {
      const myId = currentMemberRef.current?.id;
      if (myId && memberId === myId) {
        setLifecycleNotice({
          type: "removed",
          message: "You have been removed from this room by the host.",
        });
      } else {
        setMembers((prev) => prev.filter((m) => m.id !== memberId));
      }
    },
    onMemberJoined: (newMember) => {
      if (!newMember || typeof newMember !== "object") return;
      const memberId =
        typeof newMember.memberId === "string" ? newMember.memberId.trim() : "";
      if (!memberId) return;

      setMembers((prev) => {
        if (prev.some((m) => m.id === memberId)) return prev;
        return [
          ...prev,
          {
            id: memberId,
            displayName: newMember.displayName || "Member",
            role: newMember.role || "editor",
            isGuest: Boolean(newMember.isGuest),
            isOnline: true,
            joinedAt: newMember.joinedAt || new Date().toISOString(),
            lastSeenAt: newMember.lastSeenAt,
          },
        ];
      });
    },
    onMemberLeft: (memberId: string, reason?: string) => {
      const myId = currentMemberRef.current?.id;
      if (myId && memberId === myId && reason === "removed") {
        setLifecycleNotice({
          type: "removed",
          message: "You have been removed from this room by the host.",
        });
      } else {
        setMembers((prev) => prev.filter((m) => m.id !== memberId));
      }
    },
    onRoomEnded: () => {
      setRoom((prev) => (prev ? { ...prev, status: "ended" } : prev));
      setLifecycleNotice((prev) =>
        prev?.type === "removed" || prev?.type === "deleted"
          ? prev
          : {
              type: "ended",
              message: "This room has ended and is now in read-only mode.",
            }
      );
    },
    onRoomDeleted: () => {
      setLifecycleNotice({
        type: "deleted",
        message: "This practice room has been deleted.",
      });
    },
    onMembersUpdated: (updatedMembers) => {
      setMembers(updatedMembers);
    },
    syncProvider: sync.provider,
  });

  // Expose sync handle for integration and E2E collaboration testing ONLY in DEV/test and when VITE_PAIRPREP_E2E=1
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      import.meta.env["VITE_PAIRPREP_E2E"] === "1" &&
      typeof window !== "undefined"
    ) {
      (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync = {
        doc: sync.doc,
        provider: sync.provider,
        status: sync.status,
        isSynced: sync.isSynced,
        error: sync.error,
      };
      return () => {
        delete (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync;
      };
    }
    return undefined;
  }, [sync.doc, sync.provider, sync.status, sync.isSynced, sync.error]);

  // Rate limit countdown effect
  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "noindex, nofollow");
    return () => {
      if (created && meta?.parentNode) {
        meta.parentNode.removeChild(meta);
      } else if (meta) {
        meta.setAttribute("content", "index, follow");
      }
    };
  }, []);

  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const fetchRoom = useCallback(async () => {
    if (!slug) return;
    setIsLoading(true);
    setError(null);

    try {
      const res = await apiClient.get<{
        room: RoomDto | PublicRoomDto;
        currentMember?: RoomMemberDetailDto;
        members?: RoomMemberDetailDto[];
        onlineMemberCount?: number;
      }>(`/rooms/${slug}`);

      setRoom(res.room);
      setCurrentMember(res.currentMember ?? null);
      setMembers(res.members ?? []);
      if (typeof res.onlineMemberCount === "number") {
        setOnlineMemberCount(res.onlineMemberCount);
      }
      document.title = `${res.room.title} · PairPrep`;
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          code: err.code,
          message: err.message,
          retryAfterSec: err.retryAfterSec,
        });
        if (err.status === 429 && err.retryAfterSec) {
          setCountdown(err.retryAfterSec);
        }
      } else {
        setError({
          code: "UNKNOWN_ERROR",
          message: "Failed to connect to room. Please try again.",
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchRoom();
  }, [fetchRoom]);

  // Background participant refresh helper (silent refresh without loading skeletons)
  const refreshRoom = useCallback(async () => {
    if (!slug) return;
    try {
      const res = await apiClient.get<{
        room: RoomDto | PublicRoomDto;
        currentMember?: RoomMemberDetailDto;
        members?: RoomMemberDetailDto[];
        onlineMemberCount?: number;
      }>(`/rooms/${slug}`);

      setRoom(res.room);
      setCurrentMember(res.currentMember ?? null);
      setMembers(res.members ?? []);
      if (typeof res.onlineMemberCount === "number") {
        setOnlineMemberCount(res.onlineMemberCount);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429 && err.retryAfterSec) {
        setCountdown(err.retryAfterSec);
      }
      throw err;
    }
  }, [slug]);

  // Event-driven participant synchronization with 30s fallback & 429 backoff (Finding 1 / ROOM-5)
  // When socket is connected, fallback polling is disabled; if disconnected/error, 30s fallback is active.
  useParticipantSync({
    enabled: Boolean(currentMember && slug),
    slug: slug ?? null,
    provider: sync.provider,
    localClientId: sync.doc?.clientID,
    onRefresh: refreshRoom,
    socketStatus: roomSocket.connectionStatus,
    fallbackIntervalMs: import.meta.env["VITE_PAIRPREP_E2E"] === "1" ? 4000 : 30000,
    debounceMs: 500,
  });

  // When WebSocket connects or reconnects, immediately refresh room to sync live presence without waiting (Phase 4.3)
  const prevSyncStatusRef = useRef(sync.status);
  useEffect(() => {
    if (prevSyncStatusRef.current !== "connected" && sync.status === "connected") {
      void refreshRoom().catch(() => {});
    }
    prevSyncStatusRef.current = sync.status;
  }, [sync.status, refreshRoom]);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleJoin = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!slug || isJoining || countdown) return;

    setIsJoining(true);
    setJoinError(null);

    const displayName = user ? user.displayName : guestName.trim();
    if (!user && (!displayName || displayName.length < 1 || displayName.length > 40)) {
      setJoinError("Display name must be between 1 and 40 characters.");
      setIsJoining(false);
      return;
    }

    try {
      const res = await apiClient.post<{
        room: RoomDto;
        currentMember: RoomMemberDetailDto;
      }>(`/rooms/${slug}/join`, { displayName });

      setRoom(res.room);
      setCurrentMember(res.currentMember);
      fetchRoom();
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "ROOM_FULL" || err.status === 409) {
          setRoom((prev) => (prev ? { ...prev, memberCount: 6 } : prev));
          setError({
            code: "ROOM_FULL",
            message: "This room has reached its maximum capacity of 6 participants.",
          });
        } else if (err.status === 429 && err.retryAfterSec) {
          setCountdown(err.retryAfterSec);
          setJoinError(`Too many join attempts. Please wait ${err.retryAfterSec}s.`);
        } else {
          setJoinError(err.message);
        }
      } else {
        setJoinError("Failed to join room. Please try again.");
      }
    } finally {
      setIsJoining(false);
    }
  };

  // 1. Loading State
  if (isLoading) {
    return (
      <div className="min-h-screen bg-canvas text-text-primary p-6 flex flex-col justify-center items-center">
        <div className="max-w-md w-full space-y-4">
          <Skeleton className="h-8 w-48 mx-auto" />
          <Skeleton className="h-4 w-72 mx-auto" />
          <div className="bg-surface border border-border-subtle rounded-xl p-6 space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  // 2. Error States (404, Rate Limit, etc.)
  if (error) {
    if (error.code === "ROOM_NOT_FOUND") {
      return (
        <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
          <EmptyState
            title="Room Not Found"
            description="The practice room link you followed does not exist or may have been deleted."
            icon={<Lock className="h-10 w-10 text-destructive-text" />}
            action={
              <Button asChild variant="primary">
                <Link to="/dashboard">Back to Dashboard</Link>
              </Button>
            }
          />
        </div>
      );
    }

    if (error.code === "ROOM_FULL") {
      return (
        <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
          <EmptyState
            title="Room is Full"
            description="This practice room has reached its maximum capacity of 6 participants."
            icon={<Users className="h-10 w-10 text-text-subtle" />}
            action={
              <Button asChild variant="primary">
                <Link to="/dashboard">Back to Dashboard</Link>
              </Button>
            }
          />
        </div>
      );
    }

    if (error.code === "RATE_LIMIT_EXCEEDED" && countdown) {
      return (
        <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
          <ErrorState
            title="Rate Limit Exceeded"
            message={`Too many requests. Please wait ${countdown} seconds before retrying.`}
            onRetry={countdown === 0 ? fetchRoom : undefined}
          />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
        <ErrorState
          title="Unable to load room"
          message={error.message}
          onRetry={fetchRoom}
        />
      </div>
    );
  }

  if (lifecycleNotice?.type === "removed") {
    return (
      <div
        data-testid="removed-screen"
        className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4"
      >
        <EmptyState
          title="Removed from Room"
          description={lifecycleNotice.message}
          icon={<Lock className="h-10 w-10 text-destructive-text" />}
          action={
            <Button asChild variant="primary">
              <Link to="/dashboard">Back to Dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (lifecycleNotice?.type === "deleted") {
    return (
      <div
        data-testid="deleted-screen"
        className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4"
      >
        <EmptyState
          title="Room Deleted"
          description={lifecycleNotice.message}
          icon={<Lock className="h-10 w-10 text-destructive-text" />}
          action={
            <Button asChild variant="primary">
              <Link to="/dashboard">Back to Dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!room) return null;

  const isMember = Boolean(currentMember);
  const isEnded = Boolean(
    roomSocket.isRoomEnded ||
    (room &&
      "status" in room &&
      (room.status === "ended" || room.status === "archived")) ||
    lifecycleNotice?.type === "ended"
  );

  // 3. Non-member visiting an Ended Room -> Closed screen
  if (!isMember && isEnded) {
    return (
      <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
        <EmptyState
          title="Room Closed"
          description="This practice session has ended and is no longer accepting new participants."
          icon={<Lock className="h-10 w-10 text-text-subtle" />}
          action={
            <Button asChild variant="primary">
              <Link to="/dashboard">Go to Dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // 3b. Non-member visiting a Full Room -> "Room is Full" screen (PRD ROOM-4)
  if (!isMember && room.memberCount >= 6) {
    return (
      <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
        <EmptyState
          title="Room is Full"
          description="This practice room has reached its maximum capacity of 6 participants."
          icon={<Users className="h-10 w-10 text-text-subtle" />}
          action={
            <Button asChild variant="primary">
              <Link to="/dashboard">Back to Dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // 4. Join Flow (Non-member, Open Room)
  if (!isMember) {
    return (
      <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4 py-12">
        <div className="max-w-md w-full bg-surface border border-border-subtle rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="flex items-center justify-between border-b border-border-subtle pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-primary uppercase tracking-wider mb-1">
                <Sparkles className="h-3.5 w-3.5" />
                Practice Room
              </div>
              <h1 className="text-xl font-bold tracking-tight text-text-primary">
                {room.title}
              </h1>
            </div>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium uppercase bg-surface-subtle border border-border-subtle text-text-secondary">
              {room.language}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <span className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-text-subtle" />
              {room.memberCount}/6 participants
            </span>
            <span className="flex items-center gap-1.5">
              <Code2 className="h-4 w-4 text-text-subtle" />
              Shared Coding
            </span>
          </div>

          {/* Guest Eviction Warning (PRD AUTH-3) */}
          {!user && (
            <div
              role="note"
              className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg p-3.5 text-xs text-warning-text"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-warning-text" />
              <div className="leading-relaxed">
                <strong className="font-semibold block mb-0.5">
                  Guest Eviction Notice:
                </strong>
                Active guest participation is limited to one room at a time; joining this
                room will disconnect and replace your guest session in any previous room.
              </div>
            </div>
          )}

          {joinError && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-text"
            >
              {joinError}
            </div>
          )}

          {/* Join Form */}
          {user ? (
            <div className="space-y-4 pt-2">
              <div className="text-sm text-text-secondary">
                Signed in as{" "}
                <strong className="text-text-primary">{user.displayName}</strong>
              </div>
              <Button
                variant="primary"
                onClick={() => handleJoin()}
                isLoading={isJoining}
                disabled={Boolean(countdown)}
                className="w-full"
              >
                Join as {user.displayName}
              </Button>
            </div>
          ) : (
            <form onSubmit={handleJoin} className="space-y-4 pt-2">
              <Input
                id="guest-name"
                label="Your Display Name"
                placeholder="e.g. CodeExplorer"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                maxLength={40}
                required
                disabled={isJoining || Boolean(countdown)}
                helperText="1–40 characters visible to other participants in this room."
              />

              <Button
                type="submit"
                variant="primary"
                isLoading={isJoining}
                disabled={Boolean(countdown) || !guestName.trim()}
                className="w-full"
              >
                {countdown ? `Please wait (${countdown}s)` : "Join as Guest"}
              </Button>

              <div className="text-center pt-2">
                <Link
                  to={`/login?returnTo=/r/${slug}`}
                  className="text-xs text-text-subtle hover:text-text-primary underline underline-offset-2"
                >
                  Prefer to sign in with GitHub or Google?
                </Link>
              </div>
            </form>
          )}

          <div className="border-t border-border-subtle pt-4 text-center">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-1.5 text-xs text-text-subtle hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 5. Active Room Shell (Member View)
  const fullRoom = room as RoomDto;
  const totalMembersCount = members.length > 0 ? members.length : fullRoom.memberCount;

  // Local connection state: current user is online when either sync WebSocket or room Socket.IO is connected
  const isLocalConnected =
    sync.status === "connected" || roomSocket.connectionStatus === "connected";

  const isMemberOnline = (m: RoomMemberDetailDto) => {
    const isCurrent = currentMember?.id ? m.id === currentMember.id : false;
    if (isCurrent) {
      return isLocalConnected;
    }
    if (
      roomSocket.connectionStatus === "connected" &&
      roomSocket.onlineMemberIds.size > 0
    ) {
      return roomSocket.onlineMemberIds.has(m.id);
    }
    return Boolean(m.isOnline);
  };

  const computedOnlineCount = isLocalConnected
    ? members.filter((m) => isMemberOnline(m)).length
    : 0;

  const onlineCount = isLocalConnected
    ? typeof onlineMemberCount === "number" && onlineMemberCount > 0
      ? Math.max(onlineMemberCount, computedOnlineCount)
      : Math.max(1, computedOnlineCount)
    : 0;

  return (
    <div className="h-screen max-h-screen bg-canvas text-text-primary flex flex-col overflow-hidden">
      {/* Ended Room Read-Only Notice */}
      {isEnded && (
        <div
          role="banner"
          data-testid="room-ended-banner"
          className="bg-muted text-text-secondary border-b border-border-subtle px-4 py-2 text-center text-xs font-medium flex items-center justify-center gap-2 shrink-0"
        >
          <Lock className="h-3.5 w-3.5" />
          This room has ended and is in read-only mode.
        </div>
      )}

      {/* Room Application Header */}
      <header className="border-b border-border-subtle bg-surface/90 backdrop-blur-md sticky top-0 z-20 h-14 px-3 sm:px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <Link
            to="/dashboard"
            className="flex items-center gap-1.5 text-xs text-text-subtle hover:text-text-primary transition-colors shrink-0"
            title="Back to Dashboard"
            aria-label="Back to Dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden md:inline font-medium">Dashboard</span>
          </Link>

          <span className="h-4 w-px bg-border-subtle shrink-0" />

          <div className="flex items-center gap-2 min-w-0">
            <h1 className="font-semibold text-sm sm:text-base text-text-primary truncate max-w-[140px] sm:max-w-xs md:max-w-md">
              {fullRoom.title}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-subtle border border-border-subtle text-text-secondary uppercase shrink-0">
              {selectedLanguage ?? fullRoom.language}
            </span>
            <span
              className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border border-border-subtle bg-surface-subtle shrink-0"
              title={`Connection: ${roomSocket.connectionStatus}`}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  isLocalConnected ? "bg-success" : "bg-warning animate-pulse"
                )}
              />
              <span className={isLocalConnected ? "text-success" : "text-warning"}>
                {isLocalConnected ? "Connected" : "Reconnecting"}
              </span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Upper Layout Toggle Buttons Group (Independent Members & Chat controls) */}
          <div
            role="group"
            aria-label="Panel layout controls"
            className="flex items-center bg-surface-subtle p-0.5 sm:p-1 rounded-xl border border-border-subtle shadow-xs gap-1"
          >
            {/* Toggle Members Panel */}
            <Button
              ref={membersTriggerRef}
              variant="ghost"
              size="sm"
              onClick={toggleMembers}
              aria-label={`Toggle participants panel (${onlineCount} online)`}
              aria-expanded={isMembersOpen}
              aria-controls="members-panel"
              title="Toggle Participants Panel (Left)"
              data-testid="members-toggle-button"
              className={cn(
                "gap-1.5 h-8 px-2.5 text-xs font-medium transition-all",
                isMembersOpen
                  ? "bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 shadow-xs"
                  : "text-text-subtle hover:text-text-primary hover:bg-surface"
              )}
            >
              <Users className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Members</span>
              <span className="px-1.5 py-0.2 rounded-full bg-surface text-[10px] font-mono text-text-secondary border border-border-subtle">
                {onlineCount}
              </span>
            </Button>

            {/* Toggle Chat Panel */}
            <Button
              ref={chatTriggerRef}
              variant="ghost"
              size="sm"
              onClick={toggleChat}
              aria-label={`Toggle chat panel${unreadCount > 0 && !isChatOpen ? `, ${unreadCount} unread message${unreadCount === 1 ? "" : "s"}` : ""}`}
              aria-expanded={isChatOpen}
              aria-controls="chat-panel"
              title="Toggle Room Chat Panel (Right)"
              data-testid="chat-trigger-button"
              className={cn(
                "relative gap-1.5 h-8 px-2.5 text-xs font-medium transition-all",
                isChatOpen
                  ? "bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 shadow-xs"
                  : "text-text-subtle hover:text-text-primary hover:bg-surface"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Chat</span>
              <ChatUnreadBadge
                count={unreadCount}
                className="absolute -top-1.5 -right-1.5"
              />
            </Button>
          </div>

          <span className="h-4 w-px bg-border-subtle hidden sm:block" />

          {/* Share Link Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLink}
            className="gap-1.5 text-xs h-8 px-2.5"
            title="Copy room invite link"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-success" />
                <span className="hidden sm:inline text-success font-medium">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Share Link</span>
              </>
            )}
          </Button>

          {/* Room Capacity Badge */}
          <div
            className="flex items-center gap-1 bg-surface-subtle border border-border-subtle rounded-lg px-2.5 py-1 text-xs"
            title={`${totalMembersCount} of 6 maximum room members`}
          >
            <Users className="h-3.5 w-3.5 text-text-subtle mr-1" />
            <span className="font-mono text-[11px] text-text-secondary font-medium">
              {totalMembersCount}/6 members
            </span>
          </div>
        </div>
      </header>

      {/* Main Symmetrical Three-Column Collaborative Workspace */}
      <main className="flex-1 flex overflow-hidden relative min-h-0">
        {/* Mobile Backdrop for Members Drawer */}
        {isMembersOpen && (
          <div
            className="lg:hidden fixed inset-0 z-40 bg-overlay/60 backdrop-blur-xs animate-in fade-in duration-200"
            onClick={() => setIsMembersOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Left Column: Members / Participants Panel */}
        {isMembersOpen && (
          <MembersPanel
            members={members}
            currentMember={currentMember}
            isLocalConnected={isLocalConnected}
            onlineCount={onlineCount}
            totalMembersCount={totalMembersCount}
            isMemberOnline={isMemberOnline}
            isOpen={isMembersOpen}
            onToggle={() => setIsMembersOpen(false)}
            triggerRef={membersTriggerRef}
            copied={copied}
            onCopyLink={handleCopyLink}
            width={membersWidth}
            className="fixed inset-y-0 left-0 z-50 w-full sm:w-80 lg:static lg:shrink-0 lg:z-auto h-full"
          />
        )}

        {/* Left Resize Handle (between Members panel and Code Editor) */}
        {isMembersOpen && (
          <ResizeHandle
            side="left"
            currentWidth={membersWidth}
            minWidth={220}
            maxWidth={400}
            onResize={setMembersWidth}
            onReset={() => setMembersWidth(280)}
            ariaLabel="Resize participants panel"
          />
        )}

        {/* Center Column: Monaco Collaborative Code Editor + Terminal */}
        <section className="flex-1 min-w-0 flex flex-col bg-canvas p-3 lg:p-4 overflow-hidden space-y-3">
          <Suspense
            fallback={
              <div
                data-testid="editor-loading-fallback"
                className="flex flex-1 items-center justify-center min-h-[400px] bg-canvas-subtle border border-border rounded-xl text-text-muted text-sm font-mono"
              >
                Loading collaborative editor...
              </div>
            }
          >
            <CollaborativeEditor
              doc={sync.doc}
              provider={sync.provider}
              status={sync.status}
              isSynced={sync.isSynced}
              error={sync.error}
              language={selectedLanguage ?? fullRoom.language}
              onLanguageChange={setSelectedLanguage}
              readOnly={isEnded || currentMember?.role === "viewer"}
              user={{
                name:
                  user?.displayName ||
                  currentMember?.displayName ||
                  guestName ||
                  "Participant",
                color:
                  PARTICIPANT_PALETTE[
                    members.length > 0
                      ? Math.max(
                          0,
                          members.findIndex((m) =>
                            currentMember?.id
                              ? m.id === currentMember.id
                              : m.displayName ===
                                (user?.displayName ||
                                  currentMember?.displayName ||
                                  guestName)
                          )
                        ) % PARTICIPANT_PALETTE.length
                      : 0
                  ] || (PARTICIPANT_PALETTE[0] as string),
              }}
            />
          </Suspense>

          {/* Terminal / Execution Output Area */}
          <div className="h-36 lg:h-40 bg-surface border border-border-subtle rounded-xl flex flex-col overflow-hidden shrink-0 shadow-xs">
            <div className="border-b border-border-subtle bg-surface-subtle px-3.5 py-1.5 flex items-center justify-between text-xs font-mono text-text-subtle">
              <div className="flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-primary" />
                <span className="font-medium text-text-secondary">
                  Terminal & Execution Output
                </span>
              </div>
              <span className="text-[10px] text-text-subtle/70">Console</span>
            </div>
            <div className="flex-1 p-3 font-mono text-xs text-text-subtle bg-canvas/50 overflow-y-auto custom-scroll">
              $ Ready for code execution. Output will appear here.
            </div>
          </div>
        </section>

        {/* Right Resize Handle (between Code Editor and Chat panel) */}
        {isChatOpen && (
          <ResizeHandle
            side="right"
            currentWidth={chatWidth}
            minWidth={260}
            maxWidth={480}
            onResize={setChatWidth}
            onReset={() => setChatWidth(320)}
            ariaLabel="Resize chat panel"
          />
        )}

        {/* Right Column: Live Chat Panel */}
        <ChatPanel
          messages={roomSocket.messages}
          currentUserId={currentMember?.id || ""}
          isOpen={isChatOpen}
          onToggle={() => setIsChatOpen((prev) => !prev)}
          onSendMessage={roomSocket.sendMessage}
          onRetryMessage={roomSocket.retryMessage}
          onRefetchHistory={roomSocket.refetchHistory}
          connectionStatus={roomSocket.connectionStatus}
          isRateLimited={roomSocket.isRateLimited}
          rateLimitCountdown={roomSocket.rateLimitCountdown}
          isRoomEnded={isEnded}
          isLoadingHistory={roomSocket.isLoadingHistory}
          loadHistoryError={roomSocket.loadHistoryError}
          hasEarlierMessages={roomSocket.hasEarlierMessages}
          triggerRef={chatTriggerRef}
          onUnreadCountChange={setUnreadCount}
          width={chatWidth}
          className="fixed inset-y-0 right-0 z-50 w-full sm:w-80 lg:static lg:shrink-0 lg:z-auto h-full"
        />

        {/* Mobile Backdrop for Chat Drawer */}
        {isChatOpen && (
          <div
            className="lg:hidden fixed inset-0 z-40 bg-overlay/60 backdrop-blur-xs animate-in fade-in duration-200"
            onClick={() => setIsChatOpen(false)}
            aria-hidden="true"
          />
        )}
      </main>
    </div>
  );
}
