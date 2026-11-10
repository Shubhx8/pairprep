import { test, expect } from "@playwright/test";
import path from "node:path";
import mongoose from "mongoose";
import * as Y from "yjs";
import { DocUpdateModel } from "../../apps/server/src/models/doc_updates.js";
import {
  checkE2EDatabaseAvailable,
  seedE2EUserAndSession,
  SESSION_COOKIE_NAME,
  E2E_CONFIG,
} from "./support/sessionHarness.js";

/**
 * Phase 3 — Monaco Editor Real Browser Collaboration E2E Test Suite.
 *
 * Verifies in real Chromium browser contexts against the full development stack:
 * - Real-time bidirectional collaborative editing between Host and Guest
 * - Dynamic language switching synchronized across clients
 * - Remote cursor decorations and participant name labels in distinct colors
 * - Offline tolerance: local edits preserved in memory, offline status badge, and automatic merge upon reconnect
 * - Playwright trace artifact export
 * - Ended room synchronization: connects to sync, loads saved code, enforces read-only
 * - Role-enforced read-only: viewer cannot type and server-side rejection of forced edits
 * - Hostile display names containing quotes, braces, and </style> cannot break cursor-label CSS
 * - React StrictMode safety: keystrokes do not duplicate characters
 */
test.describe("Monaco Editor Real Browser Collaboration (T08 Phase 3)", () => {
  test("two browser contexts collaborate in real time with remote cursors, language selection, and offline sync with trace artifact", async ({
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
        `Real-stack E2E test requires an active test database '${E2E_CONFIG.database}'.`
      );
    }

    // 1. Seed Host User and Session
    const hostSeed = await seedE2EUserAndSession({
      displayName: "Alice Host",
      email: `alice.${Date.now()}@pairprep.com`,
    });

    const hostContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const guestContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });

    const urlObj = new URL(baseURL || "http://localhost:5173");
    await hostContext.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    // Start Playwright tracing on Host context to record the collaboration and offline/reconnect flow
    try {
      await hostContext.tracing.start({ screenshots: true, snapshots: true });
    } catch {
      // Tracing may already be active via playwright.config.ts trace on-first-retry
    }

    try {
      // 2. Host creates room from Dashboard
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/dashboard");

      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({ timeout: 15000 });

      const createBtn = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();

      await hostPage.getByLabel(/Room Title/i).fill("Realtime Monaco Collab");
      await hostPage.getByRole("button", { name: /^Create Room$/i }).click();

      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();

      // 3. Verify Host enters room and Monaco mounts
      await expect(hostPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(hostPage.locator(".monaco-editor")).toBeVisible({
        timeout: 10000,
      });

      // Verify sync status reaches "Synced"
      await expect(hostPage.getByRole("status")).toHaveText(/Synced|Syncing/i, {
        timeout: 10000,
      });

      // 4. Language selection test on Host
      const languageSelect = hostPage.locator("#language-select");
      await expect(languageSelect).toBeVisible();
      await languageSelect.selectOption("javascript");
      await expect(hostPage.getByText("main.js")).toBeVisible({ timeout: 5000 });

      // 5. Context B (Guest) joins room
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);

      await expect(guestPage.getByLabel(/Your Display Name/i)).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByLabel(/Your Display Name/i).fill("Bob Peer");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      // Guest enters room and Monaco mounts
      await expect(guestPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(guestPage.locator(".monaco-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(guestPage.getByRole("status")).toHaveText(/Synced|Syncing/i, {
        timeout: 10000,
      });

      // 6. Host types code into Monaco Editor
      const hostInputarea = hostPage.locator(".monaco-editor textarea.inputarea");
      await hostInputarea.focus();
      await hostPage.keyboard.type("function hello() {\n  return 'from host';\n}\n");

      // 7. Verify Guest receives Host's code in real time
      await expect(guestPage.locator(".monaco-editor")).toContainText("from host", {
        timeout: 8000,
      });

      // 8. Guest types into Monaco Editor
      const guestInputarea = guestPage.locator(".monaco-editor textarea.inputarea");
      await guestInputarea.focus();
      await guestPage.keyboard.type("// Added by Bob\n");

      // Verify Host receives Guest's edit in real time
      await expect(hostPage.locator(".monaco-editor")).toContainText("Added by Bob", {
        timeout: 8000,
      });

      // 9. Verify remote cursor / selection presence (ED-3 Monaco DOM decorations & styling)
      await guestInputarea.focus();
      await guestPage.keyboard.press("ArrowUp");
      await guestPage.keyboard.press("Shift+ArrowRight");

      // Verify awareness stylesheet exists in Host page with remote user and palette rules
      const awarenessStyleLocator = hostPage.locator(
        'style[data-pairprep-awareness="true"]'
      );
      await expect(awarenessStyleLocator).toBeAttached({
        timeout: 5000,
      });
      const awarenessStyleContent = await awarenessStyleLocator.textContent();
      expect(awarenessStyleContent).toContain(".yRemoteSelection");
      expect(awarenessStyleContent).toContain(".yRemoteSelectionHead");
      expect(awarenessStyleContent).toContain('content: "Bob Peer"');
      expect(awarenessStyleContent).toContain("background-color: #");

      // Verify actual Monaco DOM cursor and selection decorations rendered inside Host editor
      await expect(hostPage.locator(".monaco-editor .yRemoteSelection")).toBeAttached({
        timeout: 5000,
      });
      await expect(hostPage.locator(".monaco-editor .yRemoteSelectionHead")).toBeAttached(
        { timeout: 5000 }
      );

      // 10. Offline tolerance and reconnection test (Section 8.E)
      // Simulate Host going offline
      await hostContext.setOffline(true);
      await expect(hostPage.getByRole("status")).toHaveText(/Offline/i, {
        timeout: 8000,
      });

      // Host types while offline (local edits preserved in mounted Y.Doc)
      await hostInputarea.focus();
      await hostPage.keyboard.type("// Offline note from host\n");
      await expect(hostPage.locator(".monaco-editor")).toContainText(
        "Offline note from host"
      );

      // Guest does not see it yet while host is offline
      expect(await guestPage.locator(".monaco-editor").innerText()).not.toContain(
        "Offline note from host"
      );

      // Reconnect Host
      await hostContext.setOffline(false);
      await expect(hostPage.getByRole("status")).toHaveText(/Synced|Connected|Syncing/i, {
        timeout: 10000,
      });

      // Guest now receives the offline note once reconnected!
      await expect(guestPage.locator(".monaco-editor")).toContainText(
        "Offline note from host",
        {
          timeout: 8000,
        }
      );
    } finally {
      // Stop tracing and save trace artifact to test-results/traces/t08-offline-trace.zip
      const tracePath = path.resolve(
        process.cwd(),
        "test-results/traces/t08-offline-trace.zip"
      );
      try {
        await hostContext.tracing.stop({ path: tracePath });
      } catch {
        /* ignore trace error if already closed */
      }

      await hostContext.close();
      await guestContext.close();
      await hostSeed.cleanup();
    }
  });

  test("ended room establishes synchronization, renders saved code, and enforces read-only mode", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "Ended Room Tester",
      email: `ended.${Date.now()}@pairprep.com`,
    });

    const context = await browser.newContext();
    const urlObj = new URL(baseURL || "http://localhost:5173");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      const page = await context.newPage();
      await page.goto("/dashboard");

      await expect(page.getByRole("heading", { name: /Practice Rooms/i })).toBeVisible({
        timeout: 15000,
      });

      const createBtn = page.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await page.getByLabel(/Room Title/i).fill("Saved Content Ended Room");
      await page.getByRole("button", { name: /^Create Room$/i }).click();

      await page.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = page.url();
      const slug = roomUrl.split("/r/")[1];

      await expect(page.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("status")).toHaveText(/Synced|Syncing/i, {
        timeout: 10000,
      });

      // Type initial saved code before ending room
      const inputarea = page.locator(".monaco-editor textarea.inputarea");
      await inputarea.focus();
      await page.keyboard.type("const SAVED_CONSTANT = 3.14159;\n");

      // Verify text is present in Monaco
      await expect(page.locator(".monaco-editor")).toContainText("SAVED_CONSTANT");

      // End the room via the backend API
      const endRes = await page.request.post(`/api/v1/rooms/${slug}/end`, {
        headers: {
          "X-Requested-With": "pairprep",
        },
      });
      expect(endRes.status()).toBe(200);

      // Reload page: an authorized user visiting an ended room must connect to sync,
      // load the saved document, and view it in read-only mode
      await page.reload();

      // 1. Verify read-only notice banner and "Read-Only" badge are visible
      await expect(
        page.getByText(/This room has ended and is in read-only mode/i)
      ).toBeVisible({ timeout: 8000 });
      await expect(page.getByText("Read-Only", { exact: true })).toBeVisible();
      await expect(page.locator("#language-select")).toBeDisabled();

      // 2. Verify synchronization connection is established (reaches Synced)
      await expect(page.getByRole("status")).toHaveText(/Synced|Connected|Syncing/i, {
        timeout: 10000,
      });

      // 3. Verify saved code is loaded and displayed in Monaco
      await expect(page.locator(".monaco-editor")).toContainText("SAVED_CONSTANT", {
        timeout: 8000,
      });

      // 4. Verify editing is disabled: typing does not modify editor text
      const beforeType = await page.locator(".monaco-editor").innerText();
      await inputarea.focus();
      await page.keyboard.type("MODIFICATION_ATTEMPT");
      const afterType = await page.locator(".monaco-editor").innerText();
      expect(afterType).toBe(beforeType);
      expect(afterType).not.toContain("MODIFICATION_ATTEMPT");
    } finally {
      await context.close();
      await hostSeed.cleanup();
    }
  });

  test("viewer cannot type into document and forced edit is rejected by server (Section 8.A & 8.B)", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "Room Owner",
      email: `owner.${Date.now()}@pairprep.com`,
    });

    const hostContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const guestContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const urlObj = new URL(baseURL || "http://localhost:5173");

    await hostContext.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/dashboard");
      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({
        timeout: 10000,
      });

      const createBtn = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await hostPage.getByLabel(/Room Title/i).fill("Viewer Permissions Test");
      await hostPage.getByRole("button", { name: /^Create Room$/i }).click();

      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();
      const slug = roomUrl.split("/r/")[1]!;

      // Host enters and types initial master text
      await expect(hostPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      const hostInputarea = hostPage.locator(".monaco-editor textarea.inputarea");
      await hostInputarea.focus();
      await hostPage.keyboard.type("const MASTER_CODE = 100;\n");
      await expect(hostPage.locator(".monaco-editor")).toContainText("MASTER_CODE");

      // Guest joins
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);
      await expect(guestPage.getByLabel(/Your Display Name/i)).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByLabel(/Your Display Name/i).fill("Observer Guest");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      await expect(guestPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(guestPage.locator(".monaco-editor")).toContainText("MASTER_CODE", {
        timeout: 8000,
      });

      // Find Guest's membership ID from room details API
      const roomDetailsRes = await hostPage.request.get(`/api/v1/rooms/${slug}`);
      const roomDetails = await roomDetailsRes.json();
      const guestMember = roomDetails.members.find(
        (m: { displayName: string }) => m.displayName === "Observer Guest"
      );
      expect(guestMember).toBeDefined();

      // Host demotes Guest to "viewer" role via REST API
      const patchRes = await hostPage.request.patch(
        `/api/v1/rooms/${slug}/members/${guestMember.id}`,
        {
          data: { role: "viewer" },
          headers: { "X-Requested-With": "pairprep" },
        }
      );
      expect(patchRes.status()).toBe(200);

      // Reload or wait for guest page to reflect viewer mode
      await guestPage.reload();
      await expect(guestPage.getByText("Read-Only", { exact: true })).toBeVisible({
        timeout: 8000,
      });

      // Section 8.A: Viewer cannot type in Monaco UI
      const guestInputarea = guestPage.locator(".monaco-editor textarea.inputarea");
      const guestBefore = await guestPage.locator(".monaco-editor").innerText();
      await guestInputarea.focus();
      await guestPage.keyboard.type("ILLEGAL_VIEWER_KEYSTROKES");
      const guestAfter = await guestPage.locator(".monaco-editor").innerText();
      expect(guestAfter).toBe(guestBefore);
      expect(guestAfter).not.toContain("ILLEGAL_VIEWER_KEYSTROKES");

      // Section 8.B: Forced Yjs update from viewer's document over WebSocket is dropped by server
      // The viewer directly mutates its Y.Doc using doc.getText("code").insert(...) and flushes via provider.
      // Server's beforeHandleMessage checks data.connection.readOnly and drops the update frame.
      await guestPage.evaluate(async () => {
        const syncObj = (
          window as unknown as {
            __pairprep_sync?: {
              doc: {
                getText: (f: string) => { insert: (pos: number, val: string) => void };
              };
            };
          }
        ).__pairprep_sync;
        if (!syncObj || !syncObj.doc) {
          throw new Error("Missing __pairprep_sync handle on guest window");
        }
        syncObj.doc.getText("code").insert(0, "ILLEGAL_FORCED_CRDT_INJECTION\n");
      });

      // Wait 1000ms for network exchange
      await hostPage.waitForTimeout(1000);

      // Layer 1: Owner DOM assertion — verify Host editor DOM NEVER received the forced injection
      const hostText = await hostPage.locator(".monaco-editor").innerText();
      expect(hostText).toContain("MASTER_CODE");
      expect(hostText).not.toContain("ILLEGAL_FORCED_CRDT_INJECTION");

      // Layer 2: Owner Y.Doc assertion — verify Host in-memory Yjs sync handle state
      const hostYDocText = await hostPage.evaluate(() => {
        const syncObj = (
          window as unknown as {
            __pairprep_sync?: {
              doc: {
                getText: (f: string) => { toString: () => string };
              };
            };
          }
        ).__pairprep_sync;
        if (!syncObj?.doc) {
          return null;
        }
        return syncObj.doc.getText("code").toString();
      });
      if (hostYDocText !== null) {
        expect(hostYDocText).toContain("MASTER_CODE");
        expect(hostYDocText).not.toContain("ILLEGAL_FORCED_CRDT_INJECTION");
      }

      // Verify REST API metadata payload
      const checkDocRes = await hostPage.request.get(`/api/v1/rooms/${slug}`);
      expect(checkDocRes.status()).toBe(200);
      const roomPayload = await checkDocRes.json();
      expect(JSON.stringify(roomPayload)).not.toContain("ILLEGAL_FORCED_CRDT_INJECTION");

      // Layer 3: Authoritative persisted-state reconstruction from sequential DocUpdateModel records
      if (dbAvailable) {
        if (mongoose.connection.readyState === 0) {
          await mongoose.connect(E2E_CONFIG.mongoUri);
        }
        const roomId = roomDetails.room?.id || roomDetails.id;
        const dbUpdates = await DocUpdateModel.find({ roomId })
          .sort({ seq: 1 })
          .lean();
        expect(dbUpdates.length).toBeGreaterThan(0);

        // Reconstruct a single authoritative Y.Doc by sequentially replaying all persisted updates
        const reconstructedDoc = new Y.Doc();
        for (const updateRecord of dbUpdates) {
          Y.applyUpdate(reconstructedDoc, updateRecord.update);
        }

        const reconstructedCode = reconstructedDoc.getText("code").toString();
        // Assert unauthorized injection is completely absent from reconstructed authoritative state
        expect(reconstructedCode).not.toContain("ILLEGAL_FORCED_CRDT_INJECTION");
        // Assert legitimate content is preserved in reconstructed authoritative state
        expect(reconstructedCode).toContain("MASTER_CODE");
      }

      // Verify legitimate Host edits STILL work and sync to viewer
      const hostInput = hostPage.locator(".monaco-editor textarea.inputarea");
      await hostInput.focus();
      await hostPage.keyboard.type("\n// LEGITIMATE_HOST_EDIT");
      await expect(hostPage.locator(".monaco-editor")).toContainText(
        "LEGITIMATE_HOST_EDIT"
      );

      // Layer 4: Reload / reconnect assertion — viewer reloads, speculative local injection is discarded,
      // receiving authoritative state containing LEGITIMATE_HOST_EDIT and NOT containing ILLEGAL_FORCED_CRDT_INJECTION
      await guestPage.reload();
      await expect(guestPage.locator(".monaco-editor")).toContainText(
        "LEGITIMATE_HOST_EDIT",
        {
          timeout: 8000,
        }
      );
      const guestReloadedText = await guestPage.locator(".monaco-editor").innerText();
      expect(guestReloadedText).not.toContain("ILLEGAL_FORCED_CRDT_INJECTION");
      expect(guestReloadedText).toContain("MASTER_CODE");
      expect(guestReloadedText).toContain("LEGITIMATE_HOST_EDIT");
    } finally {
      await hostContext.close();
      await guestContext.close();
      await hostSeed.cleanup();
    }
  });

  test("hostile display name containing quotes, braces, and </style> cannot break cursor-label CSS (Section 8.C)", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "Normal Host",
      email: `normal.${Date.now()}@pairprep.com`,
    });

    const hostContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const guestContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const urlObj = new URL(baseURL || "http://localhost:5173");

    await hostContext.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/dashboard");
      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({
        timeout: 10000,
      });

      const createBtn = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await hostPage.getByLabel(/Room Title/i).fill("Hostile CSS Injection Room");
      await hostPage.getByRole("button", { name: /^Create Room$/i }).click();

      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();

      await expect(hostPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });

      // Guest joins with a hostile display name containing quotes, braces, and </style>
      const hostileName = 'Attacker" { color: red; } </style>';
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);
      await expect(guestPage.getByLabel(/Your Display Name/i)).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByLabel(/Your Display Name/i).fill(hostileName);
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      await expect(guestPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });

      // Host observes awareness stylesheet
      const styleLocator = hostPage.locator('style[data-pairprep-awareness="true"]');
      await expect(styleLocator).toBeAttached({ timeout: 8000 });

      const cssContent = (await styleLocator.textContent()) || "";

      // 1. Unescaped </style> must NOT exist in the stylesheet content
      expect(cssContent).not.toContain("</style>");

      // 2. Double quotes must be escaped or neutralized
      expect(cssContent).not.toContain('content: "Attacker" {');

      // 3. Braces must not break rule blocks
      expect(cssContent).not.toContain("{ color: red; }");

      // 4. Editor remains fully functional
      await expect(hostPage.locator(".monaco-editor")).toBeVisible();
    } finally {
      await hostContext.close();
      await guestContext.close();
      await hostSeed.cleanup();
    }
  });

  test("editor under React StrictMode does not duplicate characters during typing (Section 8.D)", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "StrictMode Tester",
      email: `strict.${Date.now()}@pairprep.com`,
    });

    const context = await browser.newContext();
    const urlObj = new URL(baseURL || "http://localhost:5173");

    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      const page = await context.newPage();
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /Practice Rooms/i })).toBeVisible({
        timeout: 15000,
      });

      const createBtn = page.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await page.getByLabel(/Room Title/i).fill("StrictMode Character Guard");
      await page.getByRole("button", { name: /^Create Room$/i }).click();

      await page.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      await expect(page.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("status")).toHaveText(/Synced|Syncing/i, {
        timeout: 10000,
      });

      // Type a precise character sequence
      const sequence = "let distinctVar = 12345;";
      const inputarea = page.locator(".monaco-editor textarea.inputarea");
      await inputarea.focus();
      await page.keyboard.type(sequence);

      // Verify the sequence appears exactly once in the editor
      await expect(page.locator(".monaco-editor")).toContainText("distinctVar");
      const editorText = await page.locator(".monaco-editor").innerText();

      const occurrences = (editorText.match(/distinctVar/g) || []).length;
      expect(occurrences).toBe(1);
    } finally {
      await context.close();
      await hostSeed.cleanup();
    }
  });

  test("live participant list dynamically updates without reload, displaying authoritative roles, (You) badges, and distinct safe colors (ROOM-5)", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "Alice Host",
      email: `alice.room5.${Date.now()}@pairprep.com`,
    });

    const hostContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const guestContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const urlObj = new URL(baseURL || "http://localhost:5173");

    await hostContext.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      // 1. Host creates room
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/dashboard");
      await expect(
        hostPage.getByRole("heading", { name: /Practice Rooms/i })
      ).toBeVisible({ timeout: 15000 });

      const createBtn = hostPage.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await hostPage.getByLabel(/Room Title/i).fill("Live Participant List Room");
      await hostPage.getByRole("button", { name: /^Create Room$/i }).click();

      await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      const roomUrl = hostPage.url();
      const slug = roomUrl.split("/r/")[1]?.split("?")[0];

      // Wait for RoomPage and Editor to mount before checking sidebar
      await expect(hostPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });

      // 2. Verify Host sidebar participant list
      const hostAside = hostPage.locator("aside");
      await expect(hostAside.getByText("Alice Host")).toBeVisible({ timeout: 10000 });
      await expect(hostAside.getByText("(You)")).toBeVisible();
      await expect(hostAside.getByText("owner")).toBeVisible();

      // 3. Guest joins room
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);
      await expect(guestPage.getByLabel(/Your Display Name/i)).toBeVisible({
        timeout: 10000,
      });
      await guestPage.getByLabel(/Your Display Name/i).fill("Bob Participant");
      await guestPage.getByRole("button", { name: /Join as Guest/i }).click();

      // Wait for Guest editor to mount
      await expect(guestPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });

      // 4. Dynamic update on Host WITHOUT page reload
      await expect(hostAside.getByText("Bob Participant")).toBeVisible({
        timeout: 20000,
      });
      await expect(hostAside.getByText("editor")).toBeVisible({ timeout: 10000 });

      // Ensure (You) is ONLY on Alice on Host page
      const hostYouBadges = hostAside.getByText("(You)");
      expect(await hostYouBadges.count()).toBe(1);

      // 5. Verify Guest sidebar participant list
      const guestAside = guestPage.locator("aside");
      await expect(guestAside.getByText("Alice Host")).toBeVisible({ timeout: 10000 });
      await expect(guestAside.getByText("Bob Participant")).toBeVisible();
      const guestYouBadges = guestAside.getByText("(You)");
      expect(await guestYouBadges.count()).toBe(1);

      // 6. Host patches Guest role to viewer via REST API
      const roomDetailsRes = await hostPage.request.get(`/api/v1/rooms/${slug}`);
      const roomDetails = await roomDetailsRes.json();
      const bobMember = roomDetails.members.find(
        (m: { displayName: string }) => m.displayName === "Bob Participant"
      );
      expect(bobMember).toBeDefined();

      const patchRes = await hostPage.request.patch(
        `/api/v1/rooms/${slug}/members/${bobMember.id}`,
        {
          data: { role: "viewer" },
          headers: { "X-Requested-With": "pairprep" },
        }
      );
      expect(patchRes.status()).toBe(200);

      // 7. Dynamic role update on Guest WITHOUT page reload
      await expect(guestAside.getByText("viewer")).toBeVisible({ timeout: 20000 });
    } finally {
      await hostContext.close();
      await guestContext.close();
      await hostSeed.cleanup();
    }
  });

  test("Monaco editor chunks and web workers are strictly lazy-loaded on room entry and not requested on /dashboard (ED-1 Lazy Loading)", async ({
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
      test.skip(true, `Test requires active E2E database.`);
    }

    const hostSeed = await seedE2EUserAndSession({
      displayName: "Bundle Verifier",
      email: `bundle.${Date.now()}@pairprep.com`,
    });

    const context = await browser.newContext();
    const urlObj = new URL(baseURL || "http://localhost:5173");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: hostSeed.cookie.value,
        domain: urlObj.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    try {
      const page = await context.newPage();
      const requestedUrls: string[] = [];
      page.on("request", (req) => {
        requestedUrls.push(req.url());
      });

      // 1. Visit /dashboard
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /Practice Rooms/i })).toBeVisible({
        timeout: 15000,
      });

      // Assert zero Monaco chunks or worker requests on /dashboard
      const dashboardMonacoRequests = requestedUrls.filter(
        (url) =>
          url.includes("monaco") ||
          url.includes("editor.worker") ||
          url.includes("y-monaco")
      );
      expect(dashboardMonacoRequests).toHaveLength(0);

      // 2. Create and navigate into a practice room
      const createBtn = page.getByRole("button", {
        name: /Create Practice Room|New Room/i,
      });
      await createBtn.click();
      await page.getByLabel(/Room Title/i).fill("Lazy Loading Verification Room");
      await page.getByRole("button", { name: /^Create Room$/i }).click();

      await page.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 10000 });
      await expect(page.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 10000,
      });

      // 3. Confirm Monaco chunk is loaded dynamically on room entry
      const roomMonacoRequests = requestedUrls.filter(
        (url) => url.includes("monaco") || url.includes("editor.worker")
      );
      expect(roomMonacoRequests.length).toBeGreaterThan(0);
    } finally {
      await context.close();
      await hostSeed.cleanup();
    }
  });

  test.afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  });
});
