import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RoomPage from "../RoomPage.js";
import { apiClient, ApiClientError } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import type {
  RoomDto,
  PublicRoomDto,
  RoomMemberDetailDto,
  UserPrivateDto,
} from "@pairprep/shared";

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

    await waitFor(() => {
      expect(screen.getByText("Collaborative Code Editor")).toBeInTheDocument();
    });

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
});
