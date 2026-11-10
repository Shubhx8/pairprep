import { useState, useEffect, useCallback, type FC } from "react";
import type * as monaco from "monaco-editor";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CodeEditor,
  normalizeLanguage,
  isValidEditorLanguage,
  type SupportedEditorLanguage,
} from "./CodeEditor.js";
import { SyncStatusIndicator } from "./SyncStatusIndicator.js";
import { useMonacoBinding, type AwarenessUser } from "../hooks/useMonacoBinding.js";
import type { RoomSyncStatus } from "../hooks/useRoomSync.js";
import { FileCode, Lock, Code2, Activity } from "lucide-react";

export interface CollaborativeEditorProps {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: RoomSyncStatus;
  isSynced: boolean;
  error: Error | null;
  language: SupportedEditorLanguage;
  onLanguageChange?: (newLanguage: SupportedEditorLanguage) => void;
  readOnly?: boolean;
  user?: AwarenessUser | null;
  className?: string;
}

const EXTENSIONS: Record<SupportedEditorLanguage, string> = {
  python: "py",
  cpp: "cpp",
  javascript: "js",
};

/**
 * High-level collaborative editor component for PairPrep rooms.
 * Integrates:
 * - Monaco Editor with JetBrains Mono and PairPrep dark theme
 * - y-monaco bidirectional Y.Doc binding with awareness remote cursors
 * - Language selection (Python, C++, JavaScript)
 * - Real-time synchronization status badge
 * - Role-enforced read-only mode banner
 */
