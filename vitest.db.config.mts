import { defineConfig } from "vitest/config";

// SQL tests run the real migration inside PGlite (WASM Postgres).
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
