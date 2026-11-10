import { defineConfig, devices } from "@playwright/test";

process.env["PAIRPREP_E2E"] = "1";

const E2E_PORT = process.env["PORT"] || "3001";
const E2E_WEB_PORT = "5174";
const E2E_BASE_URL =
  process.env["PLAYWRIGHT_BASE_URL"] || `http://localhost:${E2E_WEB_PORT}`;
const E2E_MONGODB_URI =
  process.env["E2E_MONGODB_URI"] ||
  process.env["MONGODB_URI"] ||
  "mongodb://127.0.0.1:27017/pairprep_e2e";
const E2E_SESSION_SECRET =
  process.env["E2E_SESSION_SECRET"] ||
  process.env["SESSION_SECRET"] ||
  "test_e2e_secret_at_least_32_chars_long_for_security";

process.env["E2E_MONGODB_URI"] = E2E_MONGODB_URI;
process.env["E2E_SESSION_SECRET"] = E2E_SESSION_SECRET;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npx tsx apps/server/src/index.ts",
      url: `http://localhost:${E2E_PORT}/healthz`,
      reuseExistingServer: !process.env["CI"],
      timeout: 120000,
      env: {
        PORT: E2E_PORT,
        CLIENT_ORIGIN: `http://localhost:${E2E_WEB_PORT}`,
        MONGODB_URI: E2E_MONGODB_URI,
        SESSION_SECRET: E2E_SESSION_SECRET,
        PAIRPREP_E2E: "1",
      },
    },
    {
      command: "npm run dev:web",
      url: `http://localhost:${E2E_WEB_PORT}`,
      reuseExistingServer: !process.env["CI"],
      timeout: 120000,
      env: {
        VITE_PORT: E2E_WEB_PORT,
        VITE_API_PROXY_TARGET: `http://localhost:${E2E_PORT}`,
        VITE_PAIRPREP_E2E: "1",
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env["CI"] ? undefined : "chrome",
      },
    },
  ],
});
