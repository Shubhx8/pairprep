import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProfileModal } from "../ProfileModal.js";
import { apiClient, ApiClientError } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import * as toastModule from "../ui/Toast.js";
import type { UserPrivateDto } from "@pairprep/shared";

describe("ProfileModal", () => {
  const mockUser: UserPrivateDto = {
    id: "usr_alice",
    provider: "github",
    displayName: "Alice Dev",
    email: "alice@example.com",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const refreshMeMock = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    refreshMeMock.mockReset();
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: mockUser,
      status: "authenticated",
      isLoading: false,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: refreshMeMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders display name input prefilled with current name and provider details", () => {
    render(<ProfileModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Edit Profile")).toBeInTheDocument();
    const input = screen.getByLabelText(/Display Name/i) as HTMLInputElement;
    expect(input.value).toBe("Alice Dev");
    expect(screen.getByText(/github/i)).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("rejects empty display name on client without calling API", async () => {
    const patchSpy = vi.spyOn(apiClient, "patch");
    render(<ProfileModal open={true} onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText(/Display Name/i);
    fireEvent.change(input, { target: { value: "   " } });

    const submitBtn = screen.getByRole("button", { name: /Save Changes/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Display name must be between 1 and 40 characters.")
      ).toBeInTheDocument();
    });

    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("submits valid display name to PATCH /me and refreshes profile", async () => {
    const onOpenChange = vi.fn();
    const patchSpy = vi.spyOn(apiClient, "patch").mockResolvedValue({
      ...mockUser,
      displayName: "Alice Wonder",
    });
    const toastSpy = vi.spyOn(toastModule.toast, "success");

    render(<ProfileModal open={true} onOpenChange={onOpenChange} />);

    const input = screen.getByLabelText(/Display Name/i);
    fireEvent.change(input, { target: { value: "Alice Wonder" } });

    const submitBtn = screen.getByRole("button", { name: /Save Changes/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith("/me", {
        displayName: "Alice Wonder",
      });
    });

    expect(refreshMeMock).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith("Profile updated successfully");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("displays server error message when API fails", async () => {
    vi.spyOn(apiClient, "patch").mockRejectedValue(
      new ApiClientError({
        message: "Display name contains invalid characters",
        code: "VALIDATION_ERROR",
        status: 400,
      })
    );

    render(<ProfileModal open={true} onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText(/Display Name/i);
    fireEvent.change(input, { target: { value: "Invalid\x00Name" } });

    const submitBtn = screen.getByRole("button", { name: /Save Changes/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Display name contains invalid characters")
      ).toBeInTheDocument();
    });
  });
});
