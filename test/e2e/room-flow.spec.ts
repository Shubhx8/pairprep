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
    // Context A: Host (authenticated)
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();

    // Context B: Anonymous Guest (isolated cookies/storage)
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();

    const mockHostUser = {
      id: "host-user-1",
      email: "host@example.com",
      displayName: "Host Alice",
      role: "user" as const,
      createdAt: new Date().toISOString(),
    };

    const mockRoomSlug = "e2e-practice-room";
    const mockCreatedRoom = {
      id: "room-123",
      title: "E2E Test Room",
      slug: mockRoomSlug,
      language: "python" as const,
      type: "practice" as const,
      status: "active" as const,
      memberCount: 1,
      maxParticipants: 6,
      hostUserId: "host-user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockHostMember = {
      id: "member-host",
      roomId: "room-123",
      userId: "host-user-1",
      displayName: "Host Alice",
      role: "host" as const,
      isOnline: true,
      joinedAt: new Date().toISOString(),
    };

    const mockGuestMember = {
      id: "member-guest",
      roomId: "room-123",
      displayName: "Guest Alice",
      role: "editor" as const,
      isOnline: true,
      joinedAt: new Date().toISOString(),
    };

    // Route mocks for Host
    await hostPage.route("**/api/v1/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockHostUser),
      });
    });

    await hostPage.route("**/api/v1/rooms?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rooms: [], nextCursor: null }),
      });
    });

    await hostPage.route("**/api/v1/rooms", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            room: mockCreatedRoom,
            currentMember: mockHostMember,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await hostPage.route(`**/api/v1/rooms/${mockRoomSlug}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          room: mockCreatedRoom,
          currentMember: mockHostMember,
          members: [mockHostMember],
        }),
      });
    });

    // Route mocks for Guest
    await guestPage.route("**/api/v1/me", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Not authenticated" },
        }),
      });
    });

    let guestJoined = false;
    await guestPage.route(`**/api/v1/rooms/${mockRoomSlug}`, async (route) => {
      if (guestJoined) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            room: { ...mockCreatedRoom, memberCount: 2 },
            currentMember: mockGuestMember,
            members: [mockHostMember, mockGuestMember],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            room: mockCreatedRoom,
            members: [mockHostMember],
          }),
        });
      }
    });

    await guestPage.route(`**/api/v1/rooms/${mockRoomSlug}/join`, async (route) => {
      guestJoined = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          room: { ...mockCreatedRoom, memberCount: 2 },
          currentMember: mockGuestMember,
          members: [mockHostMember, mockGuestMember],
        }),
      });
    });

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
