/**
 * `things install-skill` — fake-HOME integration around the command core with
 * side effects injected, so no test touches the network or a real HOME. Covers
 * the built-in copy fallback, the clean-overwrite re-add semantics (probe-
 * confirmed 2026-07-21), the skills-CLI success path, the simulated bench fence,
 * the binary-version stamp on install, and --check per-location reporting.
 * Companion unit assertions for the shared version helpers live alongside.
 */
import { afterEach, describe, expect, it } from "vitest";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultCopyInto,
  installSkill,
  type InstallSkillDeps,
} from "../../src/cli/commands/install-skill.ts";
import {
  bundledSkillDir,
  bundledSkillVersion,
  compareSemver,
  installedSkillVersion,
  parseSemver,
  parseSkillVersion,
  skillLocations,
} from "../../src/cli/skill.ts";

/**
 * A fixed stand-in for the running binary's version (`CLI_VERSION`). Kept
 * distinct from the repo SKILL.md placeholder (`0.0.0-dev`) so the tests prove
 * installs carry the BINARY version, not the frontmatter placeholder.
 */
const BIN = "1.2.3-dev";

let home: string | null = null;
afterEach(() => {
  if (home !== null) rmSync(home, { recursive: true, force: true });
  home = null;
});

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), "things-api-skill-home-"));
  return home;
}

/** Deps that force the built-in copy fallback (skills CLI "unavailable"). */
function fallbackDeps(h: string): InstallSkillDeps {
  return {
    home: h,
    binaryVersion: BIN,
    simulated: false,
    runSkillsCli: () => false,
    copyInto: defaultCopyInto,
  };
}

describe("install-skill: built-in copy fallback", () => {
  it("copies the skill into both known roots, stamped with the binary version", () => {
    const h = newHome();
    const { data, exitCode } = installSkill({}, fallbackDeps(h));
    expect(exitCode).toBe(0);
    expect(data.path).toBe("builtin-copy");
    expect(data.binaryVersion).toBe(BIN);
    // The repo placeholder is NOT what lands — the running binary's version is.
    expect(bundledSkillVersion()).not.toBe(BIN);
    for (const loc of skillLocations(h)) {
      const md = join(loc.dir, "SKILL.md");
      expect(existsSync(md), loc.label).toBe(true);
      // References travel too (recursive copy).
      expect(existsSync(join(loc.dir, "references", "contracts.md")), loc.label).toBe(true);
      expect(installedSkillVersion(loc.dir), loc.label).toBe(BIN);
    }
    // The report names both destinations as written.
    expect(data.locations.map((r) => r.status)).toEqual(["written", "written"]);
  });

  it("never modifies the repo's own SKILL.md (stamps only the copy)", () => {
    const h = newHome();
    const before = bundledSkillVersion();
    installSkill({}, fallbackDeps(h));
    expect(bundledSkillVersion()).toBe(before); // repo placeholder untouched
    expect(before).toBe("0.0.0-dev");
  });

  it("re-add cleanly overwrites: stale content and orphan files are removed", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    // Pre-populate with a stale copy plus an orphan file.
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 0.0.0-old\n---\nSTALE\n");
    writeFileSync(join(canonical, "ORPHAN.txt"), "leftover");

    installSkill({}, fallbackDeps(h));

    expect(existsSync(join(canonical, "ORPHAN.txt"))).toBe(false);
    const md = readFileSync(join(canonical, "SKILL.md"), "utf8");
    expect(md).not.toContain("STALE");
    expect(installedSkillVersion(canonical)).toBe(BIN);
  });
});

