import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CreateRoomDialog } from "../CreateRoomDialog.js";
import { apiClient, ApiClientError } from "../../lib/apiClient.js";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("CreateRoomDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockNavigate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders form elements and submits room creation request", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();

    vi.spyOn(apiClient, "post").mockResolvedValue({
      room: {
        id: "rm_new",
        slug: "cool-falcon-123456",
        title: "Graphs Practice",
        type: "practice",
        language: "javascript",
        status: "open",
        ownerId: "usr_1",
        memberCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    render(
      <MemoryRouter>
        <CreateRoomDialog open={true} onOpenChange={onOpenChange} onCreated={onCreated} />
      </MemoryRouter>
    );

    expect(screen.getByText("Create a Practice Room")).toBeInTheDocument();

    const titleInput = screen.getByLabelText(/Room Title/i);
    fireEvent.change(titleInput, { target: { value: "Graphs Practice" } });

    const jsBtn = screen.getByRole("button", { name: /JavaScript/i });
    fireEvent.click(jsBtn);

    const submitBtn = screen.getByRole("button", { name: "Create Room" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledTimes(1);
    });

    const [endpoint, body, options] = (apiClient.post as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      { title: string; language: string; type: string },
      { idempotencyKey?: string },
    ];
    expect(endpoint).toBe("/rooms");
    expect(body.title).toBe("Graphs Practice");
    expect(body.language).toBe("javascript");
    expect(options.idempotencyKey).toBeDefined();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreated).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/r/cool-falcon-123456");
  });

  it("displays rate limit error message when 429 is encountered", async () => {
    vi.spyOn(apiClient, "post").mockRejectedValue(
      new ApiClientError({
        message: "Too many room creation attempts",
        code: "RATE_LIMIT_EXCEEDED",
        status: 429,
        retryAfterSec: 45,
      })
    );

    render(
      <MemoryRouter>
        <CreateRoomDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    );

    const submitBtn = screen.getByRole("button", { name: "Create Room" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText(
          /Rate limit reached. Please wait 45s before creating another room./i
        )
      ).toBeInTheDocument();
    });
  });
});
