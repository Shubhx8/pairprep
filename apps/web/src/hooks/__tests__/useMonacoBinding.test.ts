import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { useMonacoBinding } from "../useMonacoBinding.js";
import type { HocuspocusProvider } from "@hocuspocus/provider";

describe("useMonacoBinding", () => {
  let doc: Y.Doc;
  let container: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  beforeEach(() => {
    doc = new Y.Doc();
    container = document.createElement("div");
    document.body.appendChild(container);
    editor = monaco.editor.create(container, {
      value: "",
      language: "javascript",
    });
  });

  afterEach(() => {
    editor.dispose();
    container.remove();
    doc.destroy();
    const styleEl = document.querySelector('style[data-pairprep-awareness="true"]');
    if (styleEl) styleEl.remove();
  });

  it("returns isBound=false when doc or editor is missing", () => {
    const { result, rerender } = renderHook((props) => useMonacoBinding(props), {
      initialProps: {
        editor: null as monaco.editor.IStandaloneCodeEditor | null,
        doc: null as Y.Doc | null,
      },
    });

    expect(result.current.isBound).toBe(false);
    expect(result.current.binding).toBeNull();

    rerender({ editor, doc: null });
    expect(result.current.isBound).toBe(false);

    rerender({ editor: null, doc });
    expect(result.current.isBound).toBe(false);
  });

  it("binds Monaco model to Y.Text and synchronizes bidirectionally", () => {
    const ytext = doc.getText("code");
    ytext.insert(0, "function solve() {\n  return 42;\n}");

    const { result } = renderHook(() =>
      useMonacoBinding({
        editor,
        doc,
        fieldName: "code",
      })
    );

    expect(result.current.isBound).toBe(true);
    expect(result.current.binding).not.toBeNull();

    const model = editor.getModel()!;
    // 1. Initial sync from Y.Text into Monaco model
    expect(model.getValue()).toBe("function solve() {\n  return 42;\n}");

    // 2. Local Monaco edit propagates to Y.Text
    act(() => {
      model.applyEdits([
        {
          range: new monaco.Range(2, 10, 2, 12), // Replace "42" with "100"
          text: "100",
        },
      ]);
    });
    expect(ytext.toString()).toBe("function solve() {\n  return 100;\n}");

    // 3. Remote Y.Text edit propagates to Monaco model
    act(() => {
      doc.transact(() => {
        ytext.insert(ytext.length, "\n// Remote comment: 👍 🚀");
      });
    });
    expect(model.getValue()).toBe(
      "function solve() {\n  return 100;\n}\n// Remote comment: 👍 🚀"
    );

    // 4. Unicode and multiline deletion
    act(() => {
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, "let greeting = '你好世界';");
      });
    });
    expect(model.getValue()).toBe("let greeting = '你好世界';");
  });

  it("publishes local user presentation metadata to awareness", () => {
    const fakeAwareness = {
      states: new Map<number, Record<string, unknown>>(),
      localState: {} as Record<string, unknown>,
      setLocalStateField(field: string, value: unknown) {
        this.localState[field] = value;
      },
      getLocalState() {
        return this.localState;
      },
      getStates() {
        return this.states;
      },
      on: () => {},
      off: () => {},
    };

    const mockProvider = {
      awareness: fakeAwareness,
    } as unknown as HocuspocusProvider;

    const { result } = renderHook(() =>
      useMonacoBinding({
        editor,
        doc,
        provider: mockProvider,
        user: { name: "Alice Dev", color: "#10B981" },
      })
    );

    expect(result.current.isBound).toBe(true);
    expect(fakeAwareness.localState["user"]).toEqual({
      name: "Alice Dev",
      color: "#10B981",
    });
  });

  it("generates dynamic CSS stylesheet for remote cursors and cleans up on unmount", () => {
    const listeners: Array<() => void> = [];
    const states = new Map<number, Record<string, unknown>>();

    const fakeAwareness = {
      states,
      localState: {},
      setLocalStateField() {},
      getStates() {
        return states;
      },
      on(event: string, fn: () => void) {
        if (event === "change") listeners.push(fn);
      },
      off(_event: string, fn: () => void) {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      },
    };

    // Add a remote participant in awareness
    states.set(999, {
      user: { name: "Bob Observer", color: "#3B82F6" },
      selection: {
        anchor: Y.createRelativePositionFromTypeIndex(doc.getText("code"), 0),
        head: Y.createRelativePositionFromTypeIndex(doc.getText("code"), 5),
      },
    });

    const mockProvider = {
      awareness: fakeAwareness,
    } as unknown as HocuspocusProvider;

    const { unmount } = renderHook(() =>
      useMonacoBinding({
        editor,
        doc,
        provider: mockProvider,
        user: { name: "Alice", color: "#10B981" },
      })
    );

    const styleEl = document.querySelector('style[data-pairprep-awareness="true"]');
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain(".yRemoteSelection-999");
    expect(styleEl?.textContent).toContain("#3B82F6");
    expect(styleEl?.textContent).toContain("Bob Observer");

    // Unmount hook: style element and binding should be destroyed cleanly
    unmount();
    expect(document.querySelector('style[data-pairprep-awareness="true"]')).toBeNull();
  });

  it("safely sanitizes hostile participant names in dynamic CSS stylesheet", () => {
    const states = new Map<number, Record<string, unknown>>();
    const fakeAwareness = {
      states,
      localState: {},
      setLocalStateField() {},
      getStates() {
        return states;
      },
      on() {},
      off() {},
    };

    // Hostile name containing quotes, braces, and </style>
    const hostileName = 'Attacker" { color: red; } </style><script>alert(1)</script>';
    states.set(666, {
      user: { name: hostileName, color: "#EF4444" },
      selection: {
        anchor: Y.createRelativePositionFromTypeIndex(doc.getText("code"), 0),
        head: Y.createRelativePositionFromTypeIndex(doc.getText("code"), 1),
      },
    });

    const mockProvider = {
      awareness: fakeAwareness,
    } as unknown as HocuspocusProvider;

    const { unmount } = renderHook(() =>
      useMonacoBinding({
        editor,
        doc,
        provider: mockProvider,
        user: { name: "Victim", color: "#10B981" },
      })
    );

    const styleEl = document.querySelector('style[data-pairprep-awareness="true"]');
    expect(styleEl).not.toBeNull();
    const cssText = styleEl?.textContent || "";
    // Unescaped </style> must NOT exist in the CSS
    expect(cssText).not.toContain("</style>");
    // Quotes must be escaped
    expect(cssText).toContain('\\"');
    // Braces must be stripped
    expect(cssText).not.toContain("{ color: red; }");

    unmount();
  });

  it("migrates legacy 'monaco' text into canonical 'code' before binding when 'code' is absent", () => {
    const doc = new Y.Doc();
    doc.getText("monaco").insert(0, "legacy code before mount");
    expect(doc.share.has("code")).toBe(false);

    const model = monaco.editor.createModel("", "javascript");
    const editor = {
      getModel: () => model,
      onDidChangeModelContent: vi.fn(),
      deltaDecorations: vi.fn().mockReturnValue([]),
    } as unknown as monaco.editor.IStandaloneCodeEditor;

    const { unmount } = renderHook(() =>
      useMonacoBinding({
        editor,
        doc,
        fieldName: "code",
      })
    );

    // doc.getText("code") must contain the migrated text and model must reflect it
    expect(doc.share.has("code")).toBe(true);
    expect(doc.getText("code").toString()).toBe("legacy code before mount");
    expect(model.getValue()).toBe("legacy code before mount");

    unmount();
  });
});
