import { test, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import {
  checkE2EDatabaseAvailable,
  seedE2EUserAndSession,
  SESSION_COOKIE_NAME,
} from "./support/sessionHarness.js";

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/**
 * ED-3 & ED-4 Dedicated Playwright End-to-End Latency Benchmark.
 *
 * Requirements:
 * - Two browser contexts in the same room.
 * - Context A types a unique character.
 * - The test process measures elapsed time until it appears in Context B (single clock only).
 * - 200 samples.
 * - Prints p50 and p95 to the console.
 * - Base URL and storage state path supplied from environment variables.
 * - Writes no result files to disk.
 */
test.describe("ED-3 and ED-4 Real-Time Latency Benchmark", () => {
  test("measure 200 remote update samples between two contexts with single test-process clock", async ({
    browser,
    baseURL: configBaseURL,
  }) => {
    test.setTimeout(120000);

    const baseURL =
      process.env["PAIRPREP_BASE_URL"] ||
      process.env["PLAYWRIGHT_BASE_URL"] ||
      configBaseURL ||
      "http://localhost:5174";

    const storageStatePath =
      process.env["PAIRPREP_STORAGE_STATE"] || process.env["STORAGE_STATE"];

    let hostContext: BrowserContext;

    if (storageStatePath) {
      if (!fs.existsSync(storageStatePath)) {
        throw new Error(
          `Configured PAIRPREP_STORAGE_STATE file not found: ${storageStatePath}`
        );
      }
      hostContext = await browser.newContext({
        baseURL,
        storageState: storageStatePath,
        viewport: { width: 1280, height: 720 },
      });
    } else {
      const dbAvailable = await checkE2EDatabaseAvailable();
      if (!dbAvailable) {
        test.skip(
          true,
          "ED-3/ED-4 latency test requires either PAIRPREP_STORAGE_STATE or an active test database."
        );
        return;
      }

      const seed = await seedE2EUserAndSession({
        displayName: "Latency Host",
        email: `latency.host.${Date.now()}@pairprep.com`,
      });

      hostContext = await browser.newContext({
        baseURL,
        viewport: { width: 1280, height: 720 },
      });

      const urlObj = new URL(baseURL);
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
    }

    const guestContext = await browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 720 },
    });

    try {
      let roomUrl = process.env["PAIRPREP_ROOM_URL"];
      const hostPage = await hostContext.newPage();

      if (!roomUrl) {
        await hostPage.goto(`${baseURL}/dashboard`);
        await expect(
          hostPage.getByRole("heading", { name: /Practice Rooms/i })
        ).toBeVisible({ timeout: 15000 });

        const createBtn = hostPage.getByRole("button", {
          name: /Create Practice Room|New Room/i,
        });
        await createBtn.click();
        await hostPage.getByLabel(/Room Title/i).fill("ED3 ED4 Latency Measurement");
        await hostPage.getByRole("button", { name: /^Create Room$/i }).click();
        await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 15000 });
        roomUrl = hostPage.url();
      } else {
        await hostPage.goto(roomUrl);
      }

      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);

      const guestJoinInput = guestPage.getByLabel(/Your Display Name/i);
      if (await guestJoinInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await guestJoinInput.fill("Latency Peer");
        await guestPage.getByRole("button", { name: /Join as Guest/i }).click();
      }

      await expect(hostPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 15000,
      });
      await expect(hostPage.locator(".monaco-editor")).toBeVisible({
        timeout: 15000,
      });
      await expect(hostPage.getByRole("status")).toHaveText(/Synced/i, {
        timeout: 15000,
      });

      await expect(guestPage.getByTestId("collaborative-editor")).toBeVisible({
        timeout: 15000,
      });
      await expect(guestPage.locator(".monaco-editor")).toBeVisible({
        timeout: 15000,
      });
      await expect(guestPage.getByRole("status")).toHaveText(/Synced/i, {
        timeout: 15000,
      });

      const hostInputArea = hostPage.locator(".monaco-editor textarea.inputarea");
      await hostInputArea.focus();

      await hostPage.waitForTimeout(500);

      const SAMPLE_COUNT = 200;
      const samples: number[] = [];

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const char = String.fromCodePoint(0x0100 + i);

        const tStart = performance.now();
        await hostPage.keyboard.type(char);

        await guestPage.waitForFunction(
          (expectedChar) => {
            const win = window as unknown as {
              monaco?: {
                editor?: {
                  getModels?: () => Array<{ getValue: () => string }>;
                };
              };
            };
            const model = win.monaco?.editor?.getModels?.()?.[0];
            if (model) {
              return model.getValue().includes(expectedChar);
            }
            const editorEl = document.querySelector(".monaco-editor");
            return Boolean(
              editorEl && (editorEl.textContent || "").includes(expectedChar)
            );
          },
          char,
          { timeout: 10000 }
        );

        const duration = performance.now() - tStart;
        samples.push(duration);
      }

      expect(samples.length).toBe(SAMPLE_COUNT);

      const p50 = quantile(samples, 0.5);
      const p95 = quantile(samples, 0.95);
      const min = Math.min(...samples);
      const max = Math.max(...samples);
      const mean = samples.reduce((acc, val) => acc + val, 0) / samples.length;

      console.log(`[ED-3/ED-4 Latency Benchmark] Total samples: ${samples.length}`);
      console.log(`p50: ${p50.toFixed(2)} ms`);
      console.log(`p95: ${p95.toFixed(2)} ms`);
      console.log(`min: ${min.toFixed(2)} ms`);
      console.log(`max: ${max.toFixed(2)} ms`);
      console.log(`mean: ${mean.toFixed(2)} ms`);
    } finally {
      await hostContext.close().catch(() => {});
      await guestContext.close().catch(() => {});
    }
  });
});
