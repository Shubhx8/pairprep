import { useEffect, useState, lazy, Suspense } from "react";
import { HealthResponse, HealthResponseSchema } from "@pairprep/shared";
import { Terminal } from "lucide-react";
import { Button } from "./components/ui/Button.js";

const LazyToaster = lazy(() =>
  import("./components/ui/Toast.js").then((m) => ({ default: m.Toaster }))
);

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
    <div className="min-h-screen bg-canvas text-text-primary flex flex-col items-center justify-center p-6 font-sans">
      <Suspense fallback={null}>
        <LazyToaster />
      </Suspense>

      <div className="w-full max-w-lg bg-surface border border-border-subtle rounded-2xl p-8 shadow-2xl backdrop-blur-xs">
        {/* Header / Brand */}
        <div className="flex items-center justify-between pb-6 border-b border-border-subtle">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-text-primary flex items-center gap-2">
              <Terminal className="h-7 w-7 text-primary" aria-hidden="true" />
              PairPrep
            </h1>
            <p className="text-xs text-text-secondary mt-1">
              Real-Time Collaborative Interview Platform
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
              health?.status === "ok"
                ? "bg-primary/10 text-primary border border-primary/20"
                : error
                  ? "bg-destructive/10 text-destructive-text border border-destructive/20"
                  : "bg-warning/10 text-warning border border-warning/20"
            }`}
          >
            {loading ? "Checking..." : health?.status === "ok" ? "Online" : "Offline"}
          </span>
        </div>

        {/* Content Section */}
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
              One-Origin Healthcheck Verification
            </h2>
            <span className="text-xs font-mono text-primary bg-surface border border-border-subtle px-2 py-0.5 rounded">
              GET /healthz
            </span>
          </div>

          {loading && (
            <div className="flex items-center justify-center p-8 text-text-secondary animate-pulse text-sm font-mono">
              Fetching /healthz...
            </div>
          )}

          {error && (
            <div className="p-4 bg-surface border border-destructive/50 rounded-xl text-destructive-text text-sm">
              <p className="font-semibold text-xs uppercase tracking-wider">
                Connection Failed
              </p>
              <p className="mt-1 font-mono text-xs">{error}</p>
            </div>
          )}

          {health && (
            <div className="space-y-3">
              <div className="bg-canvas/70 p-4 rounded-xl border border-border-subtle text-sm space-y-2">
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-text-secondary text-xs">Status:</span>
                  <span className="font-mono text-primary font-semibold text-xs uppercase">
                    {health.status}
                  </span>
                </div>
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-text-secondary text-xs">Uptime:</span>
                  <span className="font-mono text-text-primary text-xs">
                    {health.uptimeSec}s
                  </span>
                </div>
                <div className="flex justify-between items-center py-0.5">
                  <span className="text-text-secondary text-xs">Version:</span>
                  <span className="font-mono text-text-primary text-xs">
                    {health.version}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-1">
                  Raw JSON Payload:
                </span>
                <pre className="p-3 bg-canvas rounded-lg border border-border-subtle text-primary text-xs font-mono overflow-x-auto">
                  {JSON.stringify(health, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer & Actions */}
        <div className="mt-8 pt-4 border-t border-border-subtle flex justify-between items-center">
          <span className="text-xs text-text-subtle font-mono">
            Task T06 · Web Application Shell
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void fetchHealth()}
            isLoading={loading}
          >
            Refresh /healthz
          </Button>
        </div>
      </div>
    </div>
  );
}
