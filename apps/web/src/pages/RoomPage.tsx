import { useState, useEffect, useCallback, lazy, Suspense, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../lib/authContext.js";
import { apiClient, ApiClientError } from "../lib/apiClient.js";
import type { RoomDto, PublicRoomDto, RoomMemberDetailDto } from "@pairprep/shared";
import { PARTICIPANT_PALETTE } from "@pairprep/shared";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import type { SupportedEditorLanguage } from "../components/CodeEditor.js";
import { useRoomSync } from "../hooks/useRoomSync.js";
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
} from "lucide-react";

export default function RoomPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();

  const [room, setRoom] = useState<RoomDto | PublicRoomDto | null>(null);
  const [currentMember, setCurrentMember] = useState<RoomMemberDetailDto | null>(null);
  const [members, setMembers] = useState<RoomMemberDetailDto[]>([]);
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

  // Sync client hook: only enabled when visitor is an active room member with valid 24-char ObjectId
  const roomId = room && "id" in room && isValidRoomId(room.id) ? room.id : null;
  const isSyncEnabled = Boolean(currentMember && roomId);
  const sync = useRoomSync({ roomId, enabled: isSyncEnabled });

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
      }>(`/rooms/${slug}`);

      setRoom(res.room);
      setCurrentMember(res.currentMember ?? null);
      setMembers(res.members ?? []);
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

  // Live participant list polling (ROOM-5)
  useEffect(() => {
    if (!currentMember) return;
    const interval = setInterval(() => {
      fetchRoom();
    }, 4000);
    return () => clearInterval(interval);
  }, [currentMember, fetchRoom]);

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

  if (!room) return null;

  const isMember = Boolean(currentMember);
  const isEnded = room.status === "ended" || room.status === "archived";

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

  return (
    <div className="min-h-screen bg-canvas text-text-primary flex flex-col">
      {/* Ended Room Read-Only Notice */}
      {isEnded && (
        <div
          role="banner"
          className="bg-muted text-text-secondary border-b border-border-subtle px-4 py-2 text-center text-xs font-medium flex items-center justify-center gap-2"
        >
          <Lock className="h-3.5 w-3.5" />
          This room has ended and is in read-only mode.
        </div>
      )}

      {/* Room Application Header */}
      <header className="border-b border-border-subtle bg-surface/90 backdrop-blur-md sticky top-0 z-20 h-14 px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/dashboard"
            className="flex items-center gap-1.5 text-xs text-text-subtle hover:text-text-primary mr-2"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>

          <span className="h-4 w-px bg-border-subtle" />

          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-sm sm:text-base text-text-primary truncate max-w-[200px] sm:max-w-md">
              {fullRoom.title}
            </h1>
            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-surface-subtle border border-border-subtle text-text-secondary uppercase">
              {fullRoom.language}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Share Link Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLink}
            className="gap-1.5 text-xs h-8"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-success" />
                <span className="hidden sm:inline text-success">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Share Link</span>
              </>
            )}
          </Button>

          {/* Participants Avatars */}
          <div className="flex items-center gap-1 bg-surface-subtle border border-border-subtle rounded-lg px-2.5 py-1 text-xs">
            <Users className="h-3.5 w-3.5 text-text-subtle mr-1" />
            <span className="font-mono font-medium">
              {members.length > 0 ? members.length : fullRoom.memberCount}/6
            </span>
          </div>
        </div>
      </header>

      {/* Editor & Collaboration Workspace Placeholder (Phase 2 integration anchor) */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr] overflow-hidden">
        {/* Sidebar: Participants & Room Info */}
        <aside className="border-r border-border-subtle bg-surface/50 p-4 space-y-6 hidden lg:block overflow-y-auto">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">
              Participants ({members.length > 0 ? members.length : fullRoom.memberCount})
            </h2>
            <div className="space-y-2">
              {members.length > 0 ? (
                members.map((m, idx) => {
                  const isCurrent =
                    m.id === currentMember?.id ||
                    m.displayName === (user?.displayName || guestName);
                  const participantColor =
                    PARTICIPANT_PALETTE[idx % PARTICIPANT_PALETTE.length] ||
                    (PARTICIPANT_PALETTE[0] as string);

                  return (
                    <div
                      key={m.id}
                      data-testid={`participant-${m.id}`}
                      className="flex items-center justify-between p-2 rounded-lg bg-surface border border-border-subtle text-xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <div
                          className="h-6 w-6 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 border"
                          style={{
                            borderColor: participantColor,
                            color: participantColor,
                            backgroundColor: `${participantColor}22`,
                          }}
                        >
                          {m.displayName.charAt(0).toUpperCase()}
                        </div>
                        <span className="truncate font-medium text-text-primary">
                          {m.displayName}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] text-primary font-mono ml-1 font-semibold">
                            (You)
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-text-subtle uppercase px-1.5 py-0.5 rounded bg-surface-subtle border border-border-subtle">
                        {m.role}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-surface border border-border-subtle text-xs">
                  <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center font-bold text-[10px] text-primary">
                    {currentMember?.displayName.charAt(0).toUpperCase() || "Y"}
                  </div>
                  <span className="font-medium text-text-primary">
                    {currentMember?.displayName || "You"}
                  </span>
                  <span className="text-[10px] text-primary font-mono font-semibold">
                    (You)
                  </span>
                  <span className="text-[10px] font-mono text-text-subtle ml-auto uppercase">
                    {currentMember?.role || "editor"}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-surface p-3.5 text-xs text-text-subtle space-y-1.5">
            <div className="font-medium text-text-primary">Unguessable Link:</div>
            <div className="font-mono text-[11px] truncate bg-surface-subtle p-1.5 rounded border border-border-subtle">
              {window.location.href}
            </div>
          </div>
        </aside>

        {/* Center: Collaborative Workspace */}
        <section className="flex flex-col bg-canvas p-4 sm:p-6 overflow-hidden space-y-4">
          <Suspense
            fallback={
              <div
                data-testid="editor-loading-fallback"
                className="flex flex-1 items-center justify-center min-h-[400px] bg-canvas-subtle border border-border rounded-lg text-text-muted text-sm font-mono"
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
                          members.findIndex(
                            (m) =>
                              m.displayName ===
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

          {/* Terminal / Output Placeholder */}
          <div className="h-40 bg-surface border border-border-subtle rounded-xl flex flex-col overflow-hidden">
            <div className="border-b border-border-subtle bg-surface-subtle px-4 py-2 flex items-center gap-2 text-xs font-mono text-text-subtle">
              <Terminal className="h-3.5 w-3.5" />
              <span>Terminal & Execution Output</span>
            </div>
            <div className="flex-1 p-3 font-mono text-xs text-text-subtle bg-canvas/50">
              $ Ready for code execution. Output will appear here.
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