export const CollaborativeEditor: FC<CollaborativeEditorProps> = ({
  doc,
  provider,
  status,
  isSynced,
  error,
  language,
  onLanguageChange,
  readOnly = false,
  user,
  className = "",
}) => {
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleMount = useCallback(
    (mountedEditor: monaco.editor.IStandaloneCodeEditor) => {
      setEditor(mountedEditor);
    },
    []
  );

  const handleDispose = useCallback(() => {
    setEditor(null);
  }, []);

  // Bind Monaco to shared Y.Doc (doc.getText("code")) and provider awareness
  const { isBound } = useMonacoBinding({
    editor,
    doc,
    provider,
    fieldName: "code",
    user,
  });

  // Room-shared language preference synchronized via Yjs Y.Map ("roomConfig" -> "language")
  useEffect(() => {
    if (!doc) return;
    const configMap = doc.getMap("roomConfig");

    const syncLanguage = () => {
      const sharedLang = configMap.get("language");
      if (typeof sharedLang === "string") {
        const normalized = normalizeLanguage(sharedLang);
        if (isValidEditorLanguage(normalized) && normalized !== language) {
          onLanguageChange?.(normalized);
        }
      }
    };

    syncLanguage();
    configMap.observe(syncLanguage);
    return () => {
      configMap.unobserve(syncLanguage);
    };
  }, [doc, language, onLanguageChange]);

  const handleLanguageSelect = (newLang: SupportedEditorLanguage) => {
    if (!isValidEditorLanguage(newLang) || readOnly) return;
    onLanguageChange?.(newLang);
    if (doc) {
      const configMap = doc.getMap("roomConfig");
      configMap.set("language", newLang);
    }
  };

  // Latency debug probe (?debug=latency)
  // Clock-independent request/echo protocol via awareness:
  // Initiator sets ping with local timestamp stored only on initiator.
  // Responder echoes probeId. Initiator measures RTT = now() - sentAt.
  const isLatencyDebug =
    typeof window !== "undefined" && window.location.search.includes("debug=latency");

  const [latencyStats, setLatencyStats] = useState<{
    p50: number;
    p95: number;
    max: number;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!isLatencyDebug || !provider?.awareness || !doc) return;

    const awareness = provider.awareness;
    const pendingProbes = new Map<string, number>();
    const samples: number[] = [];
    const myClientId = doc.clientID;

    const interval = setInterval(() => {
      // Prune probes older than 5000ms
      const now = performance.now();
      for (const [id, sentAt] of pendingProbes.entries()) {
        if (now - sentAt > 5000) {
          pendingProbes.delete(id);
        }
      }

      const probeId = `${myClientId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      pendingProbes.set(probeId, performance.now());
      awareness.setLocalStateField("latencyPing", {
        probeId,
        initiatorId: myClientId,
      });
    }, 1000);

    const onAwarenessChange = () => {
      const states = awareness.getStates();

      states.forEach((st, cid) => {
        // 1. Echo back any ping from a remote client
        if (cid !== myClientId && st["latencyPing"]) {
          const ping = st["latencyPing"] as { probeId: string; initiatorId: number };
          if (ping.initiatorId !== myClientId) {
            const currentEcho = awareness.getLocalState()?.["latencyEcho"] as
              { probeId: string; echoedFor: number } | undefined;
            if (!currentEcho || currentEcho.probeId !== ping.probeId) {
              awareness.setLocalStateField("latencyEcho", {
                probeId: ping.probeId,
                echoedFor: ping.initiatorId,
              });
            }
          }
        }

        // 2. Measure RTT when an echo for our own ping is received
        if (cid !== myClientId && st["latencyEcho"]) {
          const echo = st["latencyEcho"] as { probeId: string; echoedFor: number };
          if (echo.echoedFor === myClientId && pendingProbes.has(echo.probeId)) {
            const sentAt = pendingProbes.get(echo.probeId)!;
            pendingProbes.delete(echo.probeId);
            const rtt = Math.max(0, performance.now() - sentAt);
            if (rtt < 10000) {
              samples.push(rtt);
              if (samples.length > 50) samples.shift();
              const sorted = [...samples].sort((a, b) => a - b);
              const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
              const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? p50;
              const max = sorted[sorted.length - 1] ?? 0;
              setLatencyStats({
                p50: Math.round(p50),
                p95: Math.round(p95),
                max: Math.round(max),
                count: samples.length,
              });
            }
          }
        }
      });
    };

    awareness.on("change", onAwarenessChange);
    return () => {
      clearInterval(interval);
      awareness.off("change", onAwarenessChange);
      try {
        awareness.setLocalStateField("latencyPing", null);
        awareness.setLocalStateField("latencyEcho", null);
      } catch {
        // ignore on unmount
      }
    };
  }, [isLatencyDebug, provider, doc]);

  const ext = EXTENSIONS[language] || "txt";

  return (
    <div
      data-testid="collaborative-editor"
      className={`flex-1 bg-surface border border-border-subtle rounded-xl flex flex-col overflow-hidden shadow-inner ${className}`}
    >
      {/* Editor Header Bar */}
      <div className="border-b border-border-subtle bg-surface-subtle px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-mono text-text-secondary">
            <FileCode className="h-4 w-4 text-primary" />
            <span className="font-semibold text-text-primary">main.{ext}</span>
          </div>

          <span className="text-text-subtle text-xs">|</span>

          {/* Language Selector */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="language-select" className="sr-only">
              Programming Language
            </label>
            <select
              id="language-select"
              value={language}
              disabled={readOnly}
              onChange={(e) =>
                handleLanguageSelect(e.target.value as SupportedEditorLanguage)
              }
              className="text-xs font-mono bg-surface border border-border-subtle rounded px-2 py-1 text-text-primary focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
            >
              <option value="python">Python</option>
              <option value="javascript">JavaScript</option>
              <option value="cpp">C++</option>
            </select>
          </div>

          {/* Accessible Title identifying the Collaborative Code Editor */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-text-subtle">
            <Code2 className="h-3.5 w-3.5 text-text-subtle" />
            <span className="font-medium">Collaborative Code Editor</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Latency Debug Probe Badge (Active only when ?debug=latency is present) */}
          {isLatencyDebug && (
            <div
              data-testid="latency-debug-probe"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-surface-subtle text-primary border border-primary/30"
              title="Localhost dual-client RTT"
            >
              <Activity className="h-3 w-3 animate-pulse" />
              <span>
                RTT: P50: {latencyStats ? `${latencyStats.p50}ms` : "--"} | P95:{" "}
                {latencyStats ? `${latencyStats.p95}ms` : "--"} | Max:{" "}
                {latencyStats ? `${latencyStats.max}ms` : "--"} (n=
                {latencyStats?.count ?? 0}, Localhost dual-client RTT)
              </span>
            </div>
          )}

          {readOnly && (
            <span
              role="badge"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-warning/10 text-warning border border-warning/30"
              title="You are currently viewing in read-only mode."
            >
              <Lock className="h-3 w-3" />
              <span>Read-Only</span>
            </span>
          )}

          <SyncStatusIndicator
            status={status}
            isSynced={isSynced && isBound}
            error={error}
          />
        </div>
      </div>

      {/* Editor Body */}
      <div className="flex-1 relative min-h-[350px]">
        <CodeEditor
          language={language}
          readOnly={readOnly}
          onMount={handleMount}
          onDispose={handleDispose}
          className="absolute inset-0 w-full h-full"
        />
      </div>
    </div>
  );
};

export default CollaborativeEditor;
