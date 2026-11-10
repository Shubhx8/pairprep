import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeEditor, normalizeLanguage } from "../CodeEditor.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

describe("CodeEditor", () => {
  it("normalizes language strings accurately", () => {
    expect(normalizeLanguage("python")).toBe("python");
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("cpp")).toBe("cpp");
    expect(normalizeLanguage("c++")).toBe("cpp");
    expect(normalizeLanguage("javascript")).toBe("javascript");
    expect(normalizeLanguage("js")).toBe("javascript");
    expect(normalizeLanguage("")).toBe("python");
    expect(normalizeLanguage(undefined)).toBe("python");
  });

  it("mounts Monaco editor inside container and triggers onMount callback", () => {
    let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    const onMount = vi.fn((editor: monaco.editor.IStandaloneCodeEditor) => {
      editorInstance = editor;
    });

    render(
      <CodeEditor
        defaultValue="print('Hello PairPrep')"
        language="python"
        onMount={onMount}
      />
    );

    expect(screen.getByTestId("monaco-editor-container")).toBeInTheDocument();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(editorInstance).not.toBeNull();
    expect(
      (editorInstance as unknown as monaco.editor.IStandaloneCodeEditor).getValue()
    ).toBe("print('Hello PairPrep')");
  });

  it("supports controlled value updates", () => {
    let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    const { rerender } = render(
      <CodeEditor
        value="const x = 1;"
        language="javascript"
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    expect(editorInstance).not.toBeNull();
    expect(
      (editorInstance as unknown as monaco.editor.IStandaloneCodeEditor).getValue()
    ).toBe("const x = 1;");

    rerender(
      <CodeEditor
        value="const x = 2;"
        language="javascript"
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    expect(
      (editorInstance as unknown as monaco.editor.IStandaloneCodeEditor).getValue()
    ).toBe("const x = 2;");
  });

  it("dynamically updates language without recreating editor instance", () => {
    let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    const { rerender } = render(
      <CodeEditor
        defaultValue="# Python"
        language="python"
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    const initialEditor = editorInstance;
    const model = (
      editorInstance as unknown as monaco.editor.IStandaloneCodeEditor
    ).getModel();
    expect(model?.getLanguageId()).toBe("python");

    rerender(
      <CodeEditor
        defaultValue="# Python"
        language="cpp"
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    // Editor instance remains stable (not recreated)
    expect(editorInstance).toBe(initialEditor);
    expect(model?.getLanguageId()).toBe("cpp");
  });

  it("dynamically updates readOnly mode without recreating editor", () => {
    let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    const { rerender } = render(
      <CodeEditor
        defaultValue="mutable code"
        readOnly={false}
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    const editor = editorInstance as unknown as monaco.editor.IStandaloneCodeEditor;
    expect(editor.getOption(monaco.editor.EditorOption.readOnly)).toBe(false);

    rerender(
      <CodeEditor
        defaultValue="mutable code"
        readOnly={true}
        onMount={(e) => {
          editorInstance = e;
        }}
      />
    );

    expect(editor.getOption(monaco.editor.EditorOption.readOnly)).toBe(true);
  });

  it("disposes editor instance and invokes onDispose on unmount", () => {
    let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    const onDispose = vi.fn();

    const { unmount } = render(
      <CodeEditor
        defaultValue="code to unmount"
        onMount={(e) => {
          editorInstance = e;
        }}
        onDispose={onDispose}
      />
    );

    const editor = editorInstance as unknown as monaco.editor.IStandaloneCodeEditor;
    const disposeSpy = vi.spyOn(editor, "dispose");

    unmount();

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
