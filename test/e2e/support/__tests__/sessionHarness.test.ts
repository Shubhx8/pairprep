import { describe, it, expect } from "vitest";
import {
  signSessionId,
  unsignSessionCookie,
  createSessionCookie,
  SESSION_COOKIE_NAME,
} from "../sessionHarness.js";

describe("sessionHarness", () => {
  const secret = "test_session_secret_at_least_32_characters_long";
  const sessionId = "sess_abc123xyz789";

  it("generates signed session cookie with s: prefix and valid HMAC-SHA256 signature", () => {
    const signed = signSessionId(sessionId, secret);
    expect(signed.startsWith(`s:${sessionId}.`)).toBe(true);
    expect(signed.endsWith("=")).toBe(false); // Base64 padding stripped per cookie-signature
  });

  it("unsigns valid signed session cookie back to original session ID", () => {
    const signed = signSessionId(sessionId, secret);
    const recovered = unsignSessionCookie(signed, secret);
    expect(recovered).toBe(sessionId);
  });

  it("rejects tampered cookie or invalid secret", () => {
    const signed = signSessionId(sessionId, secret);
    const tampered = signed.replace("sess_abc", "sess_xyz");

    expect(unsignSessionCookie(tampered, secret)).toBe(false);
    expect(unsignSessionCookie(signed, "wrong_secret_at_least_32_characters_long")).toBe(
      false
    );
    expect(unsignSessionCookie("not_a_signed_cookie", secret)).toBe(false);
  });

  it("creates structured session cookie object and header", () => {
    const cookie = createSessionCookie(sessionId, secret);
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value.startsWith("s:")).toBe(true);
    expect(cookie.header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });
});
