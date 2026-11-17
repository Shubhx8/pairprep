import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
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

  it("shows kick button only for owners on other non-owner participants", () => {
    const onRemoveMember = vi.fn().mockResolvedValue(undefined);

    // 1. Owner view
    const { unmount } = render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember} // role: "owner", id: "mem-1"
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onRemoveMember={onRemoveMember}
      />
    );

    // Owner should NOT have a remove button for themselves
    expect(screen.queryByTestId("remove-member-mem-1")).toBeNull();
    // Owner SHOULD have remove buttons for editor (mem-2) and viewer (mem-3)
    expect(screen.getByTestId("remove-member-mem-2")).toBeInTheDocument();
    expect(screen.getByTestId("remove-member-mem-3")).toBeInTheDocument();

    unmount();

    // 2. Non-owner view (editor)
    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={sampleMembers[1]!} // role: "editor", id: "mem-2"
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onRemoveMember={onRemoveMember}
      />
    );

    // Editor should not see any remove buttons
    expect(screen.queryByTestId("remove-member-mem-1")).toBeNull();
    expect(screen.queryByTestId("remove-member-mem-2")).toBeNull();
    expect(screen.queryByTestId("remove-member-mem-3")).toBeNull();
  });

  it("opens confirmation modal and calls onRemoveMember on confirm", async () => {
    const onRemoveMember = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onRemoveMember={onRemoveMember}
      />
    );

    // Click remove button for Bob Candidate
    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-member-mem-2"));
    });

    // Modal should be displayed
    const modal = screen.getByTestId("remove-member-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText(/Bob Candidate/)).toBeInTheDocument();

    // Confirm removal
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-remove-button"));
    });

    expect(onRemoveMember).toHaveBeenCalledWith("mem-2");
  });

  it("renders interactive role dropdown for owners on non-owners and calls onUpdateRole", async () => {
    const onUpdateRole = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember} // role: "owner"
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onUpdateRole={onUpdateRole}
      />
    );

    // Bob is editor -> role dropdown should be rendered
    const roleDropdown = screen.getByTestId("role-dropdown-mem-2");
    expect(roleDropdown).toBeInTheDocument();
    expect(roleDropdown).toHaveTextContent("editor");

    // Open dropdown
    await act(async () => {
      fireEvent.click(roleDropdown);
    });

    // Options should be visible
    const viewerOption = screen.getByTestId("role-option-viewer-mem-2");
    expect(viewerOption).toBeInTheDocument();

    // Click viewer option
    await act(async () => {
      fireEvent.click(viewerOption);
    });

    expect(onUpdateRole).toHaveBeenCalledWith("mem-2", "viewer");
  });

  it("renders three-dot contextual menu with separate Kick and Permanently Ban actions", async () => {
    const onKickMember = vi.fn().mockResolvedValue(undefined);
    const onBanMember = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onKickMember={onKickMember}
        onBanMember={onBanMember}
      />
    );

    // Open three-dot menu for mem-2
    const actionsBtn = screen.getByTestId("member-actions-mem-2");
    expect(actionsBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(actionsBtn);
    });

    // Both options should be present
    expect(screen.getByTestId("kick-member-option-mem-2")).toBeInTheDocument();
    expect(screen.getByTestId("ban-member-option-mem-2")).toBeInTheDocument();
  });

  it("opens Kick confirmation modal with distinct message and calls onKickMember on confirm", async () => {
    const onKickMember = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onKickMember={onKickMember}
      />
    );

    // Open three-dot menu
    await act(async () => {
      fireEvent.click(screen.getByTestId("member-actions-mem-2"));
    });

    // Click Kick option
    await act(async () => {
      fireEvent.click(screen.getByTestId("kick-member-option-mem-2"));
    });

    // Kick modal should open with specific message
    const modal = screen.getByTestId("kick-member-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText(/Kick member\?/)).toBeInTheDocument();
    expect(
      within(modal).getByText(/temporarily prevented from rejoining/)
    ).toBeInTheDocument();

    // Confirm kick
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-kick-button"));
    });

    expect(onKickMember).toHaveBeenCalledWith("mem-2");
  });

  it("opens Permanent Ban confirmation modal with distinct message and calls onBanMember on confirm", async () => {
    const onBanMember = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onBanMember={onBanMember}
      />
    );

    // Open three-dot menu
    await act(async () => {
      fireEvent.click(screen.getByTestId("member-actions-mem-2"));
    });

    // Click Ban option
    await act(async () => {
      fireEvent.click(screen.getByTestId("ban-member-option-mem-2"));
    });

    // Ban modal should open with specific message
    const modal = screen.getByTestId("ban-member-modal");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText(/Permanently ban member\?/)).toBeInTheDocument();
    expect(
      within(modal).getByText(/permanently prevented from rejoining/)
    ).toBeInTheDocument();

    // Confirm ban
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-ban-button"));
    });

    expect(onBanMember).toHaveBeenCalledWith("mem-2");
  });

  it("cancels kick modal without performing operation when Cancel is clicked", async () => {
    const onKickMember = vi.fn().mockResolvedValue(undefined);

    render(
      <MembersPanel
        members={sampleMembers}
        currentMember={currentMember}
        isLocalConnected={true}
        onlineCount={2}
        totalMembersCount={3}
        isMemberOnline={(m) => m.isOnline === true}
        isOpen={true}
        onToggle={vi.fn()}
        onKickMember={onKickMember}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("member-actions-mem-2"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("kick-member-option-mem-2"));
    });

    expect(screen.getByTestId("kick-member-modal")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cancel-kick-button"));
    });

    expect(screen.queryByTestId("kick-member-modal")).toBeNull();
    expect(onKickMember).not.toHaveBeenCalled();
  });
});
