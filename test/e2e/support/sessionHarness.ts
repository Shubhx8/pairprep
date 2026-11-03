import { createHmac } from "node:crypto";

export const SESSION_COOKIE_NAME = "pairprep.sid";

/**
 * Isolated configuration for end-to-end testing harness.
 * Uses a dedicated database (pairprep_e2e) and dedicated secret
 * to prevent contaminating test or development databases.
 */
export const E2E_TEST_DATABASE = "pairprep_e2e";
export const E2E_TEST_SECRET = "test_e2e_secret_at_least_32_chars_long_for_security";
export const E2E_MONGODB_URI =
  process.env["MONGODB_URI"] || `mongodb://127.0.0.1:27017/${E2E_TEST_DATABASE}`;

/**
 * Creates an HMAC-SHA256 signed express-session cookie string
 * matching the cookie-signature format used by express-session.
 */
export function signSessionId(sessionId: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(sessionId)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${sessionId}.${hash}`;
}

/**
 * Verifies and unsigns a signed cookie value.
 * Returns the original session ID if valid, or false if signature does not match.
 */
export function unsignSessionCookie(signedValue: string, secret: string): string | false {
  if (!signedValue.startsWith("s:")) return false;
  const raw = signedValue.slice(2);
  const dotIndex = raw.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const sessionId = raw.slice(0, dotIndex);
  const expectedHash = raw.slice(dotIndex + 1);

  const computedHash = createHmac("sha256", secret)
    .update(sessionId)
    .digest("base64")
    .replace(/=+$/, "");

  if (computedHash !== expectedHash) return false;
  return sessionId;
}

/**
 * Generates the complete Set-Cookie / Cookie header value
 * for an authenticated session.
 */
export function createSessionCookie(
  sessionId: string,
  secret: string
): { name: string; value: string; header: string } {
  const signed = signSessionId(sessionId, secret);
  return {
    name: SESSION_COOKIE_NAME,
    value: signed,
    header: `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
  };
}
