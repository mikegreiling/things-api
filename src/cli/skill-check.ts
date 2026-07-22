/**
 * The passive skill-drift notice (docs/design/skill-distribution.md § ratchet).
 *
 * When the installed agent skill is a MINOR version or more behind the skill
 * this binary bundles, print ONE stderr line pointing at `things install-skill`.
 * It rides output the agent was already reading (the skill's init step is `run
 * things --help`), so it costs the agent no reasoning and no extra turn.
 *
 * Constraints (all enforced here):
 *  - HUMAN paths only — never when `--json` is present, never the `mcp` server.
 *  - Fast: one existence check + a small read of the FIRST skill location found,
 *    canonical `~/.agents` before agent-specific dirs. Cached per process.
 *  - Silent on ANY error or absence — a drift nudge must never break a command.
 *  - Kill switch: `THINGS_API_NO_SKILL_CHECK=1`.
 */
import {
  bundledSkillVersion,
  installedSkillVersion,
  isMinorBehind,
  resolveHome,
  skillLocations,
} from "./skill.ts";

/** Per-process guard: the check runs at most once. */
let alreadyChecked = false;

/** Reset the once-guard (tests only). */
export function resetSkillDriftCheck(): void {
  alreadyChecked = false;
}

/**
 * Compute the drift note, or null when there is nothing to say. Pure: given the
 * bundled stamp and a home, it scans the well-known skill locations (canonical
 * FIRST — agent dirs may symlink to it) and returns the note for the first
 * installed copy that is a minor-or-more behind the bundled one. `stat`/`read`
 * follow symlinks, so a symlinked agent dir resolves transparently.
 */
export function computeSkillDriftNote(bundledVersion: string | null, home: string): string | null {
  for (const loc of skillLocations(home)) {
    const installed = installedSkillVersion(loc.dir);
    if (installed === null) continue; // nothing installed here — try the next
    if (isMinorBehind(installed, bundledVersion)) {
      return (
        `note: installed agent skill v${installed} predates bundled v${bundledVersion} — ` +
        "run 'things install-skill' to update"
      );
    }
    // First location that HAS a skill decides — a present-but-current copy is
    // the answer (no note), we do not keep scanning for a stale sibling.
    return null;
  }
  return null;
}

/** True when this invocation is a human path eligible for the notice. */
function isHumanPath(argv: string[]): boolean {
  if (argv.includes("--json")) return false; // machine consumer — stay silent
  const first = argv.find((a) => !a.startsWith("-"));
  // The MCP server speaks its own protocol; install-skill is the fix itself.
  if (first === "mcp" || first === "install-skill") return false;
  return true;
}

/**
 * Emit the drift note to stderr when warranted. Side-effecting wrapper around
 * {@link computeSkillDriftNote} with all the gating; injectable for tests.
 */
export function maybeEmitSkillDriftNote(opts: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  bundledVersion?: string | null;
  home?: string;
  write?: (s: string) => void;
}): void {
  if (alreadyChecked) return;
  alreadyChecked = true;
  try {
    const env = opts.env ?? process.env;
    const kill = env["THINGS_API_NO_SKILL_CHECK"];
    if (kill !== undefined && kill !== "" && kill !== "0") return;
    if (!isHumanPath(opts.argv)) return;
    const bundled = opts.bundledVersion !== undefined ? opts.bundledVersion : bundledSkillVersion();
    const home = opts.home ?? resolveHome(env);
    const note = computeSkillDriftNote(bundled, home);
    if (note !== null) {
      const write = opts.write ?? ((s: string) => void process.stderr.write(s));
      write(`${note}\n`);
    }
  } catch {
    // A drift nudge must never break a command — swallow everything.
  }
}
