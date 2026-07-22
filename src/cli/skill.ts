/**
 * Shared helpers for the bundled agent skill (`skills/things-cli/`): where the
 * package copy lives, where an installed copy lands, and how to read the
 * version stamp both carry. Used by `things install-skill` (distribution) and
 * the passive CLI drift notice.
 *
 * Pure CLI-surface support — node builtins only, no library internals — so it
 * respects the consumer air gap (AGENTS.md, docs/design/architecture.md).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

/** The skill's canonical name — its directory basename in every install root. */
export const SKILL_NAME = "things-cli";

/**
 * The bundled skill directory inside THIS package. Resolved from the module's
 * own location (three levels above src/cli/ AND dist/cli/), so it works under
 * every package-manager layout — npm, pnpm, bun, npx — with no PATH heuristics.
 */
export function bundledSkillDir(): string {
  return fileURLToPath(new URL(`../../skills/${SKILL_NAME}`, import.meta.url));
}

/** The home directory to resolve `~/.agents` etc. against (env override wins). */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env["HOME"];
  return h !== undefined && h !== "" ? h : homedir();
}

/** One install location: a human label and the skill directory under it. */
export interface SkillLocation {
  /** Short label for reports (e.g. "canonical (~/.agents)"). */
  label: string;
  /** Absolute path to the skill directory (…/skills/things-cli). */
  dir: string;
  /** True for the canonical `~/.agents` root the drift check stats FIRST. */
  canonical: boolean;
}

/**
 * The well-known install locations we can place and read without the `skills`
 * CLI's harness detection. The canonical `~/.agents` root comes first — agent
 * dirs may be symlinks to it, and it is where the drift check looks before the
 * agent-specific fallbacks.
 */
export function skillLocations(home: string): SkillLocation[] {
  return [
    {
      label: "canonical (~/.agents)",
      dir: join(home, ".agents", "skills", SKILL_NAME),
      canonical: true,
    },
    {
      label: "Claude (~/.claude)",
      dir: join(home, ".claude", "skills", SKILL_NAME),
      canonical: false,
    },
  ];
}

/**
 * Parse the `version:` stamp from a SKILL.md's YAML frontmatter. Returns the
 * trimmed value, or null when there is no frontmatter or no version key.
 * Deliberately tiny (no YAML dependency): the frontmatter is a flat key list.
 */
export function parseSkillVersion(md: string): string | null {
  if (!md.startsWith("---")) return null;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return null;
  const front = md.slice(0, end);
  for (const line of front.split("\n")) {
    const m = /^version:\s*(.+?)\s*$/.exec(line);
    if (m && m[1] !== undefined) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Rewrite the `version:` line in a SKILL.md's frontmatter to `version`. Pure
 * string transform used by the publish-time stamp (scripts/stamp-skill.mjs).
 * Throws when there is no frontmatter or no `version:` key — the source file is
 * expected to carry the `0.0.0-dev` slot.
 */
export function stampSkillVersion(md: string, version: string): string {
  const end = md.indexOf("\n---", 3);
  if (!md.startsWith("---") || end === -1) throw new Error("SKILL.md has no frontmatter");
  const front = md.slice(0, end);
  const rest = md.slice(end);
  if (!/^version:\s*.+$/m.test(front))
    throw new Error("SKILL.md frontmatter has no 'version:' key");
  return front.replace(/^version:\s*.+$/m, `version: ${version}`) + rest;
}

/** Read the version stamp from a SKILL.md file, or null if absent/unreadable. */
export function readSkillVersion(skillMdPath: string): string | null {
  try {
    return parseSkillVersion(readFileSync(skillMdPath, "utf8"));
  } catch {
    return null;
  }
}

/** The bundled SKILL.md's version stamp (what a fresh install would carry). */
export function bundledSkillVersion(): string | null {
  return readSkillVersion(join(bundledSkillDir(), "SKILL.md"));
}

/** The stamp of the installed skill at `dir`, or null when nothing is there. */
export function installedSkillVersion(dir: string): string | null {
  const md = join(dir, "SKILL.md");
  if (!existsSync(md)) return null;
  return readSkillVersion(md);
}

/** A parsed `major.minor.patch`, ignoring any `-dev`/prerelease suffix. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `X.Y.Z` (suffix tolerated), or null when it is not a `X.Y.Z` stamp. */
export function parseSemver(v: string | null): Semver | null {
  if (v === null) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 / 0 / +1 for a<b / a==b / a>b; null when either is not a `X.Y.Z` stamp. */
export function compareSemver(a: string | null, b: string | null): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * True when `installed` is a MINOR version or more behind `bundled` — i.e. their
 * `(major, minor)` differs and bundled is the newer pair. Patch-only drift is
 * NOT behind (too small to nudge). False when either is not a `X.Y.Z` stamp, so
 * a dev build (`0.0.0-dev` → 0.0.0) never flags anything as behind.
 */
export function isMinorBehind(installed: string | null, bundled: string | null): boolean {
  const pi = parseSemver(installed);
  const pb = parseSemver(bundled);
  if (pi === null || pb === null) return false;
  if (pb.major !== pi.major) return pb.major > pi.major;
  return pb.minor > pi.minor;
}
