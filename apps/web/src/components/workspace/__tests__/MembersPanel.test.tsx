import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MembersPanel } from "../MembersPanel.js";
import type { RoomMemberDetailDto } from "@pairprep/shared";

describe("MembersPanel component", () => {
  const currentMember: RoomMemberDetailDto = {
    id: "mem-1",
    displayName: "Alice Host",
    role: "owner",
    isGuest: false,
    joinedAt: new Date().toISOString(),
    isOnline: true,
  };

  const sampleMembers: RoomMemberDetailDto[] = [
    currentMember,
    {
      id: "mem-2",
      displayName: "Bob Candidate",
      role: "editor",
      isGuest: false,
      joinedAt: new Date().toISOString(),
      isOnline: true,
    },
    {
      id: "mem-3",
      displayName: "Charlie Observer",
      role: "viewer",
      isGuest: false,
      joinedAt: new Date().toISOString(),
      isOnline: false,
    },
  ];

  it("renders participants with counts, role badges, and online statuses", () => {
    const onToggleMock = vi.fn();
    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={onToggleMock}
      />
    );

    expect(screen.getByTestId("members-panel")).toBeInTheDocument();
    expect(screen.getByTestId("participant-counts")).toHaveTextContent(
      "2 online · 3 members"
    );

    // Member 1 (Alice)
    expect(screen.getByTestId("participant-mem-1")).toBeInTheDocument();
    expect(screen.getByText("(You)")).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-mem-1")).toHaveTextContent("Online");

    // Member 2 (Bob)
    expect(screen.getByTestId("participant-mem-2")).toBeInTheDocument();
    expect(screen.getByText("Bob Candidate")).toBeInTheDocument();

    // Member 3 (Charlie)
    expect(screen.getByTestId("participant-mem-3")).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-mem-3")).toHaveTextContent("Offline");
  });

  it("calls onToggle when close button is clicked", () => {
    const onToggleMock = vi.fn();
    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={onToggleMock}
      />
    );

    const closeBtn = screen.getByTestId("members-panel-close-button");
    fireEvent.click(closeBtn);
    expect(onToggleMock).toHaveBeenCalledTimes(1);
  });

  it("traps focus and handles Escape in mobile drawer mode", () => {
    const onToggleMock = vi.fn();
    const triggerBtn = document.createElement("button");
    document.body.appendChild(triggerBtn);
    const triggerRef = { current: triggerBtn };

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={onToggleMock}
        triggerRef={triggerRef}
        isMobileDrawer={true}
        onCopyLink={vi.fn()}
      />
    );

    const panel = screen.getByTestId("members-panel");
    const closeBtn = screen.getByTestId("members-panel-close-button");

    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    // Escape closes panel
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onToggleMock).toHaveBeenCalled();

    triggerBtn.remove();
  });
});
