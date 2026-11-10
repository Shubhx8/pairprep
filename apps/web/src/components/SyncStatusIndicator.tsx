import type { FC } from "react";
import type { RoomSyncStatus } from "../hooks/useRoomSync.js";

export interface SyncStatusIndicatorProps {
  status: RoomSyncStatus;
  isSynced?: boolean;
  error?: Error | null;
  className?: string;
}

/**
 * Status indicator for the collaborative code editor synchronization state.
 * Translates useRoomSync status, synced state, and errors into accessible,
 * color-coded UI badges per PRD ED-4.
 */
export const SyncStatusIndicator: FC<SyncStatusIndicatorProps> = ({
  status,
  isSynced = false,
  error = null,
  className = "",
}) => {
  let dotColor = "bg-text-subtle";
  let pulse = false;
  let label = "Disconnected";
  let description = "Not connected to collaboration server.";

  switch (status) {
    case "connected":
      if (isSynced) {
        dotColor = "bg-success";
        pulse = false;
        label = "Synced";
        description = "All changes synchronized with server.";
      } else {
        dotColor = "bg-primary";
        pulse = true;
        label = "Syncing...";
        description = "Exchanging document updates with server.";
      }
      break;
    case "connecting":
      dotColor = "bg-warning";
      pulse = true;
      label = "Connecting...";
      description = "Establishing connection to collaboration server.";
      break;
    case "reconnecting":
      dotColor = "bg-warning";
      pulse = true;
      label = "Reconnecting...";
      description = "Connection lost. Reconnecting to collaboration server.";
      break;
    case "offline":
      dotColor = "bg-warning";
      pulse = false;
      label = "Offline";
      description = "Network unavailable. Local edits preserved in memory.";
      break;
    case "error":
      dotColor = "bg-destructive";
      pulse = false;
      label = "Sync Error";
      description = error?.message || "Failed to synchronize with server.";
      break;
    case "disconnected":
    default:
      dotColor = "bg-text-subtle";
      pulse = false;
      label = "Disconnected";
      description = "Disconnected from room session.";
      break;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border border-border-subtle bg-surface-subtle text-text-secondary select-none ${className}`}
      title={description}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${dotColor} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="font-mono text-[11px]">{label}</span>
      {status === "error" && error && <span className="sr-only">: {description}</span>}
    </div>
  );
};
