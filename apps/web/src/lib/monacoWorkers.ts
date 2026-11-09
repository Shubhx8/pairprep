import type { Environment } from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: Environment | undefined;
  }
}

let configured = false;

/**
 * Idempotently registers Monaco web workers for Vite.
 * Called lazily prior to mounting Monaco Editor.
 */
export function setupMonacoWorkers(): void {
  if (configured || typeof window === "undefined") {
    return;
  }

  window.MonacoEnvironment = {
    ...window.MonacoEnvironment,
    getWorker(_workerId: string, label: string): Worker {
      if (label === "typescript" || label === "javascript") {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  configured = true;
}
