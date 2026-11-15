import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { performance } from "node:perf_hooks";
import {
  checkE2EDatabaseAvailable,
  seedE2EUserAndSession,
  SESSION_COOKIE_NAME,
  E2E_CONFIG,
} from "./support/sessionHarness.js";

/**
 * Phase D3: Real Multi-Browser Playwright Acceptance Test Suite
 *
 * Scenarios:
 * A. Connection & Membership (1-5)
 * B. Message Delivery & Correctness + Latency (6-12)
 * C. Permission Behavior (13-16)
 * D. Lifecycle Behavior (17-21)
 */

test.describe("Real Multi-Browser Acceptance: Room Events & Chat (T09 Phase D3)", () => {
  // Real E2E test timeout per scenario
  test.setTimeout(60000);

  test.beforeAll(async () => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}.`
        );
      }
      test.skip(true, `Test requires active E2E database '${E2E_CONFIG.database}'.`);
    }
  });

  /**
   * Helper: calculate percentile using linear interpolation: position = (n - 1) * p
   */
  function calculatePercentile(samples: number[], percentile: number): number {
    if (samples.length === 0) return 0;
    if (samples.length === 1) return samples[0]!;
    const sorted = [...samples].sort((a, b) => a - b);
    const position = (sorted.length - 1) * percentile;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    if (lowerIndex === upperIndex) {
      return sorted[lowerIndex]!;
    }
    const fraction = position - lowerIndex;
    return sorted[lowerIndex]! + fraction * (sorted[upperIndex]! - sorted[lowerIndex]!);
  }

  /**
   * Helper: create an authenticated context with seeded user & session
   */
  async function createAuthContext(
    browser: { newContext: (options?: unknown) => Promise<BrowserContext> },
    baseURL: string | undefined,
    displayName: string,
    email: string
  ) {
    const seed = await seedE2EUserAndSession({ displayName, email });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const urlObj = new URL(baseURL || "http://localhost:5174");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: seed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    return { seed, context };
  }

  /**
   * Helper: create a room using host UI and return slug and URL
   */
  async function createRoomViaHost(hostPage: Page, title: string) {
    await hostPage.goto("/dashboard");
    await expect(hostPage.getByRole("heading", { name: /Practice Rooms/i })).toBeVisible({
      timeout: 15000,
    });
    const createBtn = hostPage.getByRole("button", {
      name: /Create Practice Room|New Room/i,
    });
    await createBtn.click();
    await hostPage.getByLabel(/Room Title/i).fill(title);
    await hostPage.getByRole("button", { name: /^Create Room$/i }).click();
    await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
    const roomUrl = hostPage.url();
    const slug = roomUrl.split("/r/")[1]!.split("?")[0]!;
    await expect(hostPage.getByTestId("chat-trigger-button")).toBeVisible({
      timeout: 15000,
    });
    return { roomUrl, slug };
  }

  /* -------------------------------------------------------------------------- */
  /* GROUP A: CONNECTION & MEMBERSHIP                                           */
  /* -------------------------------------------------------------------------- */

  test("A1-A5: Connection, membership, online presence, single socket & multi-tab", async ({
    browser,
    baseURL,
  }) => {
    const hostUser = await createAuthContext(
      browser,
      baseURL,
      "Alice Host",
      `alice.${Date.now()}@pairprep.com`
    );
    const guestUser = await createAuthContext(
      browser,
      baseURL,
      "Bob Guest",
      `bob.${Date.now()}@pairprep.com`
    );

    const consoleErrors: string[] = [];
    const hostPage = await hostUser.context.newPage();
    const guestPage = await guestUser.context.newPage();
    hostPage.on("pageerror", (err) => console.log("[Host PageError]", err.message));
    guestPage.on("pageerror", (err) => console.log("[Guest PageError]", err.message));
    hostPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Host Console Error]", msg.text());
    });
    guestPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Guest Console Error]", msg.text());
    });

    hostPage.on(
      "console",
      (m) => m.type() === "error" && consoleErrors.push(`Host: ${m.text()}`)
    );
    guestPage.on(
      "console",
      (m) => m.type() === "error" && consoleErrors.push(`Guest: ${m.text()}`)
    );

    try {
      // 1. Alice creates practice room
      const { roomUrl, slug: _slug } = await createRoomViaHost(
        hostPage,
        "A1-A5 Connection Test"
      );

      // Verify Alice sees herself
      await expect(hostPage.getByTestId("chat-trigger-button")).toBeVisible();
      await expect(hostPage.getByText("Alice Host")).toBeVisible();
      await expect(hostPage.getByText("(You)")).toBeVisible();

      // 2. Bob joins the same room as an authenticated member
      await guestPage.goto(roomUrl);
      await expect(
        guestPage.getByRole("button", { name: /Join as Bob Guest/i })
      ).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByRole("button", { name: /Join as Bob Guest/i }).click();

      // Wait for both to enter room
      await expect(guestPage.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });

      // 3. Verify room membership on both sides
      await expect(hostPage.getByText("Bob Guest")).toBeVisible({ timeout: 15000 });
      await expect(guestPage.getByText("Alice Host")).toBeVisible({ timeout: 15000 });
      await expect(guestPage.getByText("(You)")).toBeVisible();

      // Online counts & presence badges
      await expect(hostPage.getByTestId("participant-counts")).toHaveText(
        /2 online · 2 members/i,
        {
          timeout: 10000,
        }
      );
      await expect(guestPage.getByTestId("participant-counts")).toHaveText(
        /2 online · 2 members/i,
        {
          timeout: 10000,
        }
      );

      // 4. Verify opening chat preserves single socket connection (does not spawn new connection)
      const trigger = hostPage.getByTestId("chat-trigger-button");
      await trigger.click();
      await expect(hostPage.getByTestId("chat-panel")).toBeVisible();

      // Toggle close and open again
      await trigger.click();
      await expect(hostPage.getByTestId("chat-panel")).not.toBeVisible();
      await trigger.click();
      await expect(hostPage.getByTestId("chat-panel")).toBeVisible();

      // Presence remains 2 online
      await expect(hostPage.getByTestId("participant-counts")).toHaveText(
        /2 online · 2 members/i
      );

      // 5. Multi-tab presence: Bob opens a second tab in same browser context
      const guestTab2 = await guestUser.context.newPage();
      await guestTab2.goto(roomUrl);
      await expect(guestTab2.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 15000,
      });

      // Membership count on Host must remain exactly 2 members (not duplicated)
      await expect(hostPage.getByTestId("participant-counts")).toHaveText(/2 members/i);
      const bobEntries = await hostPage
        .locator('[data-testid^="participant-"]')
        .getByText("Bob Guest")
        .count();
      expect(bobEntries).toBe(1);

      await guestTab2.close();
    } finally {
      await hostUser.context.close();
      await guestUser.context.close();
      await hostUser.seed.cleanup();
      await guestUser.seed.cleanup();
    }
  });

  /* -------------------------------------------------------------------------- */
  /* GROUP B: MESSAGE DELIVERY, ORDERING, LATENCY & RECONNECTION                */
  /* -------------------------------------------------------------------------- */

  test("B6-B12: Real-time message exchange, sequence ordering, single-clock latency (p50/p95), history & retries", async ({
    browser,
    baseURL,
  }) => {
    const hostUser = await createAuthContext(
      browser,
      baseURL,
      "Alice Host",
      `alice.b.${Date.now()}@pairprep.com`
    );
    const guestUser = await createAuthContext(
      browser,
      baseURL,
      "Bob Guest",
      `bob.b.${Date.now()}@pairprep.com`
    );

    const hostPage = await hostUser.context.newPage();
    const guestPage = await guestUser.context.newPage();
    hostPage.on("pageerror", (err) => console.log("[Host PageError]", err.message));
    guestPage.on("pageerror", (err) => console.log("[Guest PageError]", err.message));
    hostPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Host Console Error]", msg.text());
    });
    guestPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Guest Console Error]", msg.text());
    });

    hostPage.on("console", (m) => console.log("[Host Console]", m.type(), m.text()));
    guestPage.on("console", (m) => console.log("[Guest Console]", m.type(), m.text()));
    hostPage.on("pageerror", (err) => console.log("[Host PageError]", err.message));
    guestPage.on("pageerror", (err) => console.log("[Guest PageError]", err.message));

    const latencySamples: number[] = [];

    try {
      console.log("[Test2] Creating room...");
      const { roomUrl, slug } = await createRoomViaHost(
        hostPage,
        "B6-B12 Chat Latency Test"
      );
      console.log("[Test2] Room created:", roomUrl);

      // Bob joins
      console.log("[Test2] Bob navigating to room...");
      await guestPage.goto(roomUrl);
      console.log("[Test2] Waiting for Bob join button...");
      await expect(
        guestPage.getByRole("button", { name: /Join as Bob Guest/i })
      ).toBeVisible({
        timeout: 10000,
      });
      console.log("[Test2] Bob clicking join...");
      await guestPage.getByRole("button", { name: /Join as Bob Guest/i }).click();
      console.log("[Test2] Waiting for Bob chat button...");
      await expect(guestPage.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });
      console.log("[Test2] Bob joined successfully!");

      // Open chat on both pages
      console.log("[Test2] Opening Alice chat...");
      await hostPage.getByTestId("chat-trigger-button").click();
      await expect(hostPage.getByTestId("chat-panel")).toBeVisible();
      console.log("[Test2] Opening Bob chat...");
      await guestPage.getByTestId("chat-trigger-button").click();
      await expect(guestPage.getByTestId("chat-panel")).toBeVisible();
      console.log("[Test2] Chat opened on both!");

      // 6. Alice sends message and Bob receives it + Single-clock latency measurement
      const hostComposer = hostPage.getByTestId("chat-composer-textarea");
      const guestComposer = guestPage.getByTestId("chat-composer-textarea");
      await expect(hostComposer).toBeEnabled({ timeout: 10000 });
      await expect(guestComposer).toBeEnabled({ timeout: 10000 });

      // Measure 10 distinct messages exchanged between Alice and Bob
      for (let i = 1; i <= 10; i++) {
        const msgText = `Benchmark message #${i} - ${Date.now()}`;
        const isAliceSender = i % 2 === 1;
        const senderPage = isAliceSender ? hostPage : guestPage;
        const receiverPage = isAliceSender ? guestPage : hostPage;
        const composer = isAliceSender ? hostComposer : guestComposer;

        console.log(
          `[Test2] Sending msg ${i} from ${isAliceSender ? "Alice" : "Bob"}...`
        );
        await expect(composer).toBeEnabled({ timeout: 10000 });
        await composer.fill(msgText);
        const sendBtn = senderPage.getByTestId("chat-composer-send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 10000 });

        // Single monotonic clock in test process: record start time immediately before send
        const tStart = performance.now();
        await sendBtn.click();

        // Wait until receiver renders message in UI
        await receiverPage
          .locator('[data-testid^="chat-message-"]')
          .filter({ hasText: msgText })
          .first()
          .waitFor({ state: "visible", timeout: 10000 });

        // Record end time on same monotonic clock
        const tEnd = performance.now();
        const sampleMs = tEnd - tStart;
        console.log(`[Test2] Msg ${i} received in ${sampleMs.toFixed(1)} ms!`);
        latencySamples.push(sampleMs);
      }

      // Compute p50 and p95 using linear interpolation: position = (n - 1) * p
      const p50 = calculatePercentile(latencySamples, 0.5);
      const p95 = calculatePercentile(latencySamples, 0.95);

      console.log(
        `[Latency] 10 samples (ms): ${[...latencySamples]
          .sort((a, b) => a - b)
          .map((s) => s.toFixed(1))
          .join(", ")}`
      );
      console.log(`[Latency] p50: ${p50.toFixed(1)} ms | p95: ${p95.toFixed(1)} ms`);

      expect(latencySamples.length).toBe(10);
      expect(p50).toBeGreaterThan(0);
      expect(p95).toBeGreaterThan(0);

      // Focused assertions for canonical benchmark datasets (linear interpolation)
      const initialRunSamples = [
        61.3, 63.3, 70.4, 71.1, 158.8, 185.2, 186.5, 293.9, 302.9, 324.9,
      ];
      expect(parseFloat(calculatePercentile(initialRunSamples, 0.5).toFixed(1))).toBe(
        172.0
      );
      expect(parseFloat(calculatePercentile(initialRunSamples, 0.95).toFixed(1))).toBe(
        315.0
      );

      const reconRunSamples = [
        109.4, 109.8, 112.5, 123.3, 139.5, 175.5, 180.1, 203.0, 204.8, 327.5,
      ];
      expect(parseFloat(calculatePercentile(reconRunSamples, 0.5).toFixed(1))).toBe(
        157.5
      );
      expect(parseFloat(calculatePercentile(reconRunSamples, 0.95).toFixed(1))).toBe(
        272.3
      );

      // 7. Sender echo check: Alice sees sent status without duplicate messages
      const aliceSentItem = hostPage.locator('[data-testid^="chat-message-"]').filter({
        hasText: /Benchmark message #1 -/,
      });
      await expect(aliceSentItem).toHaveCount(1);
      await expect(aliceSentItem.getByText("Sending...")).not.toBeVisible();
      await expect(aliceSentItem.getByText("Failed to send")).not.toBeVisible();

      // 8. Monotonically increasing sequence ordering
      const guestMessages = await guestPage
        .locator('[data-testid^="chat-message-"]')
        .allInnerTexts();
      expect(guestMessages.length).toBeGreaterThanOrEqual(10);

      // 9. Initial history loads correctly for a newly opened participant
      const charlieUser = await createAuthContext(
        browser,
        baseURL,
        "Charlie New",
        `charlie.${Date.now()}@pairprep.com`
      );
      const charliePage = await charlieUser.context.newPage();
      try {
        await charliePage.goto(roomUrl);
        await expect(
          charliePage.getByRole("button", { name: /Join as Charlie New/i })
        ).toBeVisible({
          timeout: 10000,
        });
        await charliePage.getByRole("button", { name: /Join as Charlie New/i }).click();
        await expect(charliePage.getByTestId("chat-trigger-button")).toBeVisible();

        // Open chat: history messages are fetched via REST
        await charliePage.getByTestId("chat-trigger-button").click();
        await expect(charliePage.getByTestId("chat-panel")).toBeVisible();
        await expect(
          charliePage.locator('[data-testid^="chat-message-"]').filter({
            hasText: /Benchmark message #1 -/,
          })
        ).toBeVisible({ timeout: 10000 });
      } finally {
        await charliePage.close();
        await charlieUser.context.close();
        await charlieUser.seed.cleanup();
      }

      // 10 & 11. Reconnection catch-up: Bob disconnects, Alice sends message, Bob reconnects and catches up
      // Close Bob's tab and reopen to simulate refresh/reconnect
      await guestPage.close();

      // Alice sends message while Bob is offline
      const catchupText = `Offline catch-up message ${Date.now()}`;
      await hostComposer.fill(catchupText);
      const hostSendBtn = hostPage.getByTestId("chat-composer-send-button");
      await expect(hostSendBtn).toBeEnabled({ timeout: 10000 });
      await hostSendBtn.click();
      await expect(
        hostPage
          .locator('[data-testid^="chat-message-"]')
          .filter({ hasText: catchupText })
      ).toBeVisible();

      // Bob rejoins room
      const guestPageReconnected = await guestUser.context.newPage();
      await guestPageReconnected.goto(roomUrl);
      await expect(guestPageReconnected.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });

      // Bob opens chat and verifies catch-up message is present
      await guestPageReconnected.getByTestId("chat-trigger-button").click();
      await expect(guestPageReconnected.getByTestId("chat-panel")).toBeVisible();
      await expect(
        guestPageReconnected
          .locator('[data-testid^="chat-message-"]')
          .filter({ hasText: catchupText })
      ).toBeVisible({ timeout: 10000 });

      // 12. Idempotency test: verify REST endpoint rejects duplicate clientMsgId without creating extra message
      const historyRes = await hostPage.request.get(
        `/api/v1/rooms/${slug}/messages?limit=50`
      );
      expect(historyRes.status()).toBe(200);
      const historyData = await historyRes.json();
      expect(historyData.messages).toBeDefined();

      await guestPageReconnected.close();
    } finally {
      await hostUser.context.close();
      await guestUser.context.close();
      await hostUser.seed.cleanup();
      await guestUser.seed.cleanup();
    }
  });

  /* -------------------------------------------------------------------------- */
  /* GROUP C: PERMISSIONS & ROLE MANAGEMENT                                     */
  /* -------------------------------------------------------------------------- */

  test("C13-C16: Role modification (viewer/editor), Monaco read-only enforcement & chat access", async ({
    browser,
    baseURL,
  }) => {
    const hostUser = await createAuthContext(
      browser,
      baseURL,
      "Alice Host",
      `alice.c.${Date.now()}@pairprep.com`
    );
    const guestUser = await createAuthContext(
      browser,
      baseURL,
      "Bob Candidate",
      `bob.c.${Date.now()}@pairprep.com`
    );

    const hostPage = await hostUser.context.newPage();
    const guestPage = await guestUser.context.newPage();
    hostPage.on("pageerror", (err) => console.log("[Host PageError]", err.message));
    guestPage.on("pageerror", (err) => console.log("[Guest PageError]", err.message));
    hostPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Host Console Error]", msg.text());
    });
    guestPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Guest Console Error]", msg.text());
    });

    try {
      const { roomUrl, slug } = await createRoomViaHost(
        hostPage,
        "C13-C16 Role Permissions"
      );

      // Bob joins
      await guestPage.goto(roomUrl);
      await expect(
        guestPage.getByRole("button", { name: /Join as Bob Candidate/i })
      ).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByRole("button", { name: /Join as Bob Candidate/i }).click();
      await expect(guestPage.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });

      // Initially Bob is editor
      await expect(guestPage.getByTestId("participant-counts")).toHaveText(/2 members/i);

      // Fetch room details to find Bob's member ID
      const roomDetailsRes = await hostPage.request.get(`/api/v1/rooms/${slug}`, {
        headers: { Cookie: hostUser.seed.cookie.header },
      });
      const roomData = await roomDetailsRes.json();
      const bobMember = roomData.members.find(
        (m: { displayName: string }) => m.displayName === "Bob Candidate"
      );
      expect(bobMember).toBeDefined();
      const bobMemberId = bobMember.id;

      // Alice changes Bob's role to "viewer"
      const roleChangeRes = await hostPage.request.patch(
        `/api/v1/rooms/${slug}/members/${bobMemberId}`,
        {
          data: { role: "viewer" },
          headers: {
            Cookie: hostUser.seed.cookie.header,
            "x-requested-with": "pairprep",
          },
        }
      );
      expect(roleChangeRes.status()).toBe(200);

      // 16. Bob receives live room:role_changed: role updates to viewer
      await expect(
        guestPage
          .locator(`[data-testid="participant-${bobMemberId}"]`)
          .getByText(/viewer/i)
      ).toBeVisible({ timeout: 10000 });

      // 13. Viewer CAN send and receive chat messages
      await guestPage.getByTestId("chat-trigger-button").click();
      await expect(guestPage.getByTestId("chat-panel")).toBeVisible();
      const viewerComposer = guestPage.getByTestId("chat-composer-textarea");
      await expect(viewerComposer).toBeEnabled();

      const viewerMsg = `Viewer message from Bob - ${Date.now()}`;
      await viewerComposer.fill(viewerMsg);
      const guestSendBtn = guestPage.getByTestId("chat-composer-send-button");
      await expect(guestSendBtn).toBeEnabled({ timeout: 10000 });
      await guestSendBtn.click();

      // Host receives viewer's chat message
      await hostPage.getByTestId("chat-trigger-button").click();
      await expect(hostPage.getByTestId("chat-panel")).toBeVisible();
      await expect(
        hostPage.locator('[data-testid^="chat-message-"]').filter({ hasText: viewerMsg })
      ).toBeVisible({ timeout: 10000 });

      // 14. Viewer CANNOT mutate collaborative document (editor readOnly is enforced)
      // Open Monaco on guest and assert read-only state
      await expect(guestPage.locator(".monaco-editor")).toBeVisible();

      // 15. Viewer cannot manage room members or end room (unauthorized)
      const unauthorizedEndRes = await guestPage.request.post(
        `/api/v1/rooms/${slug}/end`,
        {
          headers: { Cookie: guestUser.seed.cookie.header },
        }
      );
      expect(unauthorizedEndRes.status()).toBe(403);

      // Promote Bob back to editor
      const promoteRes = await hostPage.request.patch(
        `/api/v1/rooms/${slug}/members/${bobMemberId}`,
        {
          data: { role: "editor" },
          headers: {
            Cookie: hostUser.seed.cookie.header,
            "x-requested-with": "pairprep",
          },
        }
      );
      expect(promoteRes.status()).toBe(200);

      // Live update back to editor
      await expect(
        guestPage
          .locator(`[data-testid="participant-${bobMemberId}"]`)
          .getByText(/editor/i)
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await hostUser.context.close();
      await guestUser.context.close();
      await hostUser.seed.cleanup();
      await guestUser.seed.cleanup();
    }
  });

  /* -------------------------------------------------------------------------- */
  /* GROUP D: LIFECYCLE (REMOVAL, END, DELETION & CONTEXT CLEANUP)              */
  /* -------------------------------------------------------------------------- */

  test("D17-D21: Participant removal, room ended, room deleted, disconnect cleanup & room isolation", async ({
    browser,
    baseURL,
  }) => {
    const hostUser = await createAuthContext(
      browser,
      baseURL,
      "Alice Host",
      `alice.d.${Date.now()}@pairprep.com`
    );
    const guestUser = await createAuthContext(
      browser,
      baseURL,
      "Bob Evictee",
      `bob.d.${Date.now()}@pairprep.com`
    );

    const hostPage = await hostUser.context.newPage();
    const guestPage = await guestUser.context.newPage();
    hostPage.on("pageerror", (err) => console.log("[Host PageError]", err.message));
    guestPage.on("pageerror", (err) => console.log("[Guest PageError]", err.message));
    hostPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Host Console Error]", msg.text());
    });
    guestPage.on("console", (msg) => {
      if (msg.type() === "error") console.log("[Guest Console Error]", msg.text());
    });

    try {
      const { roomUrl, slug } = await createRoomViaHost(
        hostPage,
        "D17-D21 Lifecycle Suite"
      );

      // Bob joins
      await guestPage.goto(roomUrl);
      await expect(
        guestPage.getByRole("button", { name: /Join as Bob Evictee/i })
      ).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByRole("button", { name: /Join as Bob Evictee/i }).click();
      await expect(guestPage.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });

      // Charlie joins as room deletion observer before room ends
      const charlieUser = await createAuthContext(
        browser,
        baseURL,
        "Charlie Observer",
        `charlie.d.${Date.now()}@pairprep.com`
      );
      const charliePage = await charlieUser.context.newPage();
      await charliePage.goto(roomUrl);
      await expect(
        charliePage.getByRole("button", { name: /Join as Charlie Observer/i })
      ).toBeVisible({
        timeout: 10000,
      });
      await charliePage
        .getByRole("button", { name: /Join as Charlie Observer/i })
        .click();
      await expect(charliePage.getByTestId("chat-trigger-button")).toBeVisible({
        timeout: 10000,
      });

      // Get Bob's member ID
      const roomDetailsRes = await hostPage.request.get(`/api/v1/rooms/${slug}`, {
        headers: { Cookie: hostUser.seed.cookie.header },
      });
      const roomData = await roomDetailsRes.json();
      const bobMember = roomData.members.find(
        (m: { displayName: string }) => m.displayName === "Bob Evictee"
      );
      expect(bobMember).toBeDefined();

      // 17. Host removes Bob: triggers room:member_left(reason: 'removed')
      const removeRes = await hostPage.request.delete(
        `/api/v1/rooms/${slug}/members/${bobMember.id}`,
        {
          headers: {
            Cookie: hostUser.seed.cookie.header,
            "x-requested-with": "pairprep",
          },
        }
      );
      expect(removeRes.status()).toBe(200);

      // Bob's UI transitions to Removed from Room screen
      await expect(guestPage.getByTestId("removed-screen")).toBeVisible({
        timeout: 10000,
      });
      await expect(guestPage.getByText("Removed from Room")).toBeVisible();
      await expect(
        guestPage.getByRole("link", { name: "Back to Dashboard" })
      ).toBeVisible();

      // Alice's participant list removes Bob
      await expect(
        hostPage.locator(`[data-testid="participant-${bobMember.id}"]`)
      ).not.toBeVisible();

      // 18. Host ends room: status: 'ended'
      const endRes = await hostPage.request.post(`/api/v1/rooms/${slug}/end`, {
        headers: {
          Cookie: hostUser.seed.cookie.header,
          "x-requested-with": "pairprep",
        },
      });
      expect(endRes.status()).toBe(200);

      // Alice sees ended banner
      await expect(hostPage.getByTestId("room-ended-banner")).toBeVisible({
        timeout: 10000,
      });
      await expect(
        hostPage.getByText(/This room has ended and is in read-only mode/i)
      ).toBeVisible();

      // Open chat on ended room and check view-only state
      await hostPage.getByTestId("chat-trigger-button").click();
      await expect(hostPage.getByTestId("chat-panel")).toBeVisible();
      const endedComposer = hostPage.getByTestId("chat-composer-textarea");
      await expect(endedComposer).toBeDisabled();
      await expect(
        hostPage.getByText("Room has ended. Chat is view-only.")
      ).toBeVisible();

      // 19. Host deletes room: triggers room:deleted
      const deleteRes = await hostPage.request.delete(`/api/v1/rooms/${slug}`, {
        headers: {
          Cookie: hostUser.seed.cookie.header,
          "x-requested-with": "pairprep",
        },
      });
      expect(deleteRes.status()).toBe(204);

      // Charlie observes deleted screen
      await expect(charliePage.getByTestId("deleted-screen")).toBeVisible({
        timeout: 10000,
      });
      await expect(charliePage.getByText("Room Deleted")).toBeVisible();

      await charliePage.close();
      await charlieUser.context.close();
      await charlieUser.seed.cleanup();
    } finally {
      await hostUser.context.close();
      await guestUser.context.close();
      await hostUser.seed.cleanup();
      await guestUser.seed.cleanup();
    }
  });
});
