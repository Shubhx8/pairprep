import { useEffect, useState } from "react";
import { HealthResponse, HealthResponseSchema } from "@pairprep/shared";

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      // Strictly relative path for one-origin resolution in both local dev (Vite proxy) and prod (Caddy)
      const res = await fetch("/healthz");
      if (!res.ok) {
        throw new Error(`Server responded with HTTP ${res.status}`);
      }
      const rawJson: unknown = await res.json();
      const parseResult = HealthResponseSchema.safeParse(rawJson);
      if (!parseResult.success) {
        throw new Error(
          `Healthcheck schema validation failed: ${parseResult.error.message}`
        );
      }
      setHealth(parseResult.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error occurred";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchHealth();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 selection:bg-indigo-500 selection:text-white">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-sm">
        {/* Header / Brand */}
        <div className="flex items-center justify-between pb-6 border-b border-slate-800">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-2">
              <span className="text-emerald-400">⚡</span> PairPrep
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Real-Time Collaborative Interview Platform
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
              health?.status === "ok"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : error
                  ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
            }`}
          >
            {loading ? "Checking..." : health?.status === "ok" ? "Online" : "Offline"}
          </span>
        </div>

        {/* Content Section */}
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              One-Origin Healthcheck Verification
            </h2>
            <span className="text-xs font-mono text-indigo-400 bg-indigo-950/60 border border-indigo-800/40 px-2 py-0.5 rounded">
              GET /healthz
            </span>
          </div>

          {loading && (
            <div className="flex items-center justify-center p-8 text-slate-400 animate-pulse text-sm font-mono">
              Fetching /healthz...
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-950/40 border border-rose-800 rounded-xl text-rose-300 text-sm">
              <p className="font-semibold text-xs uppercase tracking-wider">
                Connection Failed
              </p>
              <p className="mt-1 font-mono text-xs">{error}</p>
            </div>
          )}

          {health && (
            <div className="space-y-3">
              <div className="bg-slate-950/70 p-4 rounded-xl border border-slate-800 text-sm space-y-2">
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-slate-400 text-xs">Status:</span>
                  <span className="font-mono text-emerald-400 font-semibold text-xs uppercase">
                    {health.status}
                  </span>
                </div>
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-slate-400 text-xs">Uptime:</span>
                  <span className="font-mono text-slate-200 text-xs">
                    {health.uptimeSec}s
                  </span>
                </div>
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-slate-400 text-xs">Version:</span>
                  <span className="font-mono text-indigo-400 text-xs">
                    {health.version}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                  Raw JSON Payload:
                </span>
                <pre className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-emerald-300 text-xs font-mono overflow-x-auto">
                  {JSON.stringify(health, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer & Actions */}
        <div className="mt-8 pt-4 border-t border-slate-800 flex justify-between items-center">
          <span className="text-xs text-slate-500 font-mono">
            Task T02 · Same-Origin Hosting
          </span>
          <button
            onClick={() => void fetchHealth()}
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition cursor-pointer"
          >
            Refresh /healthz
          </button>
        </div>
      </div>
    </div>
  );
}
