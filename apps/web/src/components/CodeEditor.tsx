import { useEffect, useRef, useState, type FC, type HTMLAttributes } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import { setupMonacoWorkers } from "../lib/monacoWorkers.js";
import { Skeleton } from "./ui/Skeleton.js";

export const ALLOWED_LANGUAGES = ["python", "javascript", "cpp"] as const;
export type SupportedEditorLanguage = (typeof ALLOWED_LANGUAGES)[number];

export function isValidEditorLanguage(lang: unknown): lang is SupportedEditorLanguage {
  return (
    typeof lang === "string" &&
    (ALLOWED_LANGUAGES as readonly string[]).includes(lang.toLowerCase().trim())
  );
}

export interface CodeEditorProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  value?: string;
  defaultValue?: string;
  language?: SupportedEditorLanguage | string;
  readOnly?: boolean;
  onMount?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: typeof monaco
  ) => void;
  onDispose?: () => void;
  onChange?: (value: string) => void;
}

/**
 * Normalizes language string to Monaco's recognized language IDs.
 * Specifically maps "c++" / "cpp" to "cpp", "js" to "javascript", "py" to "python".
 * Falls back to "python" for unsupported or invalid language inputs.
 */
export function normalizeLanguage(lang?: string): SupportedEditorLanguage {
  if (!lang) return "python";
  const lower = lang.toLowerCase().trim();
  if (lower === "c++" || lower === "cpp") return "cpp";
  if (lower === "js" || lower === "javascript") return "javascript";
  if (lower === "py" || lower === "python") return "python";
  return "python";
}

export const CodeEditor: FC<CodeEditorProps> = ({
  value,
  defaultValue = "",
  language = "python",
  readOnly = false,
  onMount,
  onDispose,
  onChange,
  className = "",
  ...rest
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Keep latest callbacks in refs to avoid re-triggering effects
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;
  const onDisposeRef = useRef(onDispose);
  onDisposeRef.current = onDispose;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 1. Initialize Monaco Editor Instance
  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let changeListener: monaco.IDisposable | null = null;

    setupMonacoWorkers();

    if (!containerRef.current) return;

    try {
      const normalizedLang = normalizeLanguage(language);
      const initialText = value ?? defaultValue;

      const editor = monaco.editor.create(containerRef.current, {
        value: initialText,
        language: normalizedLang,
        theme: "vs-dark",
        readOnly,
        automaticLayout: false, // Managed reliably by our ResizeObserver
        fontSize: 14,
        fontFamily: "'JetBrains Mono', monospace",
        tabSize: 2,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        overviewRulerLanes: 0,
        renderLineHighlight: "all",
      });

      editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);

      if (cancelled) {
        editor.dispose();
        return;
      }

      editorRef.current = editor;
      setIsReady(true);

      // Listen to model changes for optional onChange callback
      changeListener = editor.onDidChangeModelContent(() => {
        if (onChangeRef.current) {
          onChangeRef.current(editor.getValue());
        }
      });

      // Handle container resize
      if (typeof ResizeObserver !== "undefined" && containerRef.current) {
        resizeObserver = new ResizeObserver(() => {
          if (!cancelled && editorRef.current) {
            editorRef.current.layout();
          }
        });
        resizeObserver.observe(containerRef.current);
      }

      // Initial layout flush
      editor.layout();

      if (onMountRef.current) {
        onMountRef.current(editor, monaco);
      }
    } catch (err) {
      console.error("[CodeEditor] Failed to initialize Monaco editor:", err);
    }

    // Teardown on unmount or before re-mount (StrictMode safe)
    return () => {
      cancelled = true;

      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }

      if (changeListener) {
        changeListener.dispose();
        changeListener = null;
      }

      if (editorRef.current) {
        if (onDisposeRef.current) {
          onDisposeRef.current();
        }
        editorRef.current.dispose();
        editorRef.current = null;
      }

      setIsReady(false);
    };
  }, []); // Run once on mount; updates handled via fine-grained effects below

  // 2. Synchronize language changes without re-creating editor or model
  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model || model.isDisposed()) return;

    const normalizedLang = normalizeLanguage(language);
    monaco.editor.setModelLanguage(model, normalizedLang);
  }, [language]);

  // 3. Synchronize readOnly state dynamically
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({ readOnly });
  }, [readOnly]);

  // 4. Synchronize controlled value changes (if provided and differs from editor content)
  useEffect(() => {
    if (value === undefined || !editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model || model.isDisposed()) return;

    if (model.getValue() !== value) {
      editorRef.current.setValue(value);
    }
  }, [value]);

  return (
    <div
      className={`relative w-full h-full min-h-[300px] bg-surface overflow-hidden ${className}`}
      {...rest}
    >
      <div
        ref={containerRef}
        data-testid="monaco-editor-container"
        className="w-full h-full"
        style={{ height: "100%", width: "100%" }}
      />
      {!isReady && (
        <div
          data-testid="monaco-editor-loading"
          className="absolute inset-0 bg-surface flex flex-col p-4 space-y-2 pointer-events-none"
        >
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </div>
  );
};
