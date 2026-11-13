export interface GetSyncUrlOptions {
  overrideUrl?: string;
  protocol?: string;
  host?: string;
}

/**
 * Resolves the Hocuspocus WebSocket URL for real-time document synchronization.
 *
 * In browser:
 * - Uses window.location.protocol and window.location.host to connect to `/sync`.
 * - Resolves `ws:` vs `wss:` based on the current page protocol (http: -> ws:, https: -> wss:).
 * - Leverages the existing Vite development proxy (`/sync` with `ws: true`) or production same-origin proxy.
 *
 * SSR-safe:
 * - Does not throw when `window` is undefined.
 */
export function getSyncUrl(options?: GetSyncUrlOptions): string {
  if (options?.overrideUrl) {
    return options.overrideUrl;
  }

  const protocol =
    options?.protocol ??
    (typeof window !== "undefined" && window.location?.protocol
      ? window.location.protocol
      : "http:");

  const host =
    options?.host ??
    (typeof window !== "undefined" && window.location?.host
      ? window.location.host
      : "localhost:3000");

  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/sync`;
}
