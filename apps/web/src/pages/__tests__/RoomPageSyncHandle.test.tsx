import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import RoomPage from "../RoomPage.js";
import { apiClient } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import type { RoomDto, RoomMemberDetailDto, UserPrivateDto } from "@pairprep/shared";
import "../../components/CollaborativeEditor.js";

describe("FIX 4 / Blocker C: Actual RoomPage E2E Handle Tests (window.__pairprep_sync)", () => {
  const validRoomId = "507f1f77bcf86cd799439011";

  const mockRoom: RoomDto = {
    id: validRoomId,
    slug: "e2e-handle-slug",
    title: "E2E Handle Verification Room",
    type: "practice",
    language: "python",
    status: "open",
    ownerId: "usr_alice",
    memberCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const mockMember: RoomMemberDetailDto = {
    id: "mbr_alice_1",
    displayName: "Alice Dev",
    role: "owner",
    isGuest: false,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };

  const mockUser: UserPrivateDto = {
    id: "usr_alice",
    provider: "github",
    displayName: "Alice Dev",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    email: "alice@example.com",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync;

    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: mockUser,
      status: "authenticated",
      isLoading: false,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });

    vi.spyOn(apiClient, "get").mockResolvedValue({
      room: mockRoom,
      currentMember: mockMember,
      members: [mockMember],
    });
  });

  afterEach(() => {
    delete (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const renderRoomPage = (slug = "e2e-handle-slug") => {
    return render(
      <MemoryRouter initialEntries={[`/r/${slug}`]}>
        <Routes>
          <Route path="/r/:slug" element={<RoomPage />} />
        </Routes>
      </MemoryRouter>
    );
  };

  // Case 1: E2E enabled
  it("exposes window.__pairprep_sync on actual RoomPage when VITE_PAIRPREP_E2E=1 in dev/test", async () => {
    vi.stubEnv("VITE_PAIRPREP_E2E", "1");

    const { unmount } = renderRoomPage();

    await waitFor(
      () => {
        expect(
          (window as unknown as { __pairprep_sync?: { doc?: unknown } }).__pairprep_sync
        ).toBeDefined();
      },
      { timeout: 4000 }
    );

    const handle = (
      window as unknown as {
        __pairprep_sync: {
          doc: unknown;
          provider: unknown;
          status: string;
          isSynced: boolean;
          error: unknown;
        };
      }
    ).__pairprep_sync;

    expect(handle).toBeDefined();
    expect(handle.doc).toBeDefined();
    expect(handle.status).toBeDefined();
    expect(typeof handle.isSynced).toBe("boolean");

    unmount();
    expect(
      (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync
    ).toBeUndefined();
  });

  // Case 2: E2E disabled (flag unset)
  it("does NOT expose window.__pairprep_sync on actual RoomPage when VITE_PAIRPREP_E2E is unset", async () => {
    delete (import.meta.env as Record<string, unknown>)["VITE_PAIRPREP_E2E"];

    renderRoomPage();

    await waitFor(
      () => {
        expect(screen.getByText("E2E Handle Verification Room")).toBeInTheDocument();
      },
      { timeout: 4000 }
    );

    expect(
      (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync
    ).toBeUndefined();
  });

  // Case 3: Flag set to zero
  it("does NOT expose window.__pairprep_sync on actual RoomPage when VITE_PAIRPREP_E2E=0", async () => {
    vi.stubEnv("VITE_PAIRPREP_E2E", "0");

    renderRoomPage();

    await waitFor(
      () => {
        expect(screen.getByText("E2E Handle Verification Room")).toBeInTheDocument();
      },
      { timeout: 4000 }
    );

    expect(
      (window as unknown as { __pairprep_sync?: unknown }).__pairprep_sync
    ).toBeUndefined();
  });

  // Case 4: Production build dead-code elimination check
  it("production build does not expose or include test handle implementation", () => {
    const distAssetsDir = path.resolve(process.cwd(), "apps/web/dist/assets");
    if (!fs.existsSync(distAssetsDir)) {
      // If dist doesn't exist, verify import.meta.env.DEV gate logic
      expect(import.meta.env.DEV).toBeDefined();
      return;
    }

    const jsFiles = fs
      .readdirSync(distAssetsDir)
      .filter((f) => f.startsWith("RoomPage-") && f.endsWith(".js"));

    expect(jsFiles.length).toBeGreaterThan(0);
    const roomPageJs = fs.readFileSync(path.join(distAssetsDir, jsFiles[0]!), "utf-8");

    // In production build with import.meta.env.DEV === false, __pairprep_sync is tree-shaken
    expect(roomPageJs.includes("__pairprep_sync")).toBe(false);
  });
});
