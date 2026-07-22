/**
 * `things install-skill` — place the bundled agent skill (`skills/things-cli/`)
 * where coding agents discover it. Prefers the `skills` CLI (vercel-labs), which
 * detects every installed agent harness and keeps one canonical copy under
 * `~/.agents/skills/`; falls back to a plain copy into the two roots we can place
 * without detection (`~/.agents` and `~/.claude`) when that tool or the network
 * is unavailable. Re-running it IS the update: the skill directory is replaced
 * wholesale, so a stale copy is cleanly overwritten.
 *
 * Source of truth for the "current" skill version is the RUNNING BINARY's
 * version (`CLI_VERSION` — `-dev` in a source checkout), NOT the frontmatter of
 * the bundled `SKILL.md`. The repo copy deliberately stays `0.0.0-dev` (stamped
 * only at publish, to keep dev builds git-quiet), so comparing or copying that
 * placeholder is meaningless in a dev checkout. Instead we stamp a temp copy of
 * the skill with the binary's version at install time and hand THAT to the
 * installer, and `--check` compares installed stamps against the binary version.
 * The repo's `SKILL.md` is never modified. (In a published install the two
 * agree — the tarball is pre-stamped to the same version the binary reports —
 * so the outcome is identical to before.)
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";

import { ExitCode, okEnvelope, simFenceActive, type EnvelopeMeta } from "../../index.ts";
import {
  bundledSkillDir,
  compareSemver,
  installedSkillVersion,
  isLegacyDevStamp,
  resolveHome,
  SKILL_NAME,
  skillLocations,
  stampSkillVersion,
} from "../skill.ts";
import { CLI_VERSION } from "../version.ts";

/** How the skill was placed (or would have been). */
type InstallPath = "skills-cli" | "builtin-copy" | "simulated" | "check";

/** Per-location report row. */
interface LocationReport {
  label: string;
  dir: string;
  installedVersion: string | null;
  /** up-to-date | behind | differs | legacy | absent (check); written (install copy). */
  status: "up-to-date" | "behind" | "differs" | "legacy" | "absent" | "written";
}

interface InstallSkillData {
  mode: "install" | "check";
  path: InstallPath;
  global: boolean;
  /** The running binary's version — the source of truth we stamp and check against. */
  binaryVersion: string;
  locations: LocationReport[];
  detail: string;
}

/** Injectable side effects, so the integration test never touches the network. */
export interface InstallSkillDeps {
  home: string;
  /** The running binary's version (`CLI_VERSION`); stamped into copies and checked against. */
  binaryVersion: string;
  /** True to simulate without touching HOME (bench fence). */
  simulated: boolean;
  /** Run `skills add`; returns true on success, false when unavailable/failed. */
  runSkillsCli: (skillDir: string, global: boolean) => boolean;
  /** Plain-copy an already-stamped skill dir into a destination (clean overwrite). */
  copyInto: (skillDir: string, destDir: string) => void;
}

/**
 * Materialize a stamped copy of the bundled skill in a temp dir and run `fn`
 * against it, cleaning up afterwards. The copy's `SKILL.md` frontmatter is
 * rewritten to `version`, so EVERY location the installer subsequently
 * materializes — the canonical root, `~/.claude`, and any other agent dir the
 * `skills` CLI detects that we do not enumerate — inherits the stamp. Stamping
 * at the source (rather than re-stamping the two locations we know) is why the
 * shell-out path stays correct. The temp dir keeps the skill's canonical
 * basename (`things-cli`) so `skills add <dir>` registers it under the right id.
 * The repo's own `SKILL.md` is never touched — we only ever write to the copy.
 */
