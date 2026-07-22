/**
 * The passive skill-drift notice (docs/design/skill-distribution.md § ratchet).
 *
 * When the installed agent skill is a MINOR version or more behind the RUNNING
 * BINARY's version (`CLI_VERSION` — the version this binary would stamp into a
 * fresh install, `-dev` in a source checkout), print ONE stderr line pointing at
 * `things install-skill`. It rides output the agent was already reading (the
 * skill's init step is `run things --help`), so it costs the agent no reasoning
 * and no extra turn. The binary version is the source of truth, NOT the bundled
 * `SKILL.md` frontmatter (which stays `0.0.0-dev` in a dev checkout) — otherwise
 * a dev binary could never notice drift and a dev-installed copy could never be
 * caught. `-dev` suffixes are stripped for the comparison (via `parseSemver`), so
 * a dev binary does not nag when the installed version matches.
 *
 * Constraints (all enforced here):
 *  - HUMAN paths only — never when `--json` is present, never the `mcp` server.
 *  - Fast: one existence check + a small read of the FIRST skill location found,
 *    canonical `~/.agents` before agent-specific dirs. Cached per process.
 *  - Silent on ANY error or absence — a drift nudge must never break a command.
 *  - Kill switch: `THINGS_API_NO_SKILL_CHECK=1`.
 */
import {
  installedSkillVersion,
  isLegacyDevStamp,
  isMinorBehind,
  resolveHome,
  skillLocations,
} from "./skill.ts";
import { CLI_VERSION } from "./version.ts";

/** Per-process guard: the check runs at most once. */
let alreadyChecked = false;

/** Reset the once-guard (tests only). */
export function resetSkillDriftCheck(): void {
  alreadyChecked = false;
}

/**
 * Compute the drift note, or null when there is nothing to say. Pure: given the
 * running binary's version and a home, it scans the well-known skill locations
 * (canonical FIRST — agent dirs may symlink to it) and returns the note for the
 * first installed copy that needs attention. `stat`/`read` follow symlinks, so a
 * symlinked agent dir resolves transparently.
 *
 * A pre-ratchet placeholder stamp (`0.0.0-dev`, copied verbatim by install-skill
 * before this fix) is treated as legacy/unstamped — a plain "refresh" nudge,
 * NOT run through the minor-behind math (which would read it as ~11 versions
 * behind). Otherwise the note fires only when the installed copy is a minor
 * version or more behind the binary.
 */
export function computeSkillDriftNote(binaryVersion: string | null, home: string): string | null {
  for (const loc of skillLocations(home)) {
    const installed = installedSkillVersion(loc.dir);
    if (installed === null) continue; // nothing installed here — try the next
    if (isLegacyDevStamp(installed)) {
      return (
        `note: installed agent skill has an unstamped/legacy version (v${installed}) — ` +
        "run 'things install-skill' to refresh"
      );
    }
    if (isMinorBehind(installed, binaryVersion)) {
      return (
        `note: installed agent skill v${installed} predates bundled v${binaryVersion} — ` +
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
  binaryVersion?: string | null;
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
    const binary = opts.binaryVersion !== undefined ? opts.binaryVersion : CLI_VERSION;
    const home = opts.home ?? resolveHome(env);
    const note = computeSkillDriftNote(binary, home);
    if (note !== null) {
      const write = opts.write ?? ((s: string) => void process.stderr.write(s));
      write(`${note}\n`);
    }
  } catch {
    // A drift nudge must never break a command — swallow everything.
  }
}
