import { defineConfig } from "vitest/config";

// Store and throttling tests are plain TypeScript (06 A.5), so they run in Node without a DOM.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
