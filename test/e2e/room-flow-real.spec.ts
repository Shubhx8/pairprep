import { test, expect } from "@playwright/test";
import {
  checkE2EDatabaseAvailable,
  seedE2EUserAndSession,
  SESSION_COOKIE_NAME,
  E2E_CONFIG,
} from "./support/sessionHarness.js";

/**
 * Real-Stack End-to-End Multi-Context Flow:
 * - Context A: Seeded real session in MongoDB (pairprep_e2e), creates room via real API
 * - Context B: Real guest join via POST /api/v1/rooms/:slug/join
 * - Real live verification across both browser contexts
 * - Guard: Skips in local development if DB is down; fails in CI if DB is unreachable.
 */
test.describe("Real-Stack Room Creation & Multi-Context Guest Join", () => {
  test("Real-stack flow: seeded session, real room creation, real POST /join, second context", async ({
    browser,
    baseURL,
  }) => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}. In CI the database service must be active.`
        );
      }
      test.skip(
        true,
        `Real-stack E2E test requires an active local test database '${E2E_CONFIG.database}' (run 'npm run db:test:up' first)`
      );
    }

    const seed = await seedE2EUserAndSession({
      displayName: "Alice Host",
      email: "alice.host@example.com",
    });

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      // 1. Context A (Host): Inject seeded session cookie
      const urlObj = new URL(baseURL || "http://localhost:5173");
      await hostContext.addCookies([
        {
          name: SESSION_COOKIE_NAME,
          value: seed.cookie.value,
          domain: urlObj.hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);

      const hostPage = await hostContext.newPage();
      await hostPage.goto("/dashboard");

      // Verify authenticated host dashboard renders
      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({
        timeout: 10000,
      });

      // 2. Host creates a practice room
      const createButton = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      if (await createButton.isVisible()) {
        await createButton.click();
        const titleInput = hostPage.getByLabel(/Room Title/i);
        if (await titleInput.isVisible()) {
          await titleInput.fill("Real-Stack E2E Room");
          await hostPage.getByRole("button", { name: /^Create Room$/i }).click();
        }
      }

      // Wait for navigation to /r/<slug>
      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();
      const slug = roomUrl.split("/r/")[1];
      expect(slug).toBeDefined();

      // 3. Context B (Guest): Anonymous visitor opens room URL
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);

      // Verify guest join notice and form
      await expect(guestPage.getByText("Guest Eviction Notice:")).toBeVisible({
        timeout: 10000,
      });
      await expect(
        guestPage.getByText(
          /Active guest participation is limited to one room at a time/i
        )
      ).toBeVisible({ timeout: 10000 });

      const nameInput = guestPage.getByLabel(/Your Display Name/i);
      await nameInput.fill("Bob Guest");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      // 4. Verify guest successfully joins room
      await expect(guestPage.getByText("Collaborative Code Editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(guestPage.getByText(/2\/6/)).toBeVisible({
        timeout: 10000,
      });
    } finally {
      await hostContext.close();
      await guestContext.close();
      await seed.cleanup();
    }
  });
});
