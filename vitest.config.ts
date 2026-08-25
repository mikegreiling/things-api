import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests only run when explicitly enabled (VM lab or opted-in host).
    exclude: process.env["THINGS_LIVE"] ? [] : ["test/live/**"],
    // Render tests assert the plain-text skeleton; NO_COLOR beats any
    // FORCE_COLOR the invoking environment exports (src/cli/style.ts).
    // THINGS_API_HELPERS=false: the suite runs DIRECT regardless of the host's
    // stored `helpers-enabled` — otherwise a machine with live helpers routes
    // test file reads into the production reader, which refuses paths outside
    // its granted folder (observed 2026-08-22 when the maintainer enabled
    // routing). Suites that exercise routing set the env themselves.
    env: {
      NO_COLOR: "1",
      THINGS_API_HELPERS: "false",
      // Blast shield: without this, any suite exercising helpers
      // install/uninstall/reset mutates the DEVELOPER MACHINE's real
      // ~/Library/LaunchAgents (it deleted the live helpers' plists
      // mid-check twice, 2026-08-24). Suites that assert plist contents set
      // their own per-test dir on top of this shared throwaway.
      THINGS_API_LAUNCH_AGENTS_DIR: "/tmp/things-api-test-launch-agents",
    },
  },
});