export function withStampedSkillDir<T>(srcDir: string, version: string, fn: (dir: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "things-api-skill-stamp-"));
  try {
    const staged = join(tmp, SKILL_NAME);
    cpSync(srcDir, staged, { recursive: true });
    const mdPath = join(staged, "SKILL.md");
    writeFileSync(mdPath, stampSkillVersion(readFileSync(mdPath, "utf8"), version));
    return fn(staged);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Default `skills` shell-out: `npx -y skills add <dir> [-g] -y`, offline-safe. */
function defaultRunSkillsCli(skillDir: string, global: boolean): boolean {
  const args = ["-y", "skills", "add", skillDir, ...(global ? ["-g"] : []), "-y"];
  try {
    execFileSync("npx", args, { stdio: ["ignore", "ignore", "ignore"], timeout: 180000 });
    return true;
  } catch {
    // npx missing, network dead, or the tool errored — fall back to a plain copy.
    return false;
  }
}

/** Default plain copy: replace the destination directory wholesale. */
export function defaultCopyInto(skillDir: string, destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  cpSync(skillDir, destDir, { recursive: true });
}

function meta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

/**
 * Classify an installed stamp against the RUNNING BINARY's version for `--check`.
 * A pre-ratchet placeholder (`0.0.0-dev`) reads as `legacy` — an install-skill
 * refresh, not a "hundreds of versions behind" scare. `compareSemver` ignores
 * any `-dev` suffix, so a dev binary vs a same-version stamp reads up-to-date.
 */
function checkStatus(installed: string | null, binary: string): LocationReport["status"] {
  if (installed === null) return "absent";
  if (isLegacyDevStamp(installed)) return "legacy";
  if (installed === binary) return "up-to-date";
  const cmp = compareSemver(installed, binary);
  if (cmp !== null && cmp < 0) return "behind";
  return cmp === 0 ? "up-to-date" : "differs";
}

/**
 * The command core, side effects injected. Returns the structured result and the
 * exit code; the caller renders it (human or --json).
 */
export function installSkill(
  opts: { check?: boolean; project?: boolean },
  deps: InstallSkillDeps,
): { data: InstallSkillData; exitCode: ExitCode } {
  const global = opts.project !== true;
  const skillDir = bundledSkillDir();
  const binaryVersion = deps.binaryVersion;
  const locations = skillLocations(deps.home);

  if (!existsSync(skillDir)) {
    return {
      exitCode: ExitCode.Environment,
      data: {
        mode: opts.check === true ? "check" : "install",
        path: "check",
        global,
        binaryVersion,
        locations: [],
        detail: `bundled skill directory not found: ${skillDir}`,
      },
    };
  }

  // --check: read stamps, compare against the running binary, never write.
  if (opts.check === true) {
    const rows: LocationReport[] = locations.map((loc) => {
      const installed = installedSkillVersion(loc.dir);
      return {
        label: loc.label,
        dir: loc.dir,
        installedVersion: installed,
        status: checkStatus(installed, binaryVersion),
      };
    });
    const canonical = rows.find((_, i) => locations[i]?.canonical === true) ?? rows[0];
    const ok = canonical !== undefined && canonical.status === "up-to-date";
    return {
      exitCode: ok ? ExitCode.Ok : ExitCode.Environment,
      data: {
        mode: "check",
        path: "check",
        global,
        binaryVersion,
        locations: rows,
        detail: ok
          ? "installed skill is up to date"
          : "run `things install-skill` to install or update the agent skill",
      },
    };
  }

  // Bench fence: never write into a real HOME during a simulated run.
  if (deps.simulated) {
    return {
      exitCode: ExitCode.Ok,
      data: {
        mode: "install",
        path: "simulated",
        global,
        binaryVersion,
        locations: [],
        detail: "simulated: no files were written (the skill roots were not touched)",
      },
    };
  }

  // Stamp a temp copy with the binary version and install THAT — every location
  // the installer materializes inherits the stamp; the repo copy stays pristine.
  return withStampedSkillDir(skillDir, binaryVersion, (stampedDir) => {
    // Prefer the skills CLI; fall back to a plain copy into the two known roots.
    const viaCli = deps.runSkillsCli(stampedDir, global);
    if (viaCli) {
      const rows: LocationReport[] = locations
        .filter((loc) => loc.canonical || existsSync(loc.dir))
        .map((loc) => ({
          label: loc.label,
          dir: loc.dir,
          installedVersion: installedSkillVersion(loc.dir),
          status: "written",
        }));
      return {
        exitCode: ExitCode.Ok,
        data: {
          mode: "install",
          path: "skills-cli",
          global,
          binaryVersion,
          locations: rows,
          detail: "installed via the skills CLI (canonical ~/.agents + detected agent dirs)",
        },
      };
    }

    const rows: LocationReport[] = locations.map((loc) => {
      deps.copyInto(stampedDir, loc.dir);
      return {
        label: loc.label,
        dir: loc.dir,
        installedVersion: installedSkillVersion(loc.dir),
        status: "written",
      };
    });
    return {
      exitCode: ExitCode.Ok,
      data: {
        mode: "install",
        path: "builtin-copy",
        global,
        binaryVersion,
        locations: rows,
        detail:
          "skills CLI unavailable — used a built-in copy (install `skills` to cover other agents)",
      },
    };
  });
}

/** Human-readable rendering of the result. */
function render(data: InstallSkillData): string[] {
  const lines: string[] = [];
  if (data.mode === "check") {
    lines.push(`binary version: ${data.binaryVersion}`);
    for (const r of data.locations) {
      const iv = r.installedVersion ?? "(not installed)";
      lines.push(`  ${r.label}: ${iv} — ${r.status}`);
    }
    lines.push("", data.detail);
    return lines;
  }
  if (data.path === "simulated") {
    lines.push(data.detail);
    return lines;
  }
  lines.push(
    data.path === "skills-cli"
      ? "Installed the things-cli agent skill via the skills CLI."
      : "Installed the things-cli agent skill (built-in copy).",
  );
  for (const r of data.locations) lines.push(`  ${r.label}: ${r.dir}`);
  lines.push(
    "",
    data.detail,
    "",
    "Re-run `things install-skill` any time to update; `--check` compares versions without writing.",
  );
  return lines;
}

export function registerInstallSkill(program: Command): void {
  program
    .command("install-skill")
    .description(
      "Install the bundled agent skill so coding agents can drive `things` with no " +
        "out-of-band knowledge. Uses the skills CLI when available (covering every " +
        "detected agent), otherwise a built-in copy into ~/.agents and ~/.claude. " +
        "Re-run any time to update — the skill is replaced wholesale. The copy is " +
        "stamped with this binary's version. --check compares the installed version " +
        "against this binary's version without writing anything.",
    )
    .option("--check", "report installed vs this binary's skill version without writing")
    .option("--project", "install into the current project (.agents) instead of globally")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { check?: boolean; project?: boolean; json?: boolean }) => {
      const started = Date.now();
      const { data, exitCode } = installSkill(opts, {
        home: resolveHome(),
        binaryVersion: CLI_VERSION,
        simulated: simFenceActive(),
        runSkillsCli: defaultRunSkillsCli,
        copyInto: defaultCopyInto,
      });
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("install-skill", data, meta(started)))}\n`,
        );
      } else {
        process.stdout.write(`${render(data).join("\n")}\n`);
      }
      process.exitCode = exitCode;
    });
}
