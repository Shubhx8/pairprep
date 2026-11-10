import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

export const MONACO_THEME_NAME = "pairprep-dark";

let themeRegistered = false;

export function ensureThemeRegistered(): void {
  if (themeRegistered) return;
  try {
    monaco.editor.defineTheme(MONACO_THEME_NAME, {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "64748b", fontStyle: "italic" },
        { token: "keyword", foreground: "10b981", fontStyle: "bold" },
        { token: "string", foreground: "34d399" },
        { token: "number", foreground: "f59e0b" },
        { token: "type", foreground: "38bdf8" },
      ],
      colors: {
        "editor.background": "#0f172a", // matches --bg-surface
        "editor.foreground": "#f8fafc", // matches --text-primary
        "editor.lineHighlightBackground": "#1e293b55",
        "editorCursor.foreground": "#10b981",
        "editorWhitespace.foreground": "#334155",
        "editorIndentGuide.background": "#1e293b",
        "editorIndentGuide.activeBackground": "#334155",
        "editorLineNumber.foreground": "#475569",
        "editorLineNumber.activeForeground": "#94a3b8",
      },
    });
    themeRegistered = true;
  } catch {
    // Theme definition fallback if running in environments without editor.defineTheme
  }
}
