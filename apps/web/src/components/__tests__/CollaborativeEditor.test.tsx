import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as Y from "yjs";
import { CollaborativeEditor } from "../CollaborativeEditor.js";

describe("CollaborativeEditor", () => {
  it("renders editor header, language selector, and title", () => {
    const doc = new Y.Doc();
    const onLanguageChange = vi.fn();

    render(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="connected"
        isSynced={true}
        error={null}
        language="python"
        onLanguageChange={onLanguageChange}
        readOnly={false}
      />
    );

    expect(screen.getByTestId("collaborative-editor")).toBeInTheDocument();
    expect(screen.getByText("main.py")).toBeInTheDocument();
    expect(screen.getByText("Collaborative Code Editor")).toBeInTheDocument();

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("python");

    fireEvent.change(select, { target: { value: "javascript" } });
    expect(onLanguageChange).toHaveBeenCalledWith("javascript");

    doc.destroy();
  });

  it("renders read-only badge and disables language select when readOnly=true", () => {
    const doc = new Y.Doc();

    render(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="connected"
        isSynced={true}
        error={null}
        language="cpp"
        readOnly={true}
      />
    );

    expect(screen.getByText("main.cpp")).toBeInTheDocument();
    expect(screen.getByText("Read-Only")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();

    doc.destroy();
  });

  it("displays synchronization state in header", () => {
    const doc = new Y.Doc();

    const { rerender } = render(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="connecting"
        isSynced={false}
        error={null}
        language="python"
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Connecting...");

    rerender(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="error"
        isSynced={false}
        error={new Error("Authorization rejected")}
        language="python"
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Sync Error");

    doc.destroy();
  });

  it("synchronizes language from roomConfig Y.Map with validation and fallback", () => {
    const doc = new Y.Doc();
    const configMap = doc.getMap("roomConfig");
    const onLanguageChange = vi.fn();

    render(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="connected"
        isSynced={true}
        error={null}
        language="cpp"
        onLanguageChange={onLanguageChange}
      />
    );

    // Valid language change in Y.Map
    configMap.set("language", "javascript");
    expect(onLanguageChange).toHaveBeenCalledWith("javascript");

    // Invalid/malformed language change in Y.Map falls back to "python"
    onLanguageChange.mockClear();
    configMap.set("language", "invalid_lang_xyz");
    expect(onLanguageChange).toHaveBeenCalledWith("python");

    doc.destroy();
  });

  it("does not render latency debug probe without ?debug=latency in URL", () => {
    const doc = new Y.Doc();
    render(
      <CollaborativeEditor
        doc={doc}
        provider={null}
        status="connected"
        isSynced={true}
        error={null}
        language="python"
      />
    );

    expect(screen.queryByTestId("latency-debug-probe")).toBeNull();
    doc.destroy();
  });

  it("renders latency debug probe when ?debug=latency is present in window.location", () => {
    const originalSearch = window.location.search;
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, search: "?debug=latency" },
    });

    try {
      const doc = new Y.Doc();
      render(
        <CollaborativeEditor
          doc={doc}
          provider={null}
          status="connected"
          isSynced={true}
          error={null}
          language="python"
        />
      );

      expect(screen.getByTestId("latency-debug-probe")).toBeInTheDocument();
      expect(screen.getByTestId("latency-debug-probe")).toHaveTextContent(
        "Localhost dual-client RTT"
      );
      doc.destroy();
    } finally {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, search: originalSearch },
      });
    }
  });
});
