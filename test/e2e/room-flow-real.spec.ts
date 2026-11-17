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

  test("P0 Room Management E2E: Voluntary leave, Owner kick with ban re-entry security, and End session", async ({
    browser,
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
        `Real-stack E2E test requires an active local test database '${E2E_CONFIG.database}'`
      );
    }

    const seed = await seedE2EUserAndSession({
      displayName: "Host Owner",
      email: "host.owner@example.com",
    });

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      // 1. Host logs in and creates room
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

      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({ timeout: 10000 });

      const createBtn = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      if (await createBtn.isVisible()) {
        await createBtn.click();
        const titleInput = hostPage.getByLabel(/Room Title/i);
        if (await titleInput.isVisible()) {
          await titleInput.fill("P0 Management Room");
          await hostPage.getByRole("button", { name: /^Create Room$/i }).click();
        }
      }

      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();

      // 2. Guest joins room
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);

      const nameInput = guestPage.getByLabel(/Your Display Name/i);
      await nameInput.fill("Guest Charlie");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      await expect(guestPage.getByTestId("room-header")).toBeVisible({ timeout: 10000 });
      await expect(guestPage.getByText(/2\/6/)).toBeVisible({ timeout: 10000 });

      // 3. Voluntary Leave: Guest leaves room
      const leaveBtn = guestPage.getByTestId("leave-room-button");
      await expect(leaveBtn).toBeVisible({ timeout: 5000 });
      await leaveBtn.click();

      // Leave confirmation modal
      const leaveModal = guestPage.getByTestId("leave-room-modal");
      await expect(leaveModal).toBeVisible({ timeout: 5000 });
      await guestPage.getByTestId("confirm-leave-button").click();

      // Guest redirected to /dashboard
      await guestPage.waitForURL(/\/dashboard/, { timeout: 10000 });

      // Host sees member count decrement to 1/6
      await expect(hostPage.getByText(/1\/6/)).toBeVisible({ timeout: 10000 });

      // 4. Voluntary leaver can rejoin
      await guestPage.goto(roomUrl);
      const rejoinInput = guestPage.getByLabel(/Your Display Name/i);
      await expect(rejoinInput).toBeVisible({ timeout: 10000 });
      await rejoinInput.fill("Guest Charlie Rejoined");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      await expect(guestPage.getByTestId("room-header")).toBeVisible({ timeout: 10000 });
      await expect(hostPage.getByText(/2\/6/)).toBeVisible({ timeout: 10000 });

      // 5. Host Kicks Guest & Ban Re-entry Enforcement
      // Open members panel on host if not open
      const membersPanel = hostPage.getByTestId("members-panel");
      if (!(await membersPanel.isVisible())) {
        await hostPage.getByTestId("members-toggle-button").click();
      }
      await expect(membersPanel).toBeVisible({ timeout: 5000 });

      // Find kick button for Guest Charlie Rejoined
      const kickButton = hostPage.locator('[data-testid^="remove-member-"]').first();
      await expect(kickButton).toBeVisible({ timeout: 5000 });
      await kickButton.click();

      // Kick confirmation modal
      const removeModal = hostPage.getByTestId("remove-member-modal");
      await expect(removeModal).toBeVisible({ timeout: 5000 });
      await hostPage.getByTestId("confirm-remove-button").click();

      // Guest immediately receives removed notice and lands on removed-screen
      await expect(guestPage.getByTestId("removed-screen")).toBeVisible({
        timeout: 10000,
      });
      await expect(
        guestPage.getByText(/You have been removed from this room by the host/i)
      ).toBeVisible({ timeout: 5000 });

      // Kicked guest attempts to navigate back to roomUrl
      await guestPage.goto(roomUrl);

      // Should be barred with removed-screen (MEMBER_BANNED / 403)
      await expect(guestPage.getByTestId("removed-screen")).toBeVisible({
        timeout: 10000,
      });

      // 6. Host Ends Room Session
      const endSessionBtn = hostPage.getByTestId("end-session-button");
      await expect(endSessionBtn).toBeVisible({ timeout: 5000 });
      await endSessionBtn.click();

      const endModal = hostPage.getByTestId("end-session-modal");
      await expect(endModal).toBeVisible({ timeout: 5000 });
      await hostPage.getByTestId("confirm-end-button").click();

      // Host sees read-only banner
      await expect(hostPage.getByTestId("room-ended-banner")).toBeVisible({
        timeout: 10000,
      });
      await expect(
        hostPage.getByText(/This room has ended and is in read-only mode/i)
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await hostContext.close();
      await guestContext.close();
      await seed.cleanup();
    }
  });
});
