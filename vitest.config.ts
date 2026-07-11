import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests only run when explicitly enabled (VM lab or opted-in host).
    exclude: process.env["THINGS_LIVE"] ? [] : ["test/live/**"],
    // Render tests assert the plain-text skeleton; NO_COLOR beats any
    // FORCE_COLOR the invoking environment exports (src/cli/style.ts).
    env: { NO_COLOR: "1" },
  },
});
