import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RoomPage from "../RoomPage.js";
import { apiClient, ApiClientError, roomApi } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import * as roomSyncModule from "../../hooks/useRoomSync.js";
import type {
  RoomDto,
  PublicRoomDto,
  RoomMemberDetailDto,
  UserPrivateDto,
} from "@pairprep/shared";
import "../../components/CollaborativeEditor.js";

describe("RoomPage", () => {
  const mockRoom: RoomDto = {
    id: "rm_100",
    slug: "dynamic-prog-9876",
    title: "Dynamic Programming Practice",
    type: "practice",
    language: "python",
    status: "open",
    ownerId: "usr_alice",
    memberCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockPublicRoom: PublicRoomDto = {
    slug: "dynamic-prog-9876",
    title: "Dynamic Programming Practice",
    type: "practice",
    language: "python",
    status: "open",
    memberCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockMember: RoomMemberDetailDto = {
    id: "mbr_1",
    displayName: "Alice Dev",
    role: "owner",
    isGuest: false,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockUseAuth = (
    status: "authenticated" | "anonymous",
    user: UserPrivateDto | null
  ) => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user,
      status,
      isLoading: false,
      isAuthenticated: status === "authenticated",
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });
  };

  const renderWithRoute = (initialSlug = "dynamic-prog-9876") => {
    return render(
      <MemoryRouter initialEntries={[`/r/${initialSlug}`]}>
        <Routes>
          <Route path="/r/:slug" element={<RoomPage />} />
          <Route path="/dashboard" element={<div>Mock Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
  };

  it("renders Room Shell directly when visitor is an active member", async () => {
    mockUseAuth("authenticated", {
      id: "usr_alice",
      provider: "github",
      displayName: "Alice Dev",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "alice@example.com",
    });

    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: mockRoom,
      currentMember: mockMember,
      members: [mockMember],
    });

    renderWithRoute();

    await waitFor(
      () => {
        expect(screen.getByText("Collaborative Code Editor")).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    expect(screen.getByText("Dynamic Programming Practice")).toBeInTheDocument();
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("Share Link")).toBeInTheDocument();
  });

  it("renders Guest Eviction Notice and join form when anonymous user visits open room", async () => {
    mockUseAuth("anonymous", null);
    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: mockPublicRoom,
      currentMember: undefined,
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByText("Guest Eviction Notice:")).toBeInTheDocument();
      expect(
        screen.getByText(/Active guest participation is limited to one room at a time/i)
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/Your Display Name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join as Guest" })).toBeInTheDocument();
  });

  it("submits guest join form with display name and enters room", async () => {
    mockUseAuth("anonymous", null);
    vi.spyOn(apiClient, "get").mockResolvedValueOnce({
      room: mockPublicRoom,
      currentMember: undefined,
    });

    const postSpy = vi.spyOn(apiClient, "post").mockResolvedValueOnce({
      room: mockRoom,
      currentMember: {
        id: "mbr_guest",
        displayName: "Guest Bob",
        role: "editor",
        isGuest: true,
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    vi.spyOn(apiClient, "get").mockResolvedValueOnce({
      room: mockRoom,
      currentMember: {
        id: "mbr_guest",
        displayName: "Guest Bob",
        role: "editor",
        isGuest: true,
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
      members: [],
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByLabelText(/Your Display Name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/Your Display Name/i);
    fireEvent.change(nameInput, { target: { value: "Guest Bob" } });

    const submitBtn = screen.getByRole("button", { name: "Join as Guest" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith("/rooms/dynamic-prog-9876/join", {
        displayName: "Guest Bob",
      });
    });
  });

  it("renders 404 Room Not Found when slug does not exist", async () => {
    mockUseAuth("anonymous", null);
    vi.spyOn(apiClient, "get").mockRejectedValue(
      new ApiClientError({
        message: "Room not found",
        code: "ROOM_NOT_FOUND",
        status: 404,
      })
    );

    renderWithRoute("non-existent-room-slug");

    await waitFor(() => {
      expect(screen.getByText("Room Not Found")).toBeInTheDocument();
      expect(
        screen.getByText(/The practice room link you followed does not exist/i)
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Back to Dashboard" })).toBeInTheDocument();
  });

  it("renders Room Closed screen when non-member views ended room", async () => {
    mockUseAuth("anonymous", null);
    const endedRoom: PublicRoomDto = {
      ...mockPublicRoom,
      status: "ended",
    };
    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: endedRoom,
      currentMember: undefined,
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByText("Room Closed")).toBeInTheDocument();
      expect(
        screen.getByText(
          /This practice session has ended and is no longer accepting new participants/i
        )
      ).toBeInTheDocument();
    });
  });

  it("handles 429 RATE_LIMIT_EXCEEDED with countdown", async () => {
    mockUseAuth("anonymous", null);
    vi.spyOn(apiClient, "get").mockRejectedValue(
      new ApiClientError({
        message: "Too many room lookups",
        code: "RATE_LIMIT_EXCEEDED",
        status: 429,
        retryAfterSec: 30,
      })
    );

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByText("Rate Limit Exceeded")).toBeInTheDocument();
      expect(
        screen.getByText(/Please wait 30 seconds before retrying/i)
      ).toBeInTheDocument();
    });
  });

  it("renders 'Room is Full' screen when non-member views full room (6 participants)", async () => {
    mockUseAuth("anonymous", null);
    const fullRoom: PublicRoomDto = {
      ...mockPublicRoom,
      memberCount: 6,
    };
    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: fullRoom,
      currentMember: undefined,
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByText("Room is Full")).toBeInTheDocument();
      expect(
        screen.getByText(
          /This practice room has reached its maximum capacity of 6 participants/i
        )
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Back to Dashboard" })).toBeInTheDocument();
  });

  it("renders 'Room is Full' screen when join fails with 409 ROOM_FULL", async () => {
    mockUseAuth("anonymous", null);
    vi.spyOn(apiClient, "get").mockResolvedValueOnce({
      room: mockPublicRoom,
      currentMember: undefined,
    });

    vi.spyOn(apiClient, "post").mockRejectedValueOnce(
      new ApiClientError({
        message: "This room is full",
        code: "ROOM_FULL",
        status: 409,
      })
    );

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByLabelText(/Your Display Name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/Your Display Name/i);
    fireEvent.change(nameInput, { target: { value: "Guest Bob" } });

    const submitBtn = screen.getByRole("button", { name: "Join as Guest" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("Room is Full")).toBeInTheDocument();
      expect(
        screen.getByText(
          /This practice room has reached its maximum capacity of 6 participants/i
        )
      ).toBeInTheDocument();
    });
  });

  it("NO-AUTO-JOIN: visiting /r/:slug loads metadata but never calls POST /join automatically", async () => {
    mockUseAuth("anonymous", null);
    const postSpy = vi.spyOn(apiClient, "post");
    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: mockPublicRoom,
      currentMember: undefined,
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByLabelText(/Your Display Name/i)).toBeInTheDocument();
    });

    // Ensure POST /join was never invoked on navigation
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("ENDED-ROOM-MEMBER: active room member can access Room Shell when status is ended", async () => {
    mockUseAuth("authenticated", {
      id: "usr_alice",
      provider: "github",
      displayName: "Alice Dev",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "alice@example.com",
    });

    const endedMemberRoom: RoomDto = {
      ...mockRoom,
      status: "ended",
    };

    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: endedMemberRoom,
      currentMember: mockMember,
      members: [mockMember],
    });

    renderWithRoute();

    await waitFor(
      () => {
        expect(screen.getByText("Collaborative Code Editor")).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(screen.queryByText("Room Closed")).not.toBeInTheDocument();
  });

  it("only marks the member with matching currentMember.id as (You), even if another member shares the exact same displayName", async () => {
    mockUseAuth("authenticated", {
      id: "usr_alice",
      provider: "github",
      displayName: "Alice Dev",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "alice@example.com",
    });

    const member1: RoomMemberDetailDto = {
      id: "mbr_owner",
      displayName: "Alice Dev",
      role: "owner",
      isGuest: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    };

    const member2: RoomMemberDetailDto = {
      id: "mbr_guest",
      displayName: "Alice Dev", // Duplicate name
      role: "editor",
      isGuest: true,
      joinedAt: "2026-01-01T00:01:00.000Z",
    };

    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: mockRoom,
      currentMember: member1,
      members: [member1, member2],
    });

    renderWithRoute();

    await waitFor(() => {
      expect(screen.getByTestId("participant-mbr_owner")).toBeInTheDocument();
      expect(screen.getByTestId("participant-mbr_guest")).toBeInTheDocument();
    });

    const ownerCard = screen.getByTestId("participant-mbr_owner");
    const guestCard = screen.getByTestId("participant-mbr_guest");

    expect(ownerCard).toHaveTextContent("(You)");
    expect(guestCard).not.toHaveTextContent("(You)");
  });

  describe("Participant presence and connection lifecycle", () => {
    const validRoom: RoomDto = {
      id: "507f1f77bcf86cd799439011",
      slug: "dynamic-prog-9876",
      title: "Dynamic Programming Practice",
      type: "practice",
      language: "python",
      status: "open",
      ownerId: "usr_alice",
      memberCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const aliceMember: RoomMemberDetailDto = {
      id: "mbr_alice",
      displayName: "Alice Dev",
      role: "owner",
      isGuest: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    };

    const bobMember: RoomMemberDetailDto = {
      id: "mbr_bob",
      displayName: "Bob Coder",
      role: "editor",
      isGuest: false,
      isOnline: true,
      joinedAt: "2026-01-01T00:01:00.000Z",
    };

    beforeEach(() => {
      mockUseAuth("authenticated", {
        id: "usr_alice",
        provider: "github",
        displayName: "Alice Dev",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "alice@example.com",
      });
    });

    it("displays Online badges, green indicators, and positive online count when connected", async () => {
      vi.spyOn(roomSyncModule, "useRoomSync").mockReturnValue({
        doc: null,
        provider: null,
        status: "connected",
        isSynced: true,
        error: null,
      });

      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: validRoom,
        currentMember: aliceMember,
        members: [aliceMember, bobMember],
        onlineMemberCount: 2,
      });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("participant-counts")).toHaveTextContent(
          "2 online · 2 members"
        );
      });

      const aliceStatus = screen.getByTestId("participant-status-mbr_alice");
      const bobStatus = screen.getByTestId("participant-status-mbr_bob");

      expect(aliceStatus).toHaveTextContent("Online");
      expect(aliceStatus).toHaveClass("text-success");
      expect(bobStatus).toHaveTextContent("Online");
      expect(bobStatus).toHaveClass("text-success");
    });

    it.each([
      ["offline", "offline"],
      ["reconnecting", "reconnecting"],
      ["disconnected", "disconnected"],
      ["error", "error"],
    ] as const)(
      "displays 0 online · Y members and Offline badges when connection is %s",
      async (_statusName, syncStatus) => {
        vi.spyOn(roomSyncModule, "useRoomSync").mockReturnValue({
          doc: null,
          provider: null,
          status: syncStatus,
          isSynced: false,
          error: syncStatus === "error" ? new Error("Test error") : null,
        });

        vi.spyOn(apiClient, "get").mockResolvedValue({
          room: validRoom,
          currentMember: aliceMember,
          members: [aliceMember, bobMember],
          onlineMemberCount: 2,
        });

        renderWithRoute();

        await waitFor(() => {
          expect(screen.getByTestId("participant-counts")).toHaveTextContent(
            "0 online · 2 members"
          );
        });

        const aliceStatus = screen.getByTestId("participant-status-mbr_alice");
        const bobStatus = screen.getByTestId("participant-status-mbr_bob");

        // Current participant shows Offline; remote participants show Unavailable
        expect(aliceStatus).toHaveTextContent("Offline");
        expect(aliceStatus).toHaveClass("text-text-subtle");
        expect(bobStatus).toHaveTextContent("Unavailable");
        expect(bobStatus).toHaveClass("text-text-subtle");

        // Indicators show neutral grey dot
        const aliceDot = screen.getByLabelText("Offline");
        const bobDot = screen.getByLabelText("Unavailable");
        expect(aliceDot).toHaveClass("bg-text-subtle/40");
        expect(bobDot).toHaveClass("bg-text-subtle/40");

        // Persistent memberCount is not altered
        expect(screen.getByTitle("2 of 6 maximum room members")).toHaveTextContent(
          "2/6 members"
        );
      }
    );

    it("reflects local connection state on fallback row when members list is empty", async () => {
      // 1. Connected
      const syncSpy = vi.spyOn(roomSyncModule, "useRoomSync").mockReturnValue({
        doc: null,
        provider: null,
        status: "connected",
        isSynced: true,
        error: null,
      });

      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: validRoom,
        currentMember: aliceMember,
        members: [], // empty members triggers fallback row
      });

      const { unmount } = renderWithRoute();

      await waitFor(() => {
        expect(screen.getByLabelText("Online")).toBeInTheDocument();
      });

      unmount();

      // 2. Disconnected
      syncSpy.mockReturnValue({
        doc: null,
        provider: null,
        status: "offline",
        isSynced: false,
        error: null,
      });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByLabelText("Offline")).toBeInTheDocument();
      });
    });

    it("triggers refreshRoom to re-fetch room metadata when transitioning to connected", async () => {
      let updateSyncStatus: ((s: "offline" | "connected") => void) | null = null;

      vi.spyOn(roomSyncModule, "useRoomSync").mockImplementation(() => {
        const [status, setStatus] = useState<"offline" | "connected">("offline");
        updateSyncStatus = setStatus;
        return {
          doc: null,
          provider: null,
          status,
          isSynced: status === "connected",
          error: null,
        };
      });

      const getSpy = vi
        .spyOn(apiClient, "get")
        .mockImplementation(async (url: string) => {
          if (url.includes("/messages")) {
            return { messages: [], nextCursor: null, hasMore: false };
          }
          return {
            room: validRoom,
            currentMember: aliceMember,
            members: [aliceMember],
            onlineMemberCount: 1,
          };
        });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("participant-counts")).toHaveTextContent(
          "0 online · 1 member"
        );
      });

      const roomMetadataCalls = () =>
        getSpy.mock.calls.filter(([url]) => url === `/rooms/${validRoom.slug}`);
      expect(roomMetadataCalls()).toHaveLength(1);

      // Transition hook state to "connected"
      act(() => {
        updateSyncStatus?.("connected");
      });

      await waitFor(() => {
        expect(roomMetadataCalls()).toHaveLength(2);
      });
    });
  });

  describe("Workspace Integrity & Shortcut Safety", () => {
    const authUser = {
      id: "usr_alice",
      provider: "github" as const,
      email: "alice@example.com",
      displayName: "Alice Dev",
      role: "user" as const,
      isAnonymous: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    it("derives live session duration from authoritative room.createdAt timestamp", async () => {
      mockUseAuth("authenticated", authUser);
      // Room created exactly 2 minutes and 15 seconds ago (135 seconds)
      const twoMinsAgo = new Date(Date.now() - 135_000).toISOString();
      const timedRoom = {
        ...mockRoom,
        createdAt: twoMinsAgo,
      };

      vi.spyOn(apiClient, "get").mockImplementation(async (url: string) => {
        if (url.includes("/messages")) {
          return { messages: [], nextCursor: null, hasMore: false };
        }
        return {
          room: timedRoom,
          currentMember: mockMember,
          members: [mockMember],
          onlineMemberCount: 1,
        };
      });

      renderWithRoute();

      await waitFor(() => {
        expect(
          screen.getByTitle("Session Duration (from room creation)")
        ).toHaveTextContent(/LIVE 02:15/i);
      });
    });

    it("safely ignores Ctrl+B and Ctrl+J when typing inside input or textarea", async () => {
      mockUseAuth("authenticated", authUser);
      vi.spyOn(apiClient, "get").mockImplementation(async (url: string) => {
        if (url.includes("/messages")) {
          return { messages: [], nextCursor: null, hasMore: false };
        }
        return {
          room: mockRoom,
          currentMember: mockMember,
          members: [mockMember],
          onlineMemberCount: 1,
        };
      });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Create an input element simulating Monaco or a text field
      const inputEl = document.createElement("input");
      document.body.appendChild(inputEl);
      inputEl.focus();

      // Dispatch Ctrl+B while input is focused
      const eventB = new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      inputEl.dispatchEvent(eventB);

      // Event should not be prevented (preventDefault was not called)
      expect(eventB.defaultPrevented).toBe(false);

      // Dispatch Ctrl+J while input is focused
      const eventJ = new KeyboardEvent("keydown", {
        key: "j",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      inputEl.dispatchEvent(eventJ);

      expect(eventJ.defaultPrevented).toBe(false);

      document.body.removeChild(inputEl);
    });

    it("toggles panels when Ctrl+B is pressed on canvas outside input", async () => {
      mockUseAuth("authenticated", authUser);
      vi.spyOn(apiClient, "get").mockImplementation(async (url: string) => {
        if (url.includes("/messages")) {
          return { messages: [], nextCursor: null, hasMore: false };
        }
        return {
          room: mockRoom,
          currentMember: mockMember,
          members: [mockMember],
          onlineMemberCount: 1,
        };
      });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Dispatch on window/body directly
      const eventB = new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(eventB);

      // Successfully handled and default prevented
      expect(eventB.defaultPrevented).toBe(true);
    });
  });

  describe("P0 Room Management (Leave, End, Ban)", () => {
    const mockEditorMember: RoomMemberDetailDto = {
      id: "mbr_2",
      displayName: "Bob Candidate",
      role: "editor",
      isGuest: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    };

    const authEditorUser: UserPrivateDto = {
      id: "usr_bob",
      provider: "github",
      displayName: "Bob Candidate",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "bob@example.com",
    };

    it("renders Leave button for non-owner member and allows voluntary departure", async () => {
      mockUseAuth("authenticated", authEditorUser);
      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: mockRoom,
        currentMember: mockEditorMember,
        members: [mockMember, mockEditorMember],
        onlineMemberCount: 2,
      });
      const leaveSpy = vi
        .spyOn(roomApi, "leaveRoom")
        .mockResolvedValue({ status: "left" });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Non-owner should see "Leave" button but NOT "End Session"
      expect(screen.getByTestId("leave-room-button")).toBeInTheDocument();
      expect(screen.queryByTestId("end-session-button")).toBeNull();

      // Click Leave Room
      await act(async () => {
        fireEvent.click(screen.getByTestId("leave-room-button"));
      });

      // Modal should appear
      expect(screen.getByTestId("leave-room-modal")).toBeInTheDocument();

      // Confirm Leave
      await act(async () => {
        fireEvent.click(screen.getByTestId("confirm-leave-button"));
      });

      expect(leaveSpy).toHaveBeenCalledWith("dynamic-prog-9876");
      await waitFor(() => {
        expect(screen.getByText("Mock Dashboard")).toBeInTheDocument();
      });
    });

    it("renders End Session button for owner and allows ending the room", async () => {
      mockUseAuth("authenticated", {
        id: "usr_alice",
        provider: "github",
        displayName: "Alice Dev",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "alice@example.com",
      });
      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: mockRoom,
        currentMember: mockMember,
        members: [mockMember, mockEditorMember],
        onlineMemberCount: 2,
      });
      const endSpy = vi
        .spyOn(roomApi, "endRoom")
        .mockResolvedValue({ room: { ...mockRoom, status: "ended" } });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Owner should see "End Session" button but NOT "Leave"
      expect(screen.getByTestId("end-session-button")).toBeInTheDocument();
      expect(screen.queryByTestId("leave-room-button")).toBeNull();

      // Click End Session
      await act(async () => {
        fireEvent.click(screen.getByTestId("end-session-button"));
      });

      // Modal should appear
      expect(screen.getByTestId("end-session-modal")).toBeInTheDocument();

      // Confirm End Session
      await act(async () => {
        fireEvent.click(screen.getByTestId("confirm-end-button"));
      });

      expect(endSpy).toHaveBeenCalledWith("dynamic-prog-9876");
      await waitFor(() => {
        expect(screen.getByTestId("room-ended-banner")).toBeInTheDocument();
      });
    });

    it("displays removed screen when user is banned (MEMBER_BANNED / 403)", async () => {
      mockUseAuth("authenticated", authEditorUser);
      vi.spyOn(apiClient, "get").mockRejectedValue(
        new ApiClientError({
          message: "You have been banned from this room.",
          status: 403,
          code: "MEMBER_BANNED",
        })
      );

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("removed-screen")).toBeInTheDocument();
      });
      expect(
        screen.getByText(
          /You have been removed from this room by the host and cannot rejoin/
        )
      ).toBeInTheDocument();
    });
  });

  describe("P0 Room Management (Leave, End, Ban)", () => {
    const mockEditorMember: RoomMemberDetailDto = {
      id: "mbr_2",
      displayName: "Bob Candidate",
      role: "editor",
      isGuest: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    };

    const authEditorUser: UserPrivateDto = {
      id: "usr_bob",
      provider: "github",
      displayName: "Bob Candidate",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "bob@example.com",
    };

    it("renders Leave button for non-owner member and allows voluntary departure", async () => {
      mockUseAuth("authenticated", authEditorUser);
      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: mockRoom,
        currentMember: mockEditorMember,
        members: [mockMember, mockEditorMember],
        onlineMemberCount: 2,
      });
      const leaveSpy = vi
        .spyOn(roomApi, "leaveRoom")
        .mockResolvedValue({ status: "left" });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Non-owner should see "Leave" button but NOT "End Session"
      expect(screen.getByTestId("leave-room-button")).toBeInTheDocument();
      expect(screen.queryByTestId("end-session-button")).toBeNull();

      // Click Leave Room
      await act(async () => {
        fireEvent.click(screen.getByTestId("leave-room-button"));
      });

      // Modal should appear
      expect(screen.getByTestId("leave-room-modal")).toBeInTheDocument();

      // Confirm Leave
      await act(async () => {
        fireEvent.click(screen.getByTestId("confirm-leave-button"));
      });

      expect(leaveSpy).toHaveBeenCalledWith("dynamic-prog-9876");
      await waitFor(() => {
        expect(screen.getByText("Mock Dashboard")).toBeInTheDocument();
      });
    });

    it("renders End Session button for owner and allows ending the room", async () => {
      mockUseAuth("authenticated", {
        id: "usr_alice",
        provider: "github",
        displayName: "Alice Dev",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "alice@example.com",
      });
      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: mockRoom,
        currentMember: mockMember,
        members: [mockMember, mockEditorMember],
        onlineMemberCount: 2,
      });
      const endSpy = vi
        .spyOn(roomApi, "endRoom")
        .mockResolvedValue({ room: { ...mockRoom, status: "ended" } });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("room-header")).toBeInTheDocument();
      });

      // Owner should see "End Session" button but NOT "Leave"
      expect(screen.getByTestId("end-session-button")).toBeInTheDocument();
      expect(screen.queryByTestId("leave-room-button")).toBeNull();

      // Click End Session
      await act(async () => {
        fireEvent.click(screen.getByTestId("end-session-button"));
      });

      // Modal should appear
      expect(screen.getByTestId("end-session-modal")).toBeInTheDocument();

      // Confirm End Session
      await act(async () => {
        fireEvent.click(screen.getByTestId("confirm-end-button"));
      });

      expect(endSpy).toHaveBeenCalledWith("dynamic-prog-9876");
      await waitFor(() => {
        expect(screen.getByTestId("room-ended-banner")).toBeInTheDocument();
      });
    });

    it("displays removed screen when user is banned (MEMBER_BANNED / 403)", async () => {
      mockUseAuth("authenticated", authEditorUser);
      vi.spyOn(apiClient, "get").mockRejectedValue(
        new ApiClientError({
          message: "You have been banned from this room.",
          status: 403,
          code: "MEMBER_BANNED",
        })
      );

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("removed-screen")).toBeInTheDocument();
      });
      expect(
        screen.getByText(
          /You have been removed from this room by the host and cannot rejoin/
        )
      ).toBeInTheDocument();
    });
  });
});
