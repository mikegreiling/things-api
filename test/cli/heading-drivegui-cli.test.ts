/**
 * Regression: `project dissolve-heading` and `project move-heading-to-project`
 * were CLI-UNINVOKABLE — their registrations omitted the drive-gui decorator, so
 * passing `--dangerously-drive-gui` errored "unknown option" while omitting it
 * fail-closed on the drive acknowledgement (H-UI-DRIVE). Every path a dead end.
 *
 * These lock the CLI-level halves of the fix (the completeness lock over the
 * whole tree lives in help-contract.test.ts; the on-device GUI drive is
 * VM-certified separately and is NOT exercised here):
 *   (A) the flag PARSES and THREADS — with the flag present but the ui config
 *       disabled, the op advances PAST the ack gate to the config gate and lands
 *       `unsupported` (naming `ui-enabled`). Before the fix this errored "unknown
 *       option" at parse time, never reaching the pipeline.
 *   (B) the flag is LOAD-BEARING — with the ui config enabled but the flag
 *       absent, the op fail-closes on H-UI-DRIVE (the drive is never attempted),
 *       whose remediation names `--dangerously-drive-gui`.
 * Neither case drives the app: (A) stops at the config gate, (B) at the ack gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "THINGS_DB",
  "THINGS_API_STATE_DIR",
  "THINGS_API_CONFIG_DIR",
  "THINGS_API_UI_ENABLED",
];

beforeEach(() => {
  fixture = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-heading-drivegui-"));
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  // Default: ui config DISABLED (a fresh config dir). Case (B) opts in per-test.
  delete process.env["THINGS_API_UI_ENABLED"];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixture.close();
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

function envelope(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

/** A source project with two headings, plus a distinct destination project. */
function seedHeadingScenario(): { src: string; dest: string } {
  const src = seedProject(fixture.db, { title: "Source" });
  seedHeading(fixture.db, { title: "Phase 1", project: src });
  seedHeading(fixture.db, { title: "Phase 2", project: src });
  const dest = seedProject(fixture.db, { title: "Destination" });
  return { src, dest };
}

const scenarios: Array<{ name: string; argv: (s: { src: string; dest: string }) => string[] }> = [
  {
    name: "project dissolve-heading",
    argv: ({ src }) => ["project", "dissolve-heading", src, "Phase 1"],
  },
  {
    name: "project move-heading-to-project",
    argv: ({ src, dest }) => ["project", "move-heading-to-project", src, "Phase 1", "--to", dest],
  },
  // move-heading rode the private-reorder wire until CHORDMH1 moved it to the
  // chord ui vector; lab:regress caught the e2e still asserting the OLD refusal
  // three releases later (the 0.20.0 retro gate run). This row is the CI-visible
  // tripwire under the same ack/config gate law its siblings already lock — a
  // genuine move (Phase 2 → first), so no earlier no-op path can short-circuit.
  {
    name: "project move-heading",
    argv: ({ src }) => ["project", "move-heading", src, "Phase 2", "--first"],
  },
];

describe("heading GUI ops: --dangerously-drive-gui parses and threads (was uninvokable)", () => {
  for (const { name, argv } of scenarios) {
    it(`${name}: flag threads past the ack gate → unsupported names ui-enabled (config disabled)`, async () => {
      const scn = seedHeadingScenario();
      await run([...argv(scn), "--dangerously-drive-gui", "--json"]);
      // Reached the pipeline (no "unknown option" parse error) and threaded the
      // ack: the only remaining gate is the disabled ui config.
      expect(stderr.join("")).not.toContain("unknown option");
      const env = envelope();
      expect(env["ok"]).toBe(false);
      const err = env["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("unsupported");
      const considered = (err["detail"] as { considered: Array<{ why: string }> }).considered;
      expect(considered.map((c) => c.why).join(" ")).toContain("ui-enabled");
      expect(process.exitCode).toBe(6);
    });

    it(`${name}: flag is load-bearing → H-UI-DRIVE when absent (config enabled, no drive)`, async () => {
      process.env["THINGS_API_UI_ENABLED"] = "true";
      const scn = seedHeadingScenario();
      await run([...argv(scn), "--json"]);
      const env = envelope();
      expect(env["ok"]).toBe(false);
      const err = env["error"] as Record<string, unknown>;
      expect(String(err["code"])).toContain("H-UI-DRIVE");
      expect(String(err["remediation"])).toContain("--dangerously-drive-gui");
      expect(process.exitCode).toBe(4);
    });
  }
});
