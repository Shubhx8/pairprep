import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalConsole } from "../TerminalConsole.js";

describe("TerminalConsole component", () => {
  it("renders with title, initial output, and action buttons", () => {
    render(<TerminalConsole language="python" />);

    expect(screen.getByTestId("terminal-console")).toBeInTheDocument();
    expect(screen.getByText("Terminal & Execution Output")).toBeInTheDocument();
    expect(
      screen.getByText(/\$ Terminal & execution console initialized \(Preview\)/i)
    ).toBeInTheDocument();

    expect(screen.getByTestId("terminal-run-button")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-clear-button")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-expand-button")).toBeInTheDocument();
  });

  it("handles tab switching between Console, Problems, and Environment", () => {
    render(<TerminalConsole language="python" />);

    // Click Problems tab
    const problemsTab = screen.getByRole("tab", { name: /problems/i });
    fireEvent.click(problemsTab);
    expect(screen.getByText("No diagnostics issues found")).toBeInTheDocument();

    // Click Environment tab
    const statsTab = screen.getByRole("tab", { name: /environment/i });
    fireEvent.click(statsTab);
    expect(screen.getByText("Preview Mode")).toBeInTheDocument();
    expect(screen.getByText("Active (Yjs)")).toBeInTheDocument();

    // Click back to Console tab
    const consoleTab = screen.getByRole("tab", { name: /^console$/i });
    fireEvent.click(consoleTab);
    expect(
      screen.getByText(/\$ Terminal & execution console initialized \(Preview\)/i)
    ).toBeInTheDocument();
  });

  it("handles Run click honestly without fake container or canned Two Sum assertions", () => {
    render(<TerminalConsole language="python" />);

    const runBtn = screen.getByTestId("terminal-run-button");
    fireEvent.click(runBtn);

    expect(
      screen.getByText(/Code execution runner is not configured in this environment/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/128 MB RAM/i)).toBeNull();
    expect(screen.queryByText(/Two Sum/i)).toBeNull();
  });

  it("clears console logs when clear button is clicked", () => {
    render(<TerminalConsole language="python" />);

    const clearBtn = screen.getByTestId("terminal-clear-button");
    fireEvent.click(clearBtn);

    expect(screen.getByText(/\$ Console cleared/i)).toBeInTheDocument();
  });

  it("toggles expanded height when expand button is clicked", () => {
    render(<TerminalConsole language="python" />);

    const expandBtn = screen.getByTestId("terminal-expand-button");
    const container = screen.getByTestId("terminal-console");

    expect(container).toHaveClass("h-36");

    fireEvent.click(expandBtn);
    expect(container).toHaveClass("h-64");

    fireEvent.click(expandBtn);
    expect(container).toHaveClass("h-36");
  });
});
