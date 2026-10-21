import { useEffect, useState } from "react";
import {
  PingResponse,
  PingResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
} from "@pairprep/shared";

export default function App() {
  const [data, setData] = useState<PingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ping");
      if (!res.ok) {
        throw new Error(`Server responded with HTTP ${res.status}`);
      }
      const rawJson: unknown = await res.json();

      // Strict runtime verification via shared Zod schema
      const parseResult = PingResponseSchema.safeParse(rawJson);
      if (!parseResult.success) {
        throw new Error(`Schema validation failed: ${parseResult.error.message}`);
      }

      setData(parseResult.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error occurred";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div className="flex items-center justify-between pb-6 border-b border-slate-800">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              <span className="text-emerald-400">⚡</span> PairPrep
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Collaborative Interview & Pair-Programming Platform
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
              data?.status === "ok"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : error
                  ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
            }`}
          >
            {loading ? "Checking..." : data?.status === "ok" ? "Online" : "Offline"}
          </span>
        </div>

        <div className="mt-6 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Monorepo Wiring & Shared Contracts
          </h2>

          {loading && (
            <div className="flex items-center justify-center p-8 text-slate-400 animate-pulse text-sm">
              Connecting to Express API...
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-950/40 border border-rose-800 rounded-xl text-rose-300 text-sm">
              <p className="font-semibold">Connection failed:</p>
              <p className="mt-1 font-mono text-xs">{error}</p>
            </div>
          )}

          {data && (
            <div className="space-y-3 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 text-sm">
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-400">Backend Status:</span>
                <span className="font-mono text-emerald-400 font-semibold">
                  {data.status}
                </span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-400">Message:</span>
                <span className="text-slate-200 text-right">{data.message}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-400">Environment:</span>
                <span className="font-mono text-indigo-400">{data.environment}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-400">Server Timestamp:</span>
                <span className="font-mono text-xs text-slate-400">{data.timestamp}</span>
              </div>
            </div>
          )}

          <div className="pt-2">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Shared Types Verified from{" "}
              <code className="text-slate-300">@pairprep/shared</code>:
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {UserRoleSchema.options.map((role: string) => (
                <span
                  key={role}
                  className="px-2 py-0.5 text-xs rounded bg-slate-800 text-slate-300 border border-slate-700/60"
                >
                  role:{role}
                </span>
              ))}
              {SupportedLanguageSchema.options.map((lang: string) => (
                <span
                  key={lang}
                  className="px-2 py-0.5 text-xs rounded bg-indigo-950/50 text-indigo-300 border border-indigo-800/50"
                >
                  lang:{lang}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 pt-4 border-t border-slate-800 flex justify-between items-center">
          <span className="text-xs text-slate-500 font-mono">
            Week 1 · Task 1: Monorepo Scaffold
          </span>
          <button
            onClick={() => void fetchStatus()}
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition cursor-pointer"
          >
            Refresh Status
          </button>
        </div>
      </div>
    </div>
  );
}
