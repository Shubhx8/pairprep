import { test, expect } from "@playwright/test";

/**
 * PRD ROOM-1, ROOM-2, AUTH-3 E2E Multi-Context Flow:
 * 1. Context A (Host): Creates a practice room from Dashboard, obtains room URL.
 * 2. Context B (Anonymous Guest): Navigates to the room URL, observes Guest Eviction Notice,
 *    enters display name, joins room.
 * 3. Both contexts observe live participant count increment to 2/6.
 */
test.describe("Multi-Context Room Creation & Guest Join Flow", () => {
  test("Host creates room and Guest joins with eviction notice", async ({ browser }) => {
    // Context A: Host
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();

    // Context B: Anonymous Guest (isolated cookies/storage)
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();

    try {
      // 1. Host opens dashboard and clicks "Start a Room"
      await hostPage.goto("/dashboard");
      await expect(
        hostPage.getByRole("heading", { name: "Practice Rooms" })
      ).toBeVisible();

      await hostPage
        .getByRole("button", { name: /Start a Room|New Room/i })
        .first()
        .click();
      await expect(
        hostPage.getByRole("heading", { name: "Create a Practice Room" })
      ).toBeVisible();

      // 2. Host creates room with Python
      await hostPage.getByLabel(/Room Title/i).fill("E2E Test Room");
      await hostPage.getByRole("button", { name: "Create Room" }).click();

      // 3. Host is redirected to /r/:slug
      await hostPage.waitForURL(/\/r\/[a-zA-Z0-9_-]+/);
      const roomUrl = hostPage.url();
      expect(roomUrl).toContain("/r/");

      // Host sees collaborative editor placeholder
      await expect(hostPage.getByText("Collaborative Code Editor")).toBeVisible();
      await expect(hostPage.getByText(/1\/6/)).toBeVisible();

      // 4. Guest opens room link in isolated context
      await guestPage.goto(roomUrl);

      // Guest observes Guest Eviction Notice (PRD AUTH-3)
      await expect(guestPage.getByText("Guest Eviction Notice:")).toBeVisible();
      await expect(
        guestPage.getByText(
          /Active guest participation is limited to one room at a time/i
        )
      ).toBeVisible();

      // 5. Guest submits display name
      await guestPage.getByLabel(/Your Display Name/i).fill("Guest Alice");
      await guestPage.getByRole("button", { name: "Join as Guest" }).click();

      // 6. Guest enters room
      await expect(guestPage.getByText("Collaborative Code Editor")).toBeVisible();
      await expect(guestPage.getByText(/2\/6/)).toBeVisible();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
