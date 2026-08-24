/**
 * `things helpers` surface + the global `--helpers/--no-helpers` override.
 * Status must be honest on a machine with nothing installed (the common first
 * run), and the global flag must outrank the environment before any action
 * loads config — that is the whole point of a per-invocation override.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import {
  deputySocketPath,
  deputyTokenPath,
  EXPECTED_HELPERS_VERSION,
} from "../../src/deputy/protocol.ts";
import { resetDeputyRoutingForTests } from "../../src/deputy/routing.ts";

let stateDir: string;
let stdout: string[];
let stderr: string[];
let workers: Worker[] = [];
const savedEnv: Record<string, string | undefined> = {};

const TOKEN = "beef".repeat(16);

/**
 * A mock deputy answering on the state dir's socket. `tcc` carries the TCC
 * standing helpers 1.2.0+ report in `hello`; omitting it mocks an OLDER
 * deputy, whose status rows must simply not appear.
 */
async function startMockDeputy(tcc?: {
  axTrusted: boolean;
  automation: { things: string; systemEvents: string };
}): Promise<void> {
  mkdirSync(join(stateDir, "deputy"), { recursive: true });
  writeFileSync(deputyTokenPath(process.env), TOKEN);
  const worker = new Worker(new URL("../unit/helpers/mock-deputy-worker.ts", import.meta.url), {
    workerData: {
      socketPath: deputySocketPath(process.env),
      token: TOKEN,
      deputyVersion: EXPECTED_HELPERS_VERSION,
      protocol: 1,
      dbPath: null,
      helloDbPath: null,
      sqlRows: [],
      osaResult: { exitCode: 0, stdout: "", stderr: "" },
      ...tcc,
    },
  });
  workers.push(worker);
  await new Promise((resolve) => worker.once("message", resolve));
}

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "helpcli-"));
  for (const key of [
    "THINGS_API_STATE_DIR",
    "THINGS_API_HELPERS",
    "THINGS_API_CONFIG_DIR",
    "THINGS_API_READER_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  // Isolate from a REAL reader serving in this user's container (a granted
  // production machine must not leak into the bare-machine assertions).
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
  delete process.env["THINGS_API_HELPERS"];
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
});

afterEach(async () => {
  for (const worker of workers) await worker.terminate();
  workers = [];
  resetDeputyRoutingForTests();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("things helpers status", () => {
  it("reports a bare machine honestly (nothing installed, not running, auto ⇒ direct)", async () => {
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("deputy: does not appear to be running");
    expect(out).not.toContain("detail:");
    expect(out).toContain("routing: auto — nothing installed");
    expect(out).toContain("reader: not installed");
    expect(process.exitCode).toBe(0);
  });

  it("--json carries the structured status, including the tri-state mode", async () => {
    await run(["helpers", "status", "--json"]);
    const parsed = JSON.parse(stdout.join("")) as {
      kind: string;
      data: {
        mode: string;
        bundleInstalled: boolean;
        installedVersion: string | null;
        deputy: { running: boolean; hungSocket: boolean; hello: unknown };
        reader: { installed: boolean; granted: boolean; hungSocket: boolean };
      };
    };
    expect(parsed.kind).toBe("helpers-status");
    expect(parsed.data.mode).toBe("auto");
    expect(parsed.data.bundleInstalled).toBe(false);
    expect(parsed.data.installedVersion).toBeNull();
    expect(parsed.data.deputy.running).toBe(false);
    expect(parsed.data.deputy.hungSocket).toBe(false);
    expect(parsed.data.deputy.hello).toBeNull();
    expect(parsed.data.reader.installed).toBe(false);
    expect(parsed.data.reader.granted).toBe(false);
    expect(parsed.data.reader.hungSocket).toBe(false);
  });

  it("reports the installed bundle's version and a hung socket", async () => {
    const bundle = join(stateDir, "deputy/bin/Things API Helper.app");
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(bundle, "Contents/MacOS/things-deputy"), "#!/bin/sh\n");
    writeFileSync(
      join(bundle, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>",
    );
    // A socket + token with nothing listening = the hung-socket class.
    writeFileSync(join(stateDir, "deputy/deputy.sock"), "");
    writeFileSync(join(stateDir, "deputy/token"), "0".repeat(64));
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("bundle: installed (v9.9.9)");
    expect(out).toContain("things helpers restart");
    // A bundle that cannot answer cannot prove its grants either: dormant.
    expect(out).toContain("routing: auto — dormant: onboarding incomplete");
    expect(out).toContain("the deputy is not answering");
  });
});

describe("helpers status — the auto routing gate", () => {
  /** Pretend a bundle is installed, so `auto` is past the absence case. */
  function markInstalled(): void {
    const bundle = join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "things-deputy"), "#!/bin/sh\n");
  }

  it("says DORMANT while the app-control grant for Things is missing", async () => {
    markInstalled();
    await startMockDeputy({
      axTrusted: false,
      automation: { things: "unknown", systemEvents: "granted" },
    });
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("routing: auto — dormant: onboarding incomplete");
    expect(out).toContain("automation → Things (unknown)");
    expect(out).toContain("things helpers setup");
  });

  it("says ROUTING once the requisite grants are on record", async () => {
    markInstalled();
    await startMockDeputy({
      axTrusted: false,
      automation: { things: "granted", systemEvents: "not-running" },
    });
    await run(["helpers", "status"]);
    const out = stdout.join("");
    // Accessibility and System Events are NOT requisite — the UI vector is
    // gated separately, so their absence must not read as dormant routing.
    expect(out).toContain("routing: auto — routing (onboarded)");
    expect(out).not.toContain("dormant");
  });

  it("stays dormant for helpers too old to report their permission standing", async () => {
    markInstalled();
    await startMockDeputy();
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("routing: auto — dormant: onboarding incomplete");
    expect(out).toContain("predate the permission handshake");
  });
});

