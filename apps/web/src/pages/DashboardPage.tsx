import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/authContext.js";
import { apiClient, ApiClientError } from "../lib/apiClient.js";
import type { RoomDto, RoomListResponse } from "@pairprep/shared";
import { CreateRoomDialog } from "../components/CreateRoomDialog.js";
import { ProfileModal } from "../components/ProfileModal.js";
import { Button } from "../components/ui/Button.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import {
  Plus,
  Code2,
  Users,
  LogOut,
  FolderCode,
  ArrowRight,
  Clock,
  Sparkles,
} from "lucide-react";

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user, status, logout } = useAuth();
  const [rooms, setRooms] = useState<RoomDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  useEffect(() => {
    document.title = "Dashboard · PairPrep";
  }, []);

  const fetchRooms = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiClient.get<RoomListResponse>("/rooms?limit=12");
      setRooms(data.rooms);
      setNextCursor(data.nextCursor);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ message: err.message, requestId: err.requestId });
      } else {
        setError({ message: "Failed to load rooms. Please try again." });
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchRooms();
    } else if (status === "anonymous") {
      setIsLoading(false);
    }
  }, [status, fetchRooms]);

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);

    try {
      const data = await apiClient.get<RoomListResponse>(
        `/rooms?limit=12&cursor=${encodeURIComponent(nextCursor)}`
      );
      setRooms((prev) => [...prev, ...data.rooms]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ message: err.message, requestId: err.requestId });
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  // If visitor is anonymous, render sign-in prompt
  if (status === "anonymous") {
    return (
      <div className="min-h-screen bg-canvas text-text-primary flex flex-col justify-center items-center px-4">
        <div className="max-w-md w-full bg-surface border border-border-subtle rounded-2xl p-8 text-center shadow-xl">
          <div className="inline-flex p-3 rounded-xl bg-primary/10 text-primary mb-4">
            <FolderCode className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Sign in to your Dashboard</h1>
          <p className="mt-2 text-sm text-text-secondary leading-relaxed">
            Access your practice history, active collaborative sessions, and shared
            workspaces.
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <Button asChild variant="primary" className="w-full">
              <Link to="/login?returnTo=/dashboard">Sign In with OAuth</Link>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link to="/">Back to Homepage</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-text-primary flex flex-col">
      {/* Top Application Header */}
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="flex items-center gap-2 font-bold text-lg tracking-tight text-text-primary"
            >
              <div className="h-7 w-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center text-primary">
                <Code2 className="h-4 w-4" />
              </div>
              PairPrep
            </Link>
            <nav className="hidden sm:flex items-center gap-4 text-sm font-medium">
              <span className="text-text-primary px-3 py-1.5 rounded-lg bg-surface-hover">
                Dashboard
              </span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsCreateOpen(true)}
              className="gap-1.5 shadow-sm"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Room</span>
            </Button>

            {user && (
              <div className="flex items-center gap-2 pl-2 border-l border-border-subtle">
                <button
                  type="button"
                  onClick={() => setIsProfileOpen(true)}
                  className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer text-left"
                  title="Edit Profile"
                >
                  <div className="h-8 w-8 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center font-semibold text-xs text-primary">
                    {user.displayName.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm font-medium text-text-secondary hidden md:inline max-w-[120px] truncate">
                    {user.displayName}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => logout()}
                  title="Sign out"
                  aria-label="Sign out"
                  className="text-text-subtle hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 mx-auto max-w-7xl w-full px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Practice Rooms
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              Your recent collaborative coding sessions and active rooms.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreateOpen(true)}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4 text-primary" />
              Start a Room
            </Button>
          </div>
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div
                key={idx}
                className="bg-surface border border-border-subtle rounded-xl p-5 space-y-3"
              >
                <div className="flex justify-between items-center">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-16" />
                </div>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="pt-2 border-t border-border-subtle flex justify-between">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <ErrorState
            title="Unable to load your rooms"
            message={error.message}
            requestId={error.requestId}
            onRetry={fetchRooms}
          />
        )}

        {/* Empty State */}
        {!isLoading && !error && rooms.length === 0 && (
          <EmptyState
            title="No rooms created yet"
            description="Create your first practice room to collaborate in real-time, execute code in a disposable container, and practice technical questions."
            icon={<FolderCode className="h-10 w-10 text-primary" />}
            action={
              <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" /> Create a Practice Room
              </Button>
            }
          />
        )}

        {/* Rooms Grid */}
        {!isLoading && !error && rooms.length > 0 && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rooms.map((room) => {
                const isOwner = user?.id === room.ownerId;
                const dateStr = new Date(room.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });

                return (
                  <div
                    key={room.id}
                    className="group bg-surface hover:bg-surface-hover border border-border-subtle hover:border-primary/40 rounded-xl p-5 transition-all duration-150 flex flex-col justify-between shadow-sm"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium uppercase tracking-wide bg-surface-subtle border border-border-subtle text-text-secondary">
                          <Code2 className="h-3 w-3 text-primary" />
                          {room.language}
                        </span>

                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            room.status === "ended" || room.status === "archived"
                              ? "bg-muted text-text-subtle"
                              : "bg-primary/10 text-primary"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              room.status === "ended" || room.status === "archived"
                                ? "bg-text-subtle"
                                : "bg-primary animate-pulse"
                            }`}
                          />
                          {room.status}
                        </span>
                      </div>

                      <h3 className="font-semibold text-base text-text-primary group-hover:text-primary transition-colors line-clamp-1">
                        {room.title}
                      </h3>

                      <div className="mt-3 flex items-center gap-4 text-xs text-text-subtle">
                        <span className="flex items-center gap-1">
                          <Users className="h-3.5 w-3.5" />
                          {room.memberCount}/6 participants
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {dateStr}
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 pt-4 border-t border-border-subtle flex items-center justify-between">
                      <span className="text-[11px] font-mono text-text-subtle">
                        {isOwner ? "Owner" : "Participant"}
                      </span>

                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => navigate(`/r/${room.slug}`)}
                        className="gap-1 text-xs group-hover:bg-primary group-hover:text-primary-foreground transition-colors"
                      >
                        Enter Room <ArrowRight className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cursor Pagination Button */}
            {nextCursor && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  isLoading={isLoadingMore}
                  className="px-6"
                >
                  Load More Rooms
                </Button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Create Room Modal */}
      <CreateRoomDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onCreated={(newRoom) => {
          setRooms((prev) => [newRoom, ...prev]);
        }}
      />

      {/* Profile Settings Modal */}
      <ProfileModal open={isProfileOpen} onOpenChange={setIsProfileOpen} />
    </div>
  );
}
