import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["apps/server/**/*.test.ts", "packages/shared/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.git/**",
            "test/e2e/**",
            "**/*.spec.ts",
          ],
          env: {
            NODE_ENV: "test",
            SESSION_SECRET: "test_session_secret_at_least_32_characters_long",
            MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep_test",
            AUTH_RATE_LIMIT_WINDOW_MS: "60000",
            AUTH_RATE_LIMIT_MAX: "1000",
          },
        },
        extends: true,
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          setupFiles: ["apps/web/src/test/setup.ts"],
          include: ["apps/web/**/*.test.ts", "apps/web/**/*.test.tsx"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.git/**",
            "test/e2e/**",
            "**/*.spec.ts",
          ],
        },
        extends: true,
      },
      {
        test: {
          name: "e2e-support",
          environment: "node",
          include: ["test/e2e/support/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.spec.ts"],
        },
        extends: true,
      },
    ],
  },
});
