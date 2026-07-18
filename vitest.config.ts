import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
      "integration-tests/**/*.test.ts",
      "perf-tests/**/*.test.ts",
      "memory-tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
