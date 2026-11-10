import { useEffect, useState, useRef } from "react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import type * as monaco from "monaco-editor";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { PARTICIPANT_PALETTE } from "@pairprep/shared";

export interface AwarenessUser {
  name: string;
  color: string;
}

export interface UseMonacoBindingOptions {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  doc: Y.Doc | null;
  provider?: HocuspocusProvider | null;
  fieldName?: string;
  user?: AwarenessUser | null;
}

export interface UseMonacoBindingResult {
  binding: MonacoBinding | null;
  isBound: boolean;
}

/**
 * Escapes characters for safe inclusion inside CSS `content: "..."` strings.
 * Neutralizes quotes, braces, newlines, and early </style> termination.
 */
export function escapeCssContent(str: string): string {
  return str
    .replace(/<\/style/gi, "<\\/style")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[{}]/g, "")
    .replace(/[\r\n\t]/g, " ");
}

/**
 * Generates dynamic CSS stylesheet content for remote cursor heads and selections
 * tracked in Hocuspocus / Yjs awareness.
 */
function buildAwarenessCss(
  awareness: NonNullable<HocuspocusProvider["awareness"]>,
  localClientId: number
): string {
  const rules: string[] = [];

  // Base classes for remote decorations
  rules.push(`
.yRemoteSelection {
  position: absolute;
  pointer-events: none;
}
.yRemoteSelectionHead {
  position: absolute;
  box-sizing: border-box;
  height: 100%;
  pointer-events: none;
}
`);

  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;

    const user = state["user"] as { name?: unknown; color?: unknown } | undefined;
    const name =
      typeof user?.name === "string" && user.name.trim().length > 0
        ? user.name.trim()
        : `User ${clientId}`;
    const color =
      typeof user?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(user.color)
        ? user.color
        : PARTICIPANT_PALETTE[Math.abs(clientId) % PARTICIPANT_PALETTE.length];

    const escapedName = escapeCssContent(name);

    rules.push(`
.yRemoteSelection-${clientId} {
  background-color: ${color}33 !important;
}
.yRemoteSelectionHead-${clientId} {
  border-left: 2px solid ${color} !important;
}
.yRemoteSelectionHead-${clientId}::after {
  content: "${escapedName}";
  position: absolute;
  top: -1.35em;
  left: -2px;
  background-color: ${color};
  color: #ffffff;
  font-size: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 20;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
`);
  });

  return rules.join("\n");
}

/**
 * Reusable hook connecting a Monaco Editor instance to a Yjs document (Y.Text)
 * and Hocuspocus provider awareness.
 *
 * Implements:
 * - Shared text binding: doc.getText(fieldName || "code")
 * - Conflict-free bidirectional synchronization via y-monaco
 * - Awareness remote cursor & selection rendering with distinguishable colors & labels
 * - Idempotent resource disposal and React StrictMode resilience
 */
export function useMonacoBinding(
  options: UseMonacoBindingOptions
): UseMonacoBindingResult {
  const { editor, doc, provider, fieldName = "code", user } = options;

  const [binding, setBinding] = useState<MonacoBinding | null>(null);
  const [isBound, setIsBound] = useState(false);
  const styleElementRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    if (!editor || !doc) {
      setBinding(null);
      setIsBound(false);
      return;
    }

    const model = editor.getModel();
    if (!model || model.isDisposed()) {
      setBinding(null);
      setIsBound(false);
      return;
    }

    let isCurrent = true;

    // Legacy field migration: if binding to canonical "code" but doc only has "monaco",
    // migrate legacy text into "code" before creating the binding.
    if (fieldName === "code" && !doc.share.has("code") && doc.share.has("monaco")) {
      const legacyText = doc.getText("monaco").toString();
      if (legacyText.length > 0) {
        doc.transact(() => {
          doc.getText("code").insert(0, legacyText);
        });
      }
    }

    const ytext = doc.getText(fieldName);
    const awareness = provider?.awareness ?? null;

    // 1. Publish local user presentation metadata to awareness
    if (awareness && user) {
      awareness.setLocalStateField("user", {
        name: user.name,
        color: user.color,
      });
    }

    // 2. Set up dynamic awareness CSS stylesheet for remote cursors
    let styleEl = styleElementRef.current;
    if (typeof document !== "undefined") {
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.setAttribute("data-pairprep-awareness", "true");
        document.head.appendChild(styleEl);
        styleElementRef.current = styleEl;
      }

      if (awareness) {
        styleEl.textContent = buildAwarenessCss(awareness, doc.clientID);
      }
    }

    const handleAwarenessChange = () => {
      if (!isCurrent || !awareness || !styleElementRef.current) return;
      styleElementRef.current.textContent = buildAwarenessCss(awareness, doc.clientID);
    };

    if (awareness) {
      awareness.on("change", handleAwarenessChange);
    }

    // 3. Construct MonacoBinding connecting Y.Text, Monaco ITextModel, editor, and awareness
    const activeBinding = new MonacoBinding(ytext, model, new Set([editor]), awareness);

    let isBindingDestroyed = false;
    const safeDestroyBinding = () => {
      if (isBindingDestroyed) return;
      isBindingDestroyed = true;
      try {
        activeBinding.destroy();
      } catch (err) {
        console.error("[useMonacoBinding] Error destroying MonacoBinding:", err);
      }
    };

    const modelDisposeListener = model.onWillDispose(() => {
      safeDestroyBinding();
    });

    if (isCurrent) {
      setBinding(activeBinding);
      setIsBound(true);
    }

    // 4. Cleanup on unmount, editor change, or doc change
    return () => {
      isCurrent = false;

      if (awareness) {
        awareness.off("change", handleAwarenessChange);
      }

      if (styleElementRef.current) {
        styleElementRef.current.remove();
        styleElementRef.current = null;
      }

      modelDisposeListener.dispose();
      safeDestroyBinding();

      setBinding(null);
      setIsBound(false);
    };
  }, [editor, doc, provider, fieldName, user?.name, user?.color]);

  return { binding, isBound };
}
