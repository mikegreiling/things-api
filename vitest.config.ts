import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests only run when explicitly enabled (VM lab or opted-in host).
    exclude: process.env["THINGS_LIVE"] ? [] : ["test/live/**"],
  },
});
