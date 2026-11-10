import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncStatusIndicator } from "../SyncStatusIndicator.js";

describe("SyncStatusIndicator", () => {
  it("renders connected and synced state correctly", () => {
    render(<SyncStatusIndicator status="connected" isSynced={true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Synced");
  });

  it("renders syncing state when connected but not yet synced", () => {
    render(<SyncStatusIndicator status="connected" isSynced={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Syncing...");
  });

  it("renders connecting state", () => {
    render(<SyncStatusIndicator status="connecting" />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting...");
  });

  it("renders reconnecting state", () => {
    render(<SyncStatusIndicator status="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting...");
  });

  it("renders offline state with tooltip description", () => {
    render(<SyncStatusIndicator status="offline" />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Offline");
    expect(el).toHaveAttribute(
      "title",
      "Network unavailable. Local edits preserved in memory."
    );
  });

  it("renders error state with accessible error message", () => {
    render(
      <SyncStatusIndicator
        status="error"
        error={new Error("WebSocket connection rejected: 4003")}
      />
    );
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Sync Error");
    expect(el).toHaveAttribute("title", "WebSocket connection rejected: 4003");
  });

  it("renders disconnected state", () => {
    render(<SyncStatusIndicator status="disconnected" />);
    expect(screen.getByRole("status")).toHaveTextContent("Disconnected");
  });
});
