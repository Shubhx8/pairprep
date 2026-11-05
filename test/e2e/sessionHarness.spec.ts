import { test, expect } from "@playwright/test";
import {
  createSessionCookie,
  seedE2EUserAndSession,
  checkE2EDatabaseAvailable,
  E2E_CONFIG,
} from "./support/sessionHarness.js";

/**
 * Validates that sessionHarness HMAC-SHA256 cookies
 * are correctly formatted and accepted by the real API server.
 */
test.describe("Session Harness Integration", () => {
  test("creates valid session cookie format for browser injection (format test)", async () => {
    const cookie = createSessionCookie(
      "session_test_id",
      "test_secret_32_characters_minimum_len"
    );
    expect(cookie.name).toBe("pairprep.sid");
    expect(cookie.value).toMatch(/^s:session_test_id\.[A-Za-z0-9+/]+$/);
  });

  test("real stack: requests GET /api/v1/me with seeded cookie and asserts 200 with seeded user", async ({
    request,
    baseURL,
  }) => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}.`
        );
      }
      test.skip(
        true,
        `Real-stack session test requires active local test database '${E2E_CONFIG.database}'`
      );
      return;
    }

    const seed = await seedE2EUserAndSession({
      displayName: "Seeded Test User",
      email: "seeded.user@example.com",
    });

    try {
      const apiBase = baseURL || "http://localhost:5173";
      const response = await request.get(`${apiBase}/api/v1/me`, {
        headers: {
          Cookie: seed.cookie.header,
        },
      });

      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(seed.userId);
      expect(data.displayName).toBe("Seeded Test User");
      expect(data.email).toBe("seeded.user@example.com");
    } finally {
      await seed.cleanup();
    }
  });
});
