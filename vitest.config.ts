import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Deletes each file's throwaway fixture databases once it finishes; without
    // it the suite abandoned every fixture (and its -wal/-shm siblings) in the
    // temp dir — ~250k files by the time it was noticed, 2026-08-24.
    setupFiles: ["test/setup/fixture-sweep.ts"],
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
      // The same shield, one layer lower: the state dir is where the deputy's
      // SOCKET and TOKEN live, so a suite that opts into routing
      // (THINGS_API_HELPERS=true, which several must) otherwise handshakes the
      // DEVELOPER MACHINE's live helper. That is not read-only — a version
      // line the worktree has bumped ahead of the installed bundle makes
      // `reconcileVersions` run `launchctl kickstart -k`, which BOUNCED the
      // maintainer's running deputy twice during a unit run (2026-09-03,
      // DEPOBS1: worktree expected 1.4.0, installed was 1.3.0). A throwaway
      // state dir makes routing-opt-in suites resolve to "not installed"
      // instead; the ones that want a deputy stand up their own.
      THINGS_API_STATE_DIR: "/tmp/things-api-test-state",
    },
  },
});
