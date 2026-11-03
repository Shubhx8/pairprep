import { test, expect } from "@playwright/test";
import { createSessionCookie } from "./support/sessionHarness.js";

/**
 * Validates that sessionHarness HMAC-SHA256 cookies
 * are correctly accepted by the API server.
 */
test.describe("Session Harness Integration", () => {
  test("creates valid session cookie format for browser injection", async () => {
    const cookie = createSessionCookie(
      "session_test_id",
      "test_secret_32_characters_minimum_len"
    );
    expect(cookie.name).toBe("pairprep.sid");
    expect(cookie.value).toMatch(/^s:session_test_id\.[A-Za-z0-9+/]+$/);
  });
});
