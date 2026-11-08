import proxyaddr from "proxy-addr";
import type { IncomingMessage } from "node:http";
import net from "node:net";

/**
 * Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
 * so that rate limiting and trust evaluation remain consistent across dual-stack sockets.
 */
export function normalizeIp(ip?: string): string {
  if (!ip || typeof ip !== "string") {
    return "";
  }
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/**
 * Parses a comma-separated list of trusted proxy CIDRs, IPs, or keyword identifiers.
 */
export function parseTrustedProxyCidrs(input?: string): string[] {
  if (!input || typeof input !== "string" || !input.trim()) {
    return [];
  }
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Prohibited broad default ranges that must never be trusted in production.
 */
export const PROHIBITED_PRODUCTION_PROXY_RANGES = new Set([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "0.0.0.0/0",
  "::/0",
  "uniquelocal",
  "linklocal",
]);

/**
 * Validates a single proxy trust entry (IP, CIDR, or predefined identifier).
 */
export function isValidProxyTrustEntry(entry: string): boolean {
  if (!entry || !entry.trim()) return false;
  try {
    proxyaddr.compile([entry]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts that production proxy configuration provides an explicit, non-broad specification.
 * Throws a descriptive error if invalid.
 */
export function assertProductionProxyCidrs(
  input: string | undefined,
  nodeEnv: string = process.env["NODE_ENV"] || "development"
): void {
  if (nodeEnv !== "production") {
    return;
  }
  if (input === undefined) {
    throw new Error("TRUSTED_PROXY_CIDRS must be configured in production");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("TRUSTED_PROXY_CIDRS cannot be empty in production");
  }
  if (trimmed === "loopback") {
    throw new Error(
      "TRUSTED_PROXY_CIDRS cannot use the bare 'loopback' default in production"
    );
  }
  const entries = parseTrustedProxyCidrs(trimmed);
  if (entries.length === 0) {
    throw new Error("TRUSTED_PROXY_CIDRS cannot be empty in production");
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (PROHIBITED_PRODUCTION_PROXY_RANGES.has(lower)) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains prohibited broad range: ${entry}`);
    }
    if (!isValidProxyTrustEntry(entry)) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains invalid entry: ${entry}`);
    }
  }
}

/**
 * Validates that production proxy configuration provides an explicit, non-broad specification.
 * Returns true if valid, false if invalid.
 */
export function validateProductionProxyCidrs(
  input: string | undefined,
  nodeEnv: string = "production"
): boolean {
  try {
    assertProductionProxyCidrs(input, nodeEnv);
    return true;
  } catch {
    return false;
  }
}

export type TrustProxyFn = (addr: string, i: number) => boolean;

/**
 * Compiles a list of trusted proxy CIDRs into a standard trust function.
 * Express accepts `(addr, i) => boolean`, and proxy-addr uses the exact same signature.
 */
export function compileTrustFunction(trusted: string[] | string): TrustProxyFn {
  const list = Array.isArray(trusted) ? trusted : parseTrustedProxyCidrs(trusted);
  const safeList = list.length > 0 ? list : ["loopback"];
  return proxyaddr.compile(safeList);
}

// Default singleton compiled from application configuration
let defaultTrustFn: TrustProxyFn | null = null;

export function getTrustProxyFn(trusted?: string[] | string): TrustProxyFn {
  if (trusted) {
    return compileTrustFunction(trusted);
  }
  if (!defaultTrustFn) {
    const raw = process.env["TRUSTED_PROXY_CIDRS"] || "loopback";
    defaultTrustFn = compileTrustFunction(raw);
  }
  return defaultTrustFn;
}

/**
 * Resets the default compiled trust function (useful in tests when modifying configuration).
 */
export function resetDefaultTrustProxyFn(): void {
  defaultTrustFn = null;
}

/**
 * Extracts the real client IP address from a request using the compiled proxy trust function.
 * Untrusted direct connections cannot spoof client IP via X-Forwarded-For.
 */
export function getClientIp(
  req: IncomingMessage,
  trustFn: TrustProxyFn = getTrustProxyFn()
): string {
  try {
    const rawIp = proxyaddr(req, trustFn) || req.socket.remoteAddress || "127.0.0.1";
    const normalized = normalizeIp(rawIp);
    if (net.isIP(normalized) !== 0) {
      return normalized;
    }
    const fallback = normalizeIp(req.socket.remoteAddress || "127.0.0.1");
    return net.isIP(fallback) !== 0 ? fallback : "127.0.0.1";
  } catch {
    const fallback = normalizeIp(req.socket.remoteAddress || "127.0.0.1");
    return net.isIP(fallback) !== 0 ? fallback : "127.0.0.1";
  }
}
