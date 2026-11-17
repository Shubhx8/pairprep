import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResizeHandle } from "../ResizeHandle.js";

describe("ResizeHandle component", () => {
  it("renders with role='separator' and proper accessibility attributes", () => {
    const onResizeMock = vi.fn();
    render(
      <ResizeHandle
        side="left"
        currentWidth={280}
        minWidth={220}
        maxWidth={400}
        onResize={onResizeMock}
        ariaLabel="Resize left sidebar"
      />
    );

    const separator = screen.getByRole("separator", { name: /resize left sidebar/i });
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "280");
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuemax", "400");
  });

  it("handles keyboard arrows to adjust width", () => {
    const onResizeMock = vi.fn();
    render(
      <ResizeHandle
        side="left"
        currentWidth={280}
        minWidth={220}
        maxWidth={400}
        onResize={onResizeMock}
      />
    );

    const separator = screen.getByRole("separator");

    // ArrowRight increases left panel width by 10
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResizeMock).toHaveBeenCalledWith(290);

    // ArrowLeft decreases left panel width by 10
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onResizeMock).toHaveBeenCalledWith(270);

    // Home sets to minWidth
    fireEvent.keyDown(separator, { key: "Home" });
    expect(onResizeMock).toHaveBeenCalledWith(220);

    // End sets to maxWidth
    fireEvent.keyDown(separator, { key: "End" });
    expect(onResizeMock).toHaveBeenCalledWith(400);
  });

  it("resets to default width on double click and Enter key", () => {
    const onResizeMock = vi.fn();
    const onResetMock = vi.fn();
    render(
      <ResizeHandle
        side="right"
        currentWidth={350}
        minWidth={260}
        maxWidth={480}
        onResize={onResizeMock}
        onReset={onResetMock}
      />
    );

    const separator = screen.getByRole("separator");
    fireEvent.doubleClick(separator);
    expect(onResetMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onResetMock).toHaveBeenCalledTimes(2);
  });
});
