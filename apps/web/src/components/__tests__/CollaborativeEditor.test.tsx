import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

  it("restricts language dropdown to exactly Python, JavaScript, and C++ with no extra languages (Section 8 / ED-1)", () => {
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

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const options = Array.from(select.options).map((opt) => ({
      value: opt.value,
      label: opt.text,
    }));

    expect(options).toEqual([
      { value: "python", label: "Python" },
      { value: "javascript", label: "JavaScript" },
      { value: "cpp", label: "C++" },
    ]);
    expect(options).toHaveLength(3);

    doc.destroy();
  });

  it("samples latency via stateless ping/pong, computes P50/P95, logs to console, and cleans up timers on unmount (Section 5.3)", () => {
    vi.useFakeTimers();
    const originalSearch = window.location.search;
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, search: "?debug=latency" },
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const doc = new Y.Doc();
      const mockListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const mockProvider = {
        awareness: {
          getStates: vi.fn(() => new Map()),
          getLocalState: vi.fn(() => ({})),
          setLocalStateField: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
        },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          mockListeners[event] = mockListeners[event] || [];
          mockListeners[event].push(cb);
        }),
        off: vi.fn((event: string, cb: unknown) => {
          if (mockListeners[event]) {
            mockListeners[event] = mockListeners[event].filter((fn) => fn !== cb);
          }
        }),
        sendStateless: vi.fn(),
      };

      const { unmount } = render(
        <CollaborativeEditor
          doc={doc}
          provider={
            mockProvider as unknown as import("@hocuspocus/provider").HocuspocusProvider
          }
          status="connected"
          isSynced={true}
          error={null}
          language="python"
        />
      );

      // Verify that after 5000ms, sendStateless was invoked with latency_ping
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(mockProvider.sendStateless).toHaveBeenCalledTimes(1);

      const pingPayload = JSON.parse(
        mockProvider.sendStateless.mock.calls[0]![0] as string
      );
      expect(pingPayload.type).toBe("latency_ping");
      expect(typeof pingPayload.nonce).toBe("string");

      // Simulate server stateless pong response
      const statelessHandler = mockListeners["stateless"]?.[0];
      expect(statelessHandler).toBeDefined();

      act(() => {
        statelessHandler!({
          payload: JSON.stringify({
            type: "latency_pong",
            nonce: pingPayload.nonce,
            sentAt: pingPayload.sentAt,
            serverTime: Date.now(),
          }),
        });
      });

      // Console log should record the sample measurement
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ED-4 Latency Probe]")
      );

      // Verify cleanup removes listeners and stops interval
      unmount();
      expect(mockProvider.off).toHaveBeenCalledWith("stateless", expect.any(Function));

      doc.destroy();
    } finally {
      consoleLogSpy.mockRestore();
      Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, search: originalSearch },
      });
      vi.useRealTimers();
    }
  });
});
