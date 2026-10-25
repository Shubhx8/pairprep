import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test_session_secret_at_least_32_characters_long",
      MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep_test",
    },
    fileParallelism: false,
  },
});