describe("install-skill: skills-CLI success path", () => {
  it("reports the skills-cli path and never falls back", () => {
    const h = newHome();
    let copied = false;
    const { data, exitCode } = installSkill(
      {},
      {
        home: h,
        binaryVersion: BIN,
        simulated: false,
        runSkillsCli: () => true,
        copyInto: () => {
          copied = true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(data.path).toBe("skills-cli");
    expect(copied, "must not fall back to a copy when the CLI succeeds").toBe(false);
  });

  it("hands the skills CLI a stamped copy named things-cli (so every agent dir inherits the stamp)", () => {
    const h = newHome();
    let handedBasename: string | null = null;
    let handedVersion: string | null = null;
    installSkill(
      {},
      {
        home: h,
        binaryVersion: BIN,
        simulated: false,
        // Read the handed dir WHILE it still exists — it is a temp copy that
        // withStampedSkillDir cleans up as soon as installSkill returns.
        runSkillsCli: (dir) => {
          handedBasename = dir.split("/").at(-1) ?? null;
          handedVersion = installedSkillVersion(dir);
          return true;
        },
        copyInto: () => {},
      },
    );
    // The canonical basename survives so `skills add <dir>` registers the right id.
    expect(handedBasename).toBe("things-cli");
    // The handed dir carries the BINARY stamp, not the repo placeholder.
    expect(handedVersion).toBe(BIN);
  });

  it("cleans up the stamped temp dir after the shell-out", () => {
    const h = newHome();
    let handed: string | null = null;
    installSkill(
      {},
      {
        home: h,
        binaryVersion: BIN,
        simulated: false,
        runSkillsCli: (dir) => {
          handed = dir;
          return true;
        },
        copyInto: () => {},
      },
    );
    expect(handed).not.toBeNull();
    expect(existsSync(handed!), "temp stamped dir must be removed").toBe(false);
  });

  it("--project drops the global flag passed to the skills CLI", () => {
    const h = newHome();
    let sawGlobal: boolean | null = null;
    installSkill(
      { project: true },
      {
        home: h,
        binaryVersion: BIN,
        simulated: false,
        runSkillsCli: (_dir, global) => {
          sawGlobal = global;
          return true;
        },
        copyInto: () => {},
      },
    );
    expect(sawGlobal).toBe(false);
  });
});

describe("install-skill: bench fence", () => {
  it("simulated run writes nothing", () => {
    const h = newHome();
    let touched = false;
    const { data, exitCode } = installSkill(
      {},
      {
        home: h,
        binaryVersion: BIN,
        simulated: true,
        runSkillsCli: () => {
          touched = true;
          return true;
        },
        copyInto: () => {
          touched = true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(data.path).toBe("simulated");
    expect(touched).toBe(false);
    expect(existsSync(skillLocations(h)[0]!.dir)).toBe(false);
  });
});

describe("install-skill: --check reports per location without writing", () => {
  it("absent everywhere → exit 7, nothing written", () => {
    const h = newHome();
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.mode).toBe("check");
    for (const r of data.locations) expect(r.status).toBe("absent");
    // --check must not create anything.
    expect(existsSync(skillLocations(h)[0]!.dir)).toBe(false);
  });

  it("compares against the binary version, not the bundled placeholder", () => {
    // --check reports the RUNNING BINARY's version, never the repo's 0.0.0-dev.
    const h = newHome();
    const { data } = installSkill({ check: true }, fallbackDeps(h));
    expect(data.binaryVersion).toBe(BIN);
  });

  it("canonical matching the binary version → up-to-date, exit 0", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), `---\nversion: ${BIN}\n---\n`);
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(0);
    expect(data.locations[0]!.status).toBe("up-to-date");
  });

  it("a same-version stamp without the -dev suffix still reads up-to-date", () => {
    // The binary is 1.2.3-dev; an installed 1.2.3 stamp differs only by suffix.
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 1.2.3\n---\n");
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(0);
    expect(data.locations[0]!.status).toBe("up-to-date");
  });

  it("a legacy 0.0.0-dev copy reads as legacy (refresh), exit 7", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 0.0.0-dev\n---\n");
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.locations[0]!.installedVersion).toBe("0.0.0-dev");
    expect(data.locations[0]!.status).toBe("legacy");
  });

  it("an older stamp reads as behind, exit 7", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 1.1.0\n---\n");
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.locations[0]!.status).toBe("behind");
  });

  it("canonical carries a different (ahead) version → differs, exit 7", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 99.0.0\n---\n");
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.locations[0]!.installedVersion).toBe("99.0.0");
    expect(data.locations[0]!.status).toBe("differs");
  });
});

describe("skill version helpers", () => {
  it("parses the version stamp from frontmatter", () => {
    expect(parseSkillVersion("---\nname: x\nversion: 1.2.3\n---\nbody")).toBe("1.2.3");
    expect(parseSkillVersion('---\nversion: "0.0.0-dev"\n---\n')).toBe("0.0.0-dev");
    expect(parseSkillVersion("no frontmatter")).toBeNull();
    expect(parseSkillVersion("---\nname: x\n---\n")).toBeNull();
  });

  it("the bundled SKILL.md carries a parseable version stamp", () => {
    const v = bundledSkillVersion();
    expect(v).not.toBeNull();
    expect(parseSemver(v)).not.toBeNull();
    expect(existsSync(join(bundledSkillDir(), "SKILL.md"))).toBe(true);
  });

  it("compareSemver orders X.Y.Z (suffix-tolerant), null on non-semver", () => {
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1); // behind
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("0.0.0", "0.0.0-dev")).toBe(0); // suffix ignored
    expect(compareSemver("nope", "1.0.0")).toBeNull();
  });
});
