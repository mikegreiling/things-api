/**
 * `things install-skill` — place the bundled agent skill (`skills/things-cli/`)
 * where coding agents discover it. Prefers the `skills` CLI (vercel-labs), which
 * detects every installed agent harness and keeps one canonical copy under
 * `~/.agents/skills/`; falls back to a plain copy into the two roots we can place
 * without detection (`~/.agents` and `~/.claude`) when that tool or the network
 * is unavailable. Re-running it IS the update: the skill directory is replaced
 * wholesale, so a stale copy is cleanly overwritten.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";

import { ExitCode, okEnvelope, simFenceActive, type EnvelopeMeta } from "../../index.ts";
import {
  bundledSkillDir,
  bundledSkillVersion,
  compareSemver,
  installedSkillVersion,
  resolveHome,
  skillLocations,
} from "../skill.ts";

/** How the skill was placed (or would have been). */
type InstallPath = "skills-cli" | "builtin-copy" | "simulated" | "check";

/** Per-location report row. */
interface LocationReport {
  label: string;
  dir: string;
  installedVersion: string | null;
  /** up-to-date | behind | differs | absent (check); written (install copy). */
  status: "up-to-date" | "behind" | "differs" | "absent" | "written";
}

interface InstallSkillData {
  mode: "install" | "check";
  path: InstallPath;
  global: boolean;
  bundledVersion: string | null;
  locations: LocationReport[];
  detail: string;
}

/** Injectable side effects, so the integration test never touches the network. */
export interface InstallSkillDeps {
  home: string;
  /** True to simulate without touching HOME (bench fence). */
  simulated: boolean;
  /** Run `skills add`; returns true on success, false when unavailable/failed. */
  runSkillsCli: (skillDir: string, global: boolean) => boolean;
  /** Plain-copy the bundled skill into a destination directory (clean overwrite). */
  copyInto: (skillDir: string, destDir: string) => void;
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

/** Classify an installed stamp against the bundled one for `--check`. */
function checkStatus(installed: string | null, bundled: string | null): LocationReport["status"] {
  if (installed === null) return "absent";
  if (installed === bundled) return "up-to-date";
  const cmp = compareSemver(installed, bundled);
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
  const bundledVersion = bundledSkillVersion();
  const locations = skillLocations(deps.home);

  if (!existsSync(skillDir)) {
    return {
      exitCode: ExitCode.Environment,
      data: {
        mode: opts.check === true ? "check" : "install",
        path: "check",
        global,
        bundledVersion,
        locations: [],
        detail: `bundled skill directory not found: ${skillDir}`,
      },
    };
  }

  // --check: read stamps, compare, never write.
  if (opts.check === true) {
    const rows: LocationReport[] = locations.map((loc) => {
      const installed = installedSkillVersion(loc.dir);
      return {
        label: loc.label,
        dir: loc.dir,
        installedVersion: installed,
        status: checkStatus(installed, bundledVersion),
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
        bundledVersion,
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
        bundledVersion,
        locations: [],
        detail: "simulated: no files were written (the skill roots were not touched)",
      },
    };
  }

  // Prefer the skills CLI; fall back to a plain copy into the two known roots.
  const viaCli = deps.runSkillsCli(skillDir, global);
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
        bundledVersion,
        locations: rows,
        detail: "installed via the skills CLI (canonical ~/.agents + detected agent dirs)",
      },
    };
  }

  const rows: LocationReport[] = locations.map((loc) => {
    deps.copyInto(skillDir, loc.dir);
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
      bundledVersion,
      locations: rows,
      detail:
        "skills CLI unavailable — used a built-in copy (install `skills` to cover other agents)",
    },
  };
}

/** Human-readable rendering of the result. */
function render(data: InstallSkillData): string[] {
  const lines: string[] = [];
  const ver = data.bundledVersion ?? "unstamped";
  if (data.mode === "check") {
    lines.push(`bundled skill version: ${ver}`);
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
        "Re-run any time to update — the skill is replaced wholesale. --check compares " +
        "the installed version against the bundled one without writing anything.",
    )
    .option("--check", "report installed vs bundled skill version without writing")
    .option("--project", "install into the current project (.agents) instead of globally")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { check?: boolean; project?: boolean; json?: boolean }) => {
      const started = Date.now();
      const { data, exitCode } = installSkill(opts, {
        home: resolveHome(),
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
