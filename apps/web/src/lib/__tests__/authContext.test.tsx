import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "../authContext.js";
import { apiClient, ApiClientError } from "../apiClient.js";
import type { UserPrivateDto } from "@pairprep/shared";

describe("authContext & useAuth", () => {
  const mockUser: UserPrivateDto = {
    id: "usr_123",
    provider: "google",
    displayName: "Jane Doe",
    email: "jane@example.com",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider>{children}</AuthProvider>
  );

  it("throws descriptive error when useAuth is rendered without AuthProvider", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = (e: Event) => e.preventDefault();
    window.addEventListener("error", onError);
    try {
      expect(() => renderHook(() => useAuth())).toThrowError(
        "useAuth must be used within an AuthProvider"
      );
    } finally {
      window.removeEventListener("error", onError);
      consoleSpy.mockRestore();
    }
  });

  it("fetches /me on mount and sets authenticated status when user is signed in", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue(mockUser);

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status).toBe("authenticated");
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toEqual(mockUser);
    expect(apiClient.get).toHaveBeenCalledWith("/me");
  });

  it("sets anonymous status when /me returns 401 UNAUTHORIZED", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(
      new ApiClientError({
        message: "Unauthorized",
        code: "UNAUTHORIZED",
        status: 401,
      })
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status).toBe("anonymous");
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("navigates to OAuth endpoint with returnTo parameter on login()", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(
      new ApiClientError({ message: "401", code: "UNAUTHORIZED", status: 401 })
    );

    const assignMock = vi.fn();
    vi.stubGlobal("location", { assign: assignMock } as unknown as Location);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.login("github", "/dashboard");
    });

    expect(assignMock).toHaveBeenCalledWith("/api/v1/auth/github?returnTo=%2Fdashboard");

    vi.unstubAllGlobals();
  });

  it("calls POST /auth/logout and resets state to anonymous on logout()", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue(mockUser);
    const postSpy = vi.spyOn(apiClient, "post").mockResolvedValue({ success: true });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(postSpy).toHaveBeenCalledWith("/auth/logout");
    expect(result.current.status).toBe("anonymous");
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("STORAGE-FREE: authentication relies purely on HttpOnly cookies and never writes tokens to localStorage or sessionStorage", async () => {
    const localSetItemSpy = vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(apiClient, "get").mockResolvedValue(mockUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });
    expect(localStorage.getItem("token")).toBeNull();
    expect(sessionStorage.getItem("token")).toBeNull();
    expect(localSetItemSpy).not.toHaveBeenCalled();
  });
});
