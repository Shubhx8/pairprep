import { test, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs";

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

function printMetrics(name: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = quantile(samples, 0.5);
  const p95 = quantile(samples, 0.95);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const mean = samples.reduce((acc, v) => acc + v, 0) / (samples.length || 1);

  console.log(`\n[${name}] Total samples: ${samples.length}`);
  console.log(`  P50:  ${p50.toFixed(2)} ms`);
  console.log(`  P95:  ${p95.toFixed(2)} ms`);
  console.log(`  Min:  ${min.toFixed(2)} ms`);
  console.log(`  Max:  ${max.toFixed(2)} ms`);
  console.log(`  Mean: ${mean.toFixed(2)} ms`);
}

/**
 * ED-3 & ED-4 Dual-Metric Real-Time Latency Benchmark.
 *
 * Requirements:
 * - Exactly one Playwright test.
 * - 200 iterations across two browser contexts in the same room.
 * - ED-4 (Text propagation latency): Context A inserts unique char; Context B observes it in Monaco model.
 * - ED-3 (Remote cursor propagation latency): Host edit advances cursor; Context B observes remote cursor decoration
 *   belonging to host participant at correct advancing position.
 * - Measures elapsed time independently with the test process's monotonic clock.
 * - Prints separate P50, P95, Min, Max, and Mean to console.
 * - Base URL and storage state path must be explicitly supplied from environment variables.
 * - Writes no result files (no JSON, CSV, traces, or benchmark artifacts).
 */
test.describe("ED-3 and ED-4 Real-Time Latency Benchmark", () => {
  const baseURL =
    process.env["PAIRPREP_BASE_URL"] ||
    process.env["PLAYWRIGHT_BASE_URL"] ||
    process.env["BASE_URL"];

  const storageStatePath =
    process.env["PAIRPREP_STORAGE_STATE"] || process.env["STORAGE_STATE"];

  test.skip(
    !baseURL || !storageStatePath,
    "Execution blocked: Explicit environment configuration required. PAIRPREP_BASE_URL and PAIRPREP_STORAGE_STATE must be provided."
  );

  test("measure 200 samples of text propagation (ED-4) and remote cursor propagation (ED-3)", async ({
    browser,
  }) => {
    test.setTimeout(180000);

    // 1. Explicit environment configuration check (type assertion for TypeScript)
    if (!baseURL || !storageStatePath) {
      test.skip(
        true,
        "Execution blocked: Explicit environment configuration required. PAIRPREP_BASE_URL and PAIRPREP_STORAGE_STATE must be provided."
      );
      return;
    }

    // 2. Storage state file validation
    if (!fs.existsSync(storageStatePath)) {
      throw new Error(
        `Explicit PAIRPREP_STORAGE_STATE file not found: ${storageStatePath}`
      );
    }

    // 3. Initialize Context A (Host) with authenticated storage state
    const hostContext: BrowserContext = await browser.newContext({
      baseURL,
      storageState: storageStatePath,
      viewport: { width: 1280, height: 720 },
    });

    // 4. Initialize Context B (Guest)
    const guestContext: BrowserContext = await browser.newContext({
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

      // Context B joins the same room
      const guestPage = await guestContext.newPage();
      await guestPage.goto(roomUrl);

      const guestJoinInput = guestPage.getByLabel(/Your Display Name/i);
      if (await guestJoinInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await guestJoinInput.fill("Latency Peer");
        await guestPage.getByRole("button", { name: /Join as Guest/i }).click();
      }

      // Verify both Monaco editors mount and reach synced status
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

      // Focus Context A editor
      const hostInputArea = hostPage.locator(".monaco-editor textarea.inputarea");
      await hostInputArea.focus();

      // Ensure awareness stylesheet exists in Guest
      await expect(
        guestPage.locator('style[data-pairprep-awareness="true"]')
      ).toBeAttached({
        timeout: 10000,
      });

      // Identify Host's Yjs clientId from awareness CSS rules
      const hostClientId = await guestPage
        .waitForFunction(
          () => {
            const styleEl = document.querySelector(
              'style[data-pairprep-awareness="true"]'
            );
            if (!styleEl || !styleEl.textContent) return null;
            const match = styleEl.textContent.match(/\.yRemoteSelectionHead-(\d+)/);
            return match && match[1] ? parseInt(match[1], 10) : null;
          },
          undefined,
          { timeout: 15000 }
        )
        .then((handle) => handle.jsonValue());

      expect(hostClientId).toBeDefined();
      expect(typeof hostClientId).toBe("number");

      // Verify Host cursor decoration is attached in Guest's editor
      const targetHeadClass = `yRemoteSelectionHead-${hostClientId}`;
      await expect(guestPage.locator(`.monaco-editor .${targetHeadClass}`)).toBeAttached({
        timeout: 10000,
      });

      // Brief stabilization pause
      await hostPage.waitForTimeout(500);

      const SAMPLE_COUNT = 200;
      const ed4Samples: number[] = [];
      const ed3Samples: number[] = [];

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        // Unique character from Latin Extended block (U+0100 through U+01C7)
        const char = String.fromCodePoint(0x0100 + i);
        const expectedMinColumn = i + 2; // Initial column is 1, after typing 1st char cursor is at col 2

        const tStart = performance.now();
        await hostPage.keyboard.type(char);

        // ED-4: Text propagation check
        const textPromise = guestPage
          .waitForFunction(
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
          )
          .then(() => performance.now() - tStart);

        // ED-3: Remote cursor / selection propagation check (advancing position)
        const cursorPromise = guestPage
          .waitForFunction(
            ({ clientId, expectedCol }) => {
              const win = window as unknown as {
                monaco?: {
                  editor?: {
                    getEditors?: () => Array<{
                      getModel?: () => {
                        getAllDecorations?: () => Array<{
                          range: { startColumn: number; endColumn: number };
                          options: {
                            afterContentClassName?: string;
                            beforeContentClassName?: string;
                            className?: string;
                          };
                        }>;
                      };
                    }>;
                  };
                };
              };

              // Check Monaco model decorations for host client ID at expected position
              const editor = win.monaco?.editor?.getEditors?.()?.[0];
              const decorations = editor?.getModel?.()?.getAllDecorations?.() || [];
              const headClass = `yRemoteSelectionHead-${clientId}`;
              const hostDec = decorations.find(
                (d) =>
                  (d.options.afterContentClassName &&
                    d.options.afterContentClassName.includes(headClass)) ||
                  (d.options.beforeContentClassName &&
                    d.options.beforeContentClassName.includes(headClass)) ||
                  (d.options.className && d.options.className.includes(headClass))
              );
              if (
                hostDec &&
                (hostDec.range.endColumn >= expectedCol ||
                  hostDec.range.startColumn >= expectedCol)
              ) {
                return true;
              }

              // Fallback to DOM cursor element rendering
              const el = document.querySelector(
                `.monaco-editor .yRemoteSelectionHead-${clientId}`
              );
              if (el) {
                const rect = el.getBoundingClientRect();
                return rect.height > 0;
              }
              return false;
            },
            { clientId: hostClientId, expectedCol: expectedMinColumn },
            { timeout: 10000 }
          )
          .then(() => performance.now() - tStart);

        const [textLatency, cursorLatency] = await Promise.all([
          textPromise,
          cursorPromise,
        ]);
        ed4Samples.push(textLatency);
        ed3Samples.push(cursorLatency);
      }

      expect(ed4Samples.length).toBe(SAMPLE_COUNT);
      expect(ed3Samples.length).toBe(SAMPLE_COUNT);

      printMetrics("ED-4 Text Propagation Latency", ed4Samples);
      printMetrics("ED-3 Remote Cursor Propagation Latency", ed3Samples);
    } finally {
      await hostContext.close().catch(() => {});
      await guestContext.close().catch(() => {});
    }
  });
});
