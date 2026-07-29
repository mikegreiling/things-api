/**
 * `things config get` — one key, or all keys with stored-vs-default provenance.
 * Config is read from the scratch config dir + env only (no DB), so these run
 * anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";

let configDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "THINGS_API_STATE_DIR",
  "THINGS_API_CONFIG_DIR",
  "THINGS_API_PROFILE",
  "THINGS_API_MAX_DISRUPTION",
  "THINGS_API_ACTOR",
  "THINGS_API_AUDIT",
  "THINGS_API_ALLOW_EXPERIMENTAL",
  "THINGS_API_UI_ENABLED",
  "NO_COLOR",
];

beforeEach(() => {
  const stateDir = mkdtempSync(join(tmpdir(), "things-api-config-get-"));
  configDir = join(stateDir, "config");
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  // Clear every THINGS_API_* override so defaults are deterministic.
  for (const key of ENV_KEYS) delete process.env[key];
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = configDir;
  process.env["NO_COLOR"] = "1"; // markers render as plain text
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
  rmSync(configDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

function lastJson(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "null";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("config get <key>", () => {
  it("prints a defaulted key's effective value with a (default) marker", async () => {
    await run(["config", "get", "profile"]);
    const out = stdout.join("");
    expect(out).toContain("profile: workstation");
    expect(out).toContain("(default)");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("--json: envelope with key/value/source for one key", async () => {
    await run(["config", "get", "maxDisruption", "--json"]);
    const env = lastJson();
    expect(env["ok"]).toBe(true);
    expect(env["kind"]).toBe("config");
    const data = env["data"] as Record<string, unknown>;
    expect(data["key"]).toBe("maxDisruption");
    expect(data["value"]).toBe(1); // workstation default tier
    // The default comes from the profile, so it reports derived, not default.
    expect(data["source"]).toBe("derived");
  });

  it("reports host as a derived read-only value", async () => {
    await run(["config", "get", "host", "--json"]);
    const data = lastJson()["data"] as Record<string, unknown>;
    expect(data["key"]).toBe("host");
    expect(data["source"]).toBe("derived");
    expect(typeof data["value"]).toBe("string");
  });

  it("a recognized env value forces a stored vector off (bidirectional)", async () => {
    await run(["config", "set", "ui-enabled", "true"]);
    process.env["THINGS_API_UI_ENABLED"] = "false";
    await run(["config", "get", "ui-enabled", "--json"]);
    const data = lastJson()["data"] as Record<string, unknown>;
    expect(data["value"]).toBe(false);
    expect(data["source"]).toBe("env");
  });

  it("reads back a stored value (no marker) after config set", async () => {
    await run(["config", "set", "actor", "release-bot"]);
    await run(["config", "get", "actor"]);
    const out = stdout.join("");
    expect(out).toContain("actor: release-bot");
    expect(out).not.toContain("(default)");

    stdout = [];
    await run(["config", "get", "actor", "--json"]);
    const data = lastJson()["data"] as Record<string, unknown>;
    expect(data["value"]).toBe("release-bot");
    expect(data["source"]).toBe("stored");
  });

  it("surfaces an env override as source=env", async () => {
    process.env["THINGS_API_UI_ENABLED"] = "true";
    await run(["config", "get", "ui-enabled", "--json"]);
    const data = lastJson()["data"] as Record<string, unknown>;
    expect(data["value"]).toBe(true);
    expect(data["source"]).toBe("env");
  });

  it("unknown key is a usage error (exit 2) on stderr", async () => {
    await run(["config", "get", "nope"]);
    expect(stderr.join("")).toContain('unknown config key "nope"');
    expect(process.exitCode).toBe(2);
  });
});

describe("config get (all keys)", () => {
  it("lists every effective value, including derived read-only ones", async () => {
    await run(["config", "get"]);
    const out = stdout.join("");
    for (const key of [
      "profile",
      "maxDisruption",
      "actor",
      "auditEnabled",
      "accepted-fingerprint",
      "allow-experimental",
      "ui-enabled",
      "host",
    ]) {
      expect(out).toContain(`${key}:`);
    }
    expect(out).toContain("(default)");
    expect(out).toContain("(derived)"); // host + profile-derived maxDisruption
  });

  it("--json: array of key/value/source entries", async () => {
    await run(["config", "get", "--json"]);
    const env = lastJson();
    expect(env["kind"]).toBe("config");
    const data = (env["data"] as { items: { key: string; source: string }[] }).items;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(11);
    expect(data.map((e) => e.key)).toContain("ui-enabled");
    expect(data.map((e) => e.key)).toContain("scope");
    expect(data.map((e) => e.key)).toContain("host");
    expect(data.map((e) => e.key)).toContain("bounce-enabled");
    expect(data.map((e) => e.key)).toContain("bounce-max-items");
    // With no stored file and no env: settable keys sit at their default,
    // while host and the profile-derived maxDisruption report derived.
    const byKey = Object.fromEntries(data.map((e) => [e.key, e.source]));
    expect(byKey["actor"]).toBe("default");
    expect(byKey["ui-enabled"]).toBe("default");
    expect(byKey["scope"]).toBe("default");
    expect(byKey["bounce-enabled"]).toBe("default");
    expect(byKey["bounce-max-items"]).toBe("default");
    expect(byKey["host"]).toBe("derived");
    expect(byKey["maxDisruption"]).toBe("derived");
  });

  it("mixes stored, default, and derived sources", async () => {
    await run(["config", "set", "profile", "dedicated-server"]);
    await run(["config", "get", "--json"]);
    const data = (lastJson()["data"] as { items: { key: string; source: string }[] }).items;
    const byKey = Object.fromEntries(data.map((e) => [e.key, e.source]));
    expect(byKey["profile"]).toBe("stored");
    expect(byKey["actor"]).toBe("default");
    expect(byKey["host"]).toBe("derived");
  });
});
