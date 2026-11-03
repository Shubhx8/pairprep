import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DashboardPage from "../DashboardPage.js";
import { apiClient, ApiClientError } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import type { RoomDto, UserPrivateDto } from "@pairprep/shared";

describe("DashboardPage", () => {
  const mockUser: UserPrivateDto = {
    id: "usr_alice",
    provider: "github",
    displayName: "Alice Dev",
    email: "alice@example.com",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockRooms: RoomDto[] = [
    {
      id: "rm_1",
      slug: "algorithm-practice-xyz1",
      title: "Binary Tree Mastery",
      type: "practice",
      language: "python",
      status: "open",
      ownerId: "usr_alice",
      memberCount: 2,
      createdAt: "2026-01-02T10:00:00.000Z",
    },
    {
      id: "rm_2",
      slug: "two-pointers-drills-abc2",
      title: "Two Pointers Drill",
      type: "practice",
      language: "javascript",
      status: "ended",
      ownerId: "usr_bob",
      memberCount: 4,
      createdAt: "2026-01-01T15:30:00.000Z",
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockUseAuth = (
    status: "authenticated" | "anonymous" | "loading",
    user: UserPrivateDto | null
  ) => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user,
      status,
      isLoading: status === "loading",
      isAuthenticated: status === "authenticated",
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });
  };

  it("renders anonymous sign-in prompt when user is not authenticated", () => {
    mockUseAuth("anonymous", null);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(screen.getByText("Sign in to your Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Sign In with OAuth")).toBeInTheDocument();
  });

  it("renders rooms list with badges and metadata when authenticated", async () => {
    mockUseAuth("authenticated", mockUser);
    vi.spyOn(apiClient, "get").mockResolvedValue({
      rooms: mockRooms,
      nextCursor: undefined,
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Binary Tree Mastery")).toBeInTheDocument();
      expect(screen.getByText("Two Pointers Drill")).toBeInTheDocument();
    });

    expect(screen.getByText("2/6 participants")).toBeInTheDocument();
    expect(screen.getByText("4/6 participants")).toBeInTheDocument();
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("javascript")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Participant")).toBeInTheDocument();
  });

  it("renders EmptyState when user has no rooms", async () => {
    mockUseAuth("authenticated", mockUser);
    vi.spyOn(apiClient, "get").mockResolvedValue({
      rooms: [],
      nextCursor: undefined,
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("No rooms created yet")).toBeInTheDocument();
    });

    expect(screen.getByText("Create a Practice Room")).toBeInTheDocument();
  });

  it("renders ErrorState with retry button when fetch fails, and retries on click", async () => {
    mockUseAuth("authenticated", mockUser);
    vi.spyOn(apiClient, "get")
      .mockRejectedValueOnce(
        new ApiClientError({
          message: "Database temporarily down",
          code: "DB_ERROR",
          status: 500,
          requestId: "req-err-456",
        })
      )
      .mockResolvedValueOnce({
        rooms: mockRooms,
        nextCursor: undefined,
      });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Unable to load your rooms")).toBeInTheDocument();
      expect(screen.getByText("Database temporarily down")).toBeInTheDocument();
      expect(screen.getByText(/req-err-456/)).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText("Binary Tree Mastery")).toBeInTheDocument();
    });
  });

  it("loads more rooms when 'Load More Rooms' cursor pagination is clicked", async () => {
    mockUseAuth("authenticated", mockUser);
    const moreRoom: RoomDto = {
      id: "rm_3",
      slug: "dynamic-programming-page2",
      title: "DP Marathon",
      type: "practice",
      language: "cpp",
      status: "open",
      ownerId: "usr_alice",
      memberCount: 1,
      createdAt: "2025-12-31T20:00:00.000Z",
    };

    vi.spyOn(apiClient, "get")
      .mockResolvedValueOnce({
        rooms: mockRooms,
        nextCursor: "cursor_page_2",
      })
      .mockResolvedValueOnce({
        rooms: [moreRoom],
        nextCursor: undefined,
      });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Binary Tree Mastery")).toBeInTheDocument();
    });

    const loadMoreBtn = screen.getByRole("button", { name: /load more rooms/i });
    expect(loadMoreBtn).toBeInTheDocument();

    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText("DP Marathon")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: /load more rooms/i })
    ).not.toBeInTheDocument();
  });
});
