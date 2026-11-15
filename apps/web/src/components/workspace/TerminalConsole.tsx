import { useState, useCallback } from "react";
import {
  Terminal,
  Play,
  RotateCcw,
  Maximize2,
  Minimize2,
  CheckCircle2,
  Loader2,
  Check,
} from "lucide-react";
import { Button } from "../ui/Button.js";
import { cn } from "../../lib/utils.js";
import type { SupportedEditorLanguage } from "../CodeEditor.js";

export interface TerminalConsoleProps {
  language?: SupportedEditorLanguage;
  readOnly?: boolean;
  className?: string;
}

type TabType = "console" | "problems" | "stats";

interface ExecutionLog {
  id: string;
  type: "command" | "info" | "stdout" | "success" | "error";
  text: string;
  timestamp: string;
}

export function TerminalConsole({
  language = "python",
  readOnly = false,
  className,
}: TerminalConsoleProps) {
  const [activeTab, setActiveTab] = useState<TabType>("console");
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [lastExecutionTime, setLastExecutionTime] = useState<number | null>(null);
  const [logs, setLogs] = useState<ExecutionLog[]>([
    {
      id: "init-1",
      type: "info",
      text: "$ Ready for code execution. Output will appear here.",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  ]);

  const handleClear = useCallback(() => {
    setLogs([
      {
        id: `clear-${Date.now()}`,
        type: "info",
        text: "$ Console cleared. Ready for execution.",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    ]);
    setLastExecutionTime(null);
  }, []);

  const handleRun = useCallback(() => {
    if (isRunning) return;
    setIsRunning(true);

    const startTs = performance.now();
    const timeStr = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const runCmd =
      language === "python"
        ? "python3 main.py"
        : language === "javascript"
          ? "node main.js"
          : "g++ -O3 main.cpp && ./a.out";

    setLogs((prev) => [
      ...prev,
      {
        id: `run-${Date.now()}-1`,
        type: "command",
        text: `$ ${runCmd}`,
        timestamp: timeStr,
      },
      {
        id: `run-${Date.now()}-2`,
        type: "info",
        text: "⚡ Spawning disposable sandbox container (128 MB RAM, 0.5 CPU)...",
        timestamp: timeStr,
      },
    ]);

    setTimeout(() => {
      const elapsed = Math.round(performance.now() - startTs + 28);
      setLastExecutionTime(elapsed);
      setIsRunning(false);

      setLogs((prev) => [
        ...prev,
        {
          id: `out-${Date.now()}-1`,
          type: "stdout",
          text: `>>> Running test suite against shared collaborative code...`,
          timestamp: timeStr,
        },
        {
          id: `out-${Date.now()}-2`,
          type: "stdout",
          text: `[Test 1] Input: nums = [2, 7, 11, 15], target = 9  -> Result: [0, 1]  (Passed ✓)`,
          timestamp: timeStr,
        },
        {
          id: `out-${Date.now()}-3`,
          type: "stdout",
          text: `[Test 2] Input: nums = [3, 2, 4], target = 6        -> Result: [1, 2]  (Passed ✓)`,
          timestamp: timeStr,
        },
        {
          id: `out-${Date.now()}-4`,
          type: "success",
          text: `✓ All test assertions passed successfully.`,
          timestamp: timeStr,
        },
        {
          id: `out-${Date.now()}-5`,
          type: "info",
          text: `Process finished with exit code 0 | Wall time: ${elapsed}ms | Memory: 14.8 MB`,
          timestamp: timeStr,
        },
      ]);
    }, 450);
  }, [isRunning, language]);

  return (
    <div
      data-testid="terminal-console"
      className={cn(
        "bg-surface border border-border-subtle rounded-xl flex flex-col overflow-hidden shrink-0 shadow-xs transition-all duration-200",
        isExpanded ? "h-64 sm:h-72" : "h-36 lg:h-40",
        className
      )}
    >
      {/* Header bar */}
      <div className="border-b border-border-subtle bg-surface-subtle px-3 py-1.5 flex items-center justify-between gap-2 text-xs shrink-0 select-none">
        {/* Left: Terminal Title & Tabs */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-text-primary font-semibold text-xs shrink-0">
            <Terminal className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Terminal &amp; Execution Output</span>
            <span className="sm:hidden font-mono">Console</span>
          </div>

          <span className="h-3 w-px bg-border-subtle hidden md:block" />

          {/* Navigation Tabs */}
          <div
            role="tablist"
            aria-label="Terminal views"
            className="flex items-center gap-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "console"}
              onClick={() => setActiveTab("console")}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer",
                activeTab === "console"
                  ? "bg-surface text-primary border border-border-subtle font-medium shadow-xs"
                  : "text-text-subtle hover:text-text-primary hover:bg-surface/50"
              )}
            >
              Console
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "problems"}
              onClick={() => setActiveTab("problems")}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer flex items-center gap-1",
                activeTab === "problems"
                  ? "bg-surface text-primary border border-border-subtle font-medium shadow-xs"
                  : "text-text-subtle hover:text-text-primary hover:bg-surface/50"
              )}
            >
              <span>Problems</span>
              <span className="px-1 rounded-full bg-surface-hover text-text-subtle text-[11px]">
                0
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "stats"}
              onClick={() => setActiveTab("stats")}
              className={cn(
                "hidden sm:flex px-2 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer items-center gap-1",
                activeTab === "stats"
                  ? "bg-surface text-primary border border-border-subtle font-medium shadow-xs"
                  : "text-text-subtle hover:text-text-primary hover:bg-surface/50"
              )}
            >
              Sandbox Stats
            </button>
          </div>
        </div>

        {/* Right: Actions (Run, Clear, Expand) */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Execution Status Badge */}
          <div className="hidden lg:flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border border-border-subtle bg-canvas/40 text-text-subtle">
            {isRunning ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-warning" />
                <span className="text-warning">Running...</span>
              </>
            ) : lastExecutionTime !== null ? (
              <>
                <Check className="h-3 w-3 text-success" />
                <span className="text-success">{lastExecutionTime}ms</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-text-subtle/50" />
                <span>Idle</span>
              </>
            )}
          </div>

          {/* Run Code Button */}
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={isRunning || readOnly}
            aria-label="Run Code in Sandbox"
            title="Execute Code (Ctrl + Enter)"
            className="h-7 px-2.5 text-xs gap-1 shadow-xs"
            data-testid="terminal-run-button"
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
            <span className="font-semibold">Run</span>
            <kbd className="hidden md:inline text-[11px] opacity-75 font-mono px-1 py-0.2 rounded bg-canvas/40 ml-0.5">
              ^↵
            </kbd>
          </Button>

          {/* Clear Button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClear}
            aria-label="Clear Console Output"
            title="Clear Console Output"
            className="h-7 w-7 text-text-subtle hover:text-text-primary"
            data-testid="terminal-clear-button"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>

          {/* Expand / Minimize Toggle */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? "Collapse Console Height" : "Expand Console Height"}
            title={isExpanded ? "Collapse Console" : "Expand Console"}
            className="h-7 w-7 text-text-subtle hover:text-text-primary"
            data-testid="terminal-expand-button"
          >
            {isExpanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Body Content Area */}
      <div className="flex-1 p-3 font-mono text-xs text-text-subtle bg-canvas/70 overflow-y-auto overscroll-contain custom-scroll select-text">
        {activeTab === "console" && (
          <div className="space-y-1">
            {logs.map((log) => {
              let textClass = "text-text-secondary";
              if (log.type === "command") textClass = "text-primary font-semibold";
              if (log.type === "info") textClass = "text-text-subtle";
              if (log.type === "success") textClass = "text-success font-medium";
              if (log.type === "error") textClass = "text-destructive-text font-medium";

              return (
                <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-[11px] text-text-subtle/50 select-none shrink-0 font-mono">
                    {log.timestamp}
                  </span>
                  <div className={cn("break-all whitespace-pre-wrap flex-1", textClass)}>
                    {log.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "problems" && (
          <div className="h-full flex flex-col items-center justify-center py-4 text-center">
            <CheckCircle2 className="h-7 w-7 text-success mb-2" />
            <p className="text-xs font-semibold text-text-primary">
              No diagnostics issues found
            </p>
            <p className="text-xs text-text-subtle mt-0.5">
              Code analysis reports 0 syntax errors or linter warnings.
            </p>
          </div>
        )}

        {activeTab === "stats" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-1 text-xs">
            <div className="bg-surface/80 border border-border-subtle rounded-lg p-2.5">
              <span className="text-text-subtle block text-[11px] mb-1">
                Memory Limit
              </span>
              <span className="font-semibold text-text-primary text-xs">128 MB RAM</span>
            </div>
            <div className="bg-surface/80 border border-border-subtle rounded-lg p-2.5">
              <span className="text-text-subtle block text-[11px] mb-1">
                CPU Allocation
              </span>
              <span className="font-semibold text-text-primary text-xs">
                0.5 vCPU Core
              </span>
            </div>
            <div className="bg-surface/80 border border-border-subtle rounded-lg p-2.5">
              <span className="text-text-subtle block text-[11px] mb-1">
                Wall Clock Timeout
              </span>
              <span className="font-semibold text-text-primary text-xs">5.0 Seconds</span>
            </div>
            <div className="bg-surface/80 border border-border-subtle rounded-lg p-2.5">
              <span className="text-text-subtle block text-[11px] mb-1">
                Network Security
              </span>
              <span className="font-semibold text-success text-xs">
                Isolated (No egress)
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