describe("global --helpers/--no-helpers", () => {
  it("--helpers forces THINGS_API_HELPERS=true for the invocation", async () => {
    await run(["--helpers", "helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBe("true");
    expect(stdout.join("")).toContain("routing: enabled");
  });

  it("--no-helpers outranks an enabling environment", async () => {
    process.env["THINGS_API_HELPERS"] = "auto";
    await run(["--no-helpers", "helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBe("false");
    expect(stdout.join("")).toContain("routing: disabled");
  });

  it("without the flag the environment is left alone", async () => {
    await run(["helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBeUndefined();
  });
});

describe("the helpers subcommand surface", () => {
  it("is exactly status, restart, setup, uninstall", () => {
    const helpers = buildProgram()
      .commands.find((c) => c.name() === "helpers")
      ?.commands.map((c) => c.name())
      .toSorted();
    expect(helpers).toEqual(["restart", "setup", "status", "uninstall"]);
  });
});

describe("helpers uninstall --revoke", () => {
  // Only the refusal gates are exercised through the CLI: a confirmed revoke
  // runs the REAL `tccutil` and `lsregister`, which would revoke this
  // machine's live helper grants. The confirmed path is unit-covered with an
  // injected runner (test/unit/helpers-uninstall.test.ts).
  it("refuses without --yes when stdin is not a terminal", async () => {
    await run(["helpers", "uninstall", "--revoke"]);
    expect(stderr.join("")).toContain("--yes");
    expect(process.exitCode).toBe(2);
  });

  it("refuses --json --revoke without --yes (no interactive prompt under --json)", async () => {
    await run(["helpers", "uninstall", "--revoke", "--json"]);
    expect(stderr.join("")).toContain("--yes");
    expect(stdout.join("")).toBe("");
    expect(process.exitCode).toBe(2);
  });
});

describe("helpers setup", () => {
  it("refuses cleanly when no bundle has been built", async () => {
    await run(["helpers", "setup", "--bundle", join(stateDir, "missing-bundle.app")]);
    expect(stderr.join("")).toContain("not found");
    expect(process.exitCode).toBe(7);
  });

  it("names the ceremony's outcome in its own --help, so the nonzero exit is not a surprise", () => {
    const setup = buildProgram()
      .commands.find((c) => c.name() === "helpers")
      ?.commands.find((c) => c.name() === "setup");
    expect(setup?.description()).toContain("nonzero while any permission is still outstanding");
  });
});

describe("helpers status — the deputy's TCC standing", () => {
  it("renders the automation and accessibility rows the handshake carries", async () => {
    await startMockDeputy({
      axTrusted: false,
      automation: { things: "granted", systemEvents: "not-running" },
    });
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("automation: Things granted, System Events not-running");
    expect(out).toContain("accessibility: not granted");
    expect(out).toContain("next: `things helpers setup`");
  });

  it("omits both rows for a deputy that predates them", async () => {
    await startMockDeputy();
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("version:");
    expect(out).not.toContain("automation:");
    expect(out).not.toContain("accessibility:");
  });

  it("--json carries the fields through untouched", async () => {
    await startMockDeputy({
      axTrusted: true,
      automation: { things: "granted", systemEvents: "granted" },
    });
    await run(["helpers", "status", "--json"]);
    const parsed = JSON.parse(stdout.join("")) as {
      data: { deputy: { hello: { axTrusted: boolean; automation: { things: string } } } };
    };
    expect(parsed.data.deputy.hello.axTrusted).toBe(true);
    expect(parsed.data.deputy.hello.automation.things).toBe("granted");
  });
});

// `helpers setup` is never run without --bundle here: the default resolves the
// bundle packaged with this checkout, and a real install would bootstrap
// launchd agents on the machine running the suite. Its refusal path is above;
// the ceremony itself is unit-covered (test/unit/helpers-onboard.test.ts).
