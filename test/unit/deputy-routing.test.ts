/**
 * Deputy routing against a mock broker (worker-thread net server, no Swift
 * required — these run on any platform, CI included). Covers the activation
 * matrix (disabled / not-running / active / skew), the sync bridge + facade,
 * the async osascript path, error-shape synthesis for the probes, and the
 * db-routing override rules. The REAL Swift broker is certified separately in
 * test/deputy/broker-integration.test.ts (darwin-gated).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXPECTED_HELPERS_VERSION } from "../../src/deputy/protocol.ts";
import { createDeputyDbFacade } from "../../src/deputy/db-facade.ts";
import { readContainerFileSync } from "../../src/deputy/files.ts";
import { osaExec, osaExecSync } from "../../src/deputy/osa.ts";
import { shortcutsListSync, shortcutsRunExec } from "../../src/deputy/shortcuts-exec.ts";
import {
  deputyInstalledBinaryPath,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
  readerInstalledAppPath,
  readerRendezvousDir,
  readerSandboxContainerDir,
  readerSocketPath,
  readerTokenPath,
  reviveRow,
} from "../../src/deputy/protocol.ts";
import {
  deputyDbPath,
  deputyFilesActive,
  deputyRoutesDb,
  deputyRouting,
  helpersExpected,
  helpersRouting,
  readerRouting,
  resetDeputyRoutingForTests,
  settleDeputyAutomation,
} from "../../src/deputy/routing.ts";

const TOKEN = "cafe".repeat(16);

/** The error shape execFileSync throws and osaExecSync mirrors. */
type ExecShapedError = Error & {
  stderr?: string;
  status?: number | null;
  killed?: boolean;
  signal?: string | null;
};

interface MockOverrides {
  deputyVersion?: string;
  protocol?: number;
  dbPath?: string | null;
  /** hello's cached-path field; defaults to dbPath (warm-cache deputy). */
  helloDbPath?: string | null;
  sqlRows?: Record<string, unknown>[];
  osaResult?: Record<string, unknown>;
  token?: string;
  /**
   * hello's TCC standing. Defaults to fully granted so every non-gate cell
   * exercises the transport rather than the onboarding gate; pass `null` to
   * mock a deputy OLDER than the fields (they are simply absent).
   */
  automation?: { things: string; systemEvents: string } | null;
  axTrusted?: boolean;
}

const GRANTED = { things: "granted", systemEvents: "granted" };

let stateDir: string;
let workers: Worker[] = [];
let savedEnv: Record<string, string | undefined> = {};

async function startMock(overrides: MockOverrides = {}): Promise<void> {
  mkdirSync(join(stateDir, "deputy"), { recursive: true });
  writeFileSync(deputyTokenPath(process.env), overrides.token ?? TOKEN);
  const worker = new Worker(new URL("./helpers/mock-deputy-worker.ts", import.meta.url), {
    workerData: {
      socketPath: deputySocketPath(process.env),
      token: overrides.token ?? TOKEN,
      deputyVersion: overrides.deputyVersion ?? EXPECTED_HELPERS_VERSION,
      protocol: overrides.protocol ?? 1,
      dbPath:
        overrides.dbPath === undefined
          ? "/tmp/mock-things/D.thingsdatabase/main.sqlite"
          : overrides.dbPath,
      helloDbPath:
        overrides.helloDbPath !== undefined
          ? overrides.helloDbPath
          : overrides.dbPath === undefined
            ? "/tmp/mock-things/D.thingsdatabase/main.sqlite"
            : overrides.dbPath,
      sqlRows: overrides.sqlRows ?? [],
      osaResult: overrides.osaResult ?? { exitCode: 0, stdout: "ok\n", stderr: "" },
      ...(overrides.automation !== null && { automation: overrides.automation ?? GRANTED }),
      ...(overrides.axTrusted !== undefined && { axTrusted: overrides.axTrusted }),
    },
  });
  workers.push(worker);
  await new Promise((resolve) => worker.once("message", resolve));
}

/** A second mock at the READER socket (its own container dir in prod; a temp dir here). */
async function startMockReader(
  overrides: {
    granted?: boolean;
    helloDbPath?: string | null;
    sqlRows?: Record<string, unknown>[];
  } = {},
): Promise<void> {
  mkdirSync(join(stateDir, "reader"), { recursive: true });
  writeFileSync(readerTokenPath(process.env), TOKEN);
  const worker = new Worker(new URL("./helpers/mock-deputy-worker.ts", import.meta.url), {
    workerData: {
      socketPath: readerSocketPath(process.env),
      token: TOKEN,
      deputyVersion: EXPECTED_HELPERS_VERSION,
      protocol: 1,
      dbPath: "/tmp/mock-things/D.thingsdatabase/main.sqlite",
      helloDbPath:
        overrides.helloDbPath === undefined
          ? "/tmp/mock-things/D.thingsdatabase/main.sqlite"
          : overrides.helloDbPath,
      reader: { granted: overrides.granted ?? true },
      sqlRows: overrides.sqlRows ?? [],
      osaResult: { exitCode: 0, stdout: "", stderr: "" },
    },
  });
  workers.push(worker);
  await new Promise((resolve) => worker.once("message", resolve));
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dep-"));
  savedEnv = {
    THINGS_API_STATE_DIR: process.env["THINGS_API_STATE_DIR"],
    THINGS_API_READER_DIR: process.env["THINGS_API_READER_DIR"],
    THINGS_API_HELPERS: process.env["THINGS_API_HELPERS"],
    HOME: process.env["HOME"],
    THINGS_API_CONFIG_DIR: process.env["THINGS_API_CONFIG_DIR"],
    THINGS_DB: process.env["THINGS_DB"],
  };
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
  process.env["THINGS_API_HELPERS"] = "true";
  // Isolate from the host's real config: the default-inactive cell deletes
  // the env override, which must fall back to a clean stored config, not this
  // machine's `helpers-enabled`.
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  delete process.env["THINGS_DB"];
});

afterEach(async () => {
  resetDeputyRoutingForTests();
  for (const worker of workers) await worker.terminate();
  workers = [];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * The tri-state matrix (docs/design/agent-daemon.md §3c): mode × helper state.
 * The cell that carries the whole design is `auto` + ABSENT — silent, because
 * a machine that never installed the helpers is not a degraded machine — set
 * against `auto` + INSTALLED-but-broken, which must always speak up.
 */
/** Pretend `things helpers install` ran: the bundle exists on disk. */
function markInstalled(): void {
  mkdirSync(dirname(deputyInstalledBinaryPath(process.env)), { recursive: true });
  writeFileSync(deputyInstalledBinaryPath(process.env), "#!/bin/sh\n");
}

function noticesFrom(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("things-api helpers"));
}

describe("activation matrix (helpers-enabled tri-state)", () => {
  it("false + healthy helper: inactive, silent (never route)", async () => {
    await startMock();
    process.env["THINGS_API_HELPERS"] = "false";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toBe("disabled");
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("false + absent helper: inactive, silent", () => {
    process.env["THINGS_API_HELPERS"] = "false";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().reason).toBe("disabled");
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("true + healthy helper: active, carries the handshake", async () => {
    await startMock();
    const routing = deputyRouting();
    expect(routing.active).toBe(true);
    expect(routing.hello?.deputyVersion).toBe(EXPECTED_HELPERS_VERSION);
    expect(routing.hello?.dbPath).toContain("main.sqlite");
  });

  it("true + absent helper: inactive with ONE stderr notice, direct fallback", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("not installed");
    deputyRouting(); // second ask: memoized, no second notice
    const notices = noticesFrom(stderrSpy);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("running DIRECT");
    stderrSpy.mockRestore();
  });

  it("true + unhealthy helper (socket present, handshake refused): inactive + notice", async () => {
    await startMock();
    writeFileSync(deputyTokenPath(process.env), "0".repeat(64));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("handshake failed");
    expect(noticesFrom(stderrSpy)[0]).toContain("handshake failed");
    stderrSpy.mockRestore();
  });

  it("auto + healthy helper: active, and says nothing about it", async () => {
    await startMock();
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().active).toBe(true);
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("auto + absent helper: inactive and SILENT — absence is not degradation", () => {
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toBe("deputy not installed");
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("auto + INSTALLED but not running: inactive and LOUD", () => {
    process.env["THINGS_API_HELPERS"] = "auto";
    markInstalled();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("not running");
    expect(noticesFrom(stderrSpy)[0]).toContain("running DIRECT");
    stderrSpy.mockRestore();
  });

  it("auto + unhealthy helper (socket present, handshake refused): inactive and LOUD", async () => {
    await startMock();
    writeFileSync(deputyTokenPath(process.env), "0".repeat(64));
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(noticesFrom(stderrSpy)[0]).toContain("handshake failed");
    stderrSpy.mockRestore();
  });

  it("auto is the default when neither env nor config says otherwise", () => {
    delete process.env["THINGS_API_HELPERS"];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toBe("deputy not installed");
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("an unrecognized THINGS_API_HELPERS value falls through to the default", () => {
    process.env["THINGS_API_HELPERS"] = "yes-please";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().reason).toBe("deputy not installed");
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("protocol skew deactivates with a notice", async () => {
    await startMock({ protocol: 99 });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("protocol skew");
    expect(noticesFrom(stderrSpy)[0]).toContain("protocol");
    stderrSpy.mockRestore();
  });

  it("package-version skew on matching protocol proceeds with a notice", async () => {
    await startMock({ deputyVersion: "0.0.1" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(true);
    const notices = noticesFrom(stderrSpy);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]).toContain("0.0.1");
    stderrSpy.mockRestore();
  });

  it("spends at most ONE notice per process across both halves", async () => {
    // Deputy socket refuses the handshake AND the reader is installed-but-down:
    // two degradations, one line — stacked notices are noise, not information.
    await startMock();
    writeFileSync(deputyTokenPath(process.env), "0".repeat(64));
    mkdirSync(dirname(readerInstalledAppPath(process.env)), { recursive: true });
    writeFileSync(readerInstalledAppPath(process.env), "app");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    deputyRouting();
    readerRouting();
    expect(noticesFrom(stderrSpy)).toHaveLength(1);
    stderrSpy.mockRestore();
  });
});

/**
 * The onboarding gate: under `auto`, an installed-and-healthy deputy is NOT
 * enough. Routing writes through a deputy with no app-control grant would only
 * move the consent dialog onto the helper, where nobody is watching for it —
 * so `auto` stays dormant until the grant is on record. `true` is an explicit
 * instruction and routes regardless.
 */
describe("the auto onboarding gate", () => {
  it("auto + healthy + GRANTED: active and silent", async () => {
    await startMock({ automation: GRANTED });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().active).toBe(true);
    expect(noticesFrom(stderrSpy)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it("auto + healthy but NO app-control grant: dormant and LOUD", async () => {
    await startMock({ automation: { things: "unknown", systemEvents: "granted" } });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toBe("onboarding incomplete (automation → Things: unknown)");
    expect(noticesFrom(stderrSpy)[0]).toContain("things helpers setup");
    stderrSpy.mockRestore();
  });

  it("auto + a DENIED app-control grant: dormant, not routed on hope", async () => {
    await startMock({ automation: { things: "denied", systemEvents: "granted" } });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().reason).toContain("automation → Things: denied");
    stderrSpy.mockRestore();
  });

  /**
   * LIVENESS, NOT AUTHORIZATION (#617). `not-running` is what the deputy's
   * ask-false determination answers for a CLOSED Things, so it says nothing
   * about the grant — and the owner of a fully onboarded machine quits their
   * app all the time. Deactivating there would drop that machine onto the
   * direct path and print a notice claiming a permission is missing. The gate
   * DEFERS instead, and the write gate settles it once it has woken the app.
   */
  describe("auto + a CLOSED Things (the liveness deferral)", () => {
    it("stays active and says nothing — the app being shut is not a fault", async () => {
      await startMock({ automation: { things: "not-running", systemEvents: "granted" } });
      process.env["THINGS_API_HELPERS"] = "auto";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const routing = deputyRouting();
      expect(routing.active).toBe(true);
      expect(routing.reason).toBeNull();
      expect(noticesFrom(stderrSpy)).toEqual([]);
      stderrSpy.mockRestore();
    });

    it("a woken GRANTED settles it, and the handshake is corrected in place", async () => {
      await startMock({ automation: { things: "not-running", systemEvents: "granted" } });
      process.env["THINGS_API_HELPERS"] = "auto";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(deputyRouting().active).toBe(true);
      settleDeputyAutomation("granted");
      const routing = deputyRouting();
      expect(routing.active).toBe(true);
      expect(routing.hello?.automation?.things).toBe("granted");
      // Settled: nothing left to prove, so a second call cannot un-route it.
      settleDeputyAutomation("denied");
      expect(deputyRouting().active).toBe(true);
      expect(noticesFrom(stderrSpy)).toEqual([]);
      stderrSpy.mockRestore();
    });

    it("a woken REFUSAL deactivates with the notice the gate deferred", async () => {
      await startMock({ automation: { things: "not-running", systemEvents: "granted" } });
      process.env["THINGS_API_HELPERS"] = "auto";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(deputyRouting().active).toBe(true);
      settleDeputyAutomation("denied");
      const routing = deputyRouting();
      expect(routing.active).toBe(false);
      expect(routing.reason).toContain("automation → Things: denied");
      expect(noticesFrom(stderrSpy)[0]).toContain("things helpers setup");
      stderrSpy.mockRestore();
    });

    it("settling is a no-op where nothing was deferred (mode true never defers)", async () => {
      await startMock({ automation: { things: "not-running", systemEvents: "granted" } });
      process.env["THINGS_API_HELPERS"] = "true";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(deputyRouting().active).toBe(true);
      settleDeputyAutomation("denied");
      expect(deputyRouting().active).toBe(true);
      stderrSpy.mockRestore();
    });
  });

  it("Accessibility and System Events are NOT requisite — only Things gates writes", async () => {
    await startMock({
      automation: { things: "granted", systemEvents: "denied" },
      axTrusted: false,
    });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().active).toBe(true);
    stderrSpy.mockRestore();
  });

  it("an OLD deputy that cannot report its standing fails CLOSED under auto", async () => {
    await startMock({ automation: null });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("onboarding not provable");
    // The remedy is the rebuild that gives it the handshake fields.
    expect(noticesFrom(stderrSpy)[0]).toContain("build-helpers.sh");
    stderrSpy.mockRestore();
  });

  it("mode true routes an unonboarded deputy anyway — an explicit instruction is obeyed", async () => {
    await startMock({ automation: { things: "unknown", systemEvents: "unknown" } });
    process.env["THINGS_API_HELPERS"] = "true";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().active).toBe(true);
    stderrSpy.mockRestore();
  });

  it("mode true routes an OLD deputy too — the gate is auto's, not the protocol's", async () => {
    await startMock({ automation: null });
    process.env["THINGS_API_HELPERS"] = "true";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyRouting().active).toBe(true);
    stderrSpy.mockRestore();
  });

  it("READS are gated on the reader's own grant, not the deputy's — the halves are independent", async () => {
    // Deputy unonboarded, reader granted: reads route, writes stay dormant.
    await startMock({ automation: { things: "unknown", systemEvents: "unknown" } });
    await startMockReader({ granted: true });
    process.env["THINGS_API_HELPERS"] = "auto";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = helpersRouting();
    expect(routing.files).toBe(true);
    expect(routing.automation).toBe(false);
    expect(routing.deputyReason).toContain("onboarding incomplete");
    stderrSpy.mockRestore();
  });
});

describe("db routing rules", () => {
  it("routes only the default container database", async () => {
    await startMockReader({ granted: true });
    expect(deputyRoutesDb(undefined)).toBe(true);
    expect(deputyRoutesDb({ dbPath: "/tmp/explicit.sqlite" })).toBe(false);
    process.env["THINGS_DB"] = "/tmp/env.sqlite";
    expect(deputyRoutesDb(undefined)).toBe(false);
  });

  it("deputyDbPath uses the reader's handshake cache when warm", async () => {
    await startMockReader({ granted: true });
    expect(deputyDbPath()).toContain("main.sqlite");
  });

  it("deputyDbPath resolves via locate on a cold reader handshake", async () => {
    await startMockReader({ granted: true, helloDbPath: null });
    expect(deputyDbPath()).toContain("main.sqlite");
  });

  it("deputyDbPath is null without a granted reader (reads run direct)", async () => {
    await startMock();
    expect(deputyDbPath()).toBeNull();
  });
});

describe("reader transport (file verbs)", () => {
  it("file verbs ride the reader — never the deputy (mutations-only)", async () => {
    await startMock({ sqlRows: [{ fromDeputy: true }] });
    await startMockReader({ granted: true, sqlRows: [{ fromReader: true }] });
    const db = createDeputyDbFacade();
    const rows = db.prepare("SELECT 1").all() as Record<string, unknown>[];
    expect(rows).toEqual([{ fromReader: true }]);
  });

  it("a present-but-UNGRANTED reader means reads run DIRECT (no deputy fallback)", async () => {
    await startMock({ sqlRows: [{ fromDeputy: true }] });
    await startMockReader({ granted: false });
    expect(deputyFilesActive()).toBe(false);
    expect(deputyRoutesDb(undefined)).toBe(false);
    const db = createDeputyDbFacade();
    expect(() => db.prepare("SELECT 1").all()).toThrow(/reader is not active/);
  });

  it("reader alone: file verbs route, automation runs direct", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await startMockReader({ granted: true });
    expect(deputyFilesActive()).toBe(true);
    expect(deputyRoutesDb(undefined)).toBe(true);
    // No deputy: the automation half is honestly inactive.
    expect(deputyRouting().active).toBe(false);
    stderrSpy.mockRestore();
  });

  it("deputyDbPath resolves through the reader's handshake cache", async () => {
    await startMockReader({ granted: true });
    expect(deputyDbPath()).toContain("main.sqlite");
  });

  it("neither half up: files inactive, everything direct", () => {
    expect(deputyFilesActive()).toBe(false);
    expect(deputyRoutesDb(undefined)).toBe(false);
  });

  it("the THINGS_API_READER_DIR override keeps mock readers working with no FDA at all", async () => {
    process.env["HOME"] = join(stateDir, "no-grants-home");
    await startMockReader({ granted: true });
    expect(readerRouting()).toMatchObject({ active: true, granted: true });
    expect(deputyFilesActive()).toBe(true);
  });
});

/**
 * Where the rendezvous IS. `<state>/reader` — our own directory, a sibling of
 * `<state>/deputy` and outside every App Sandbox container. That placement is
 * the whole fix: launchd binds the socket there on the sandboxed reader's
 * behalf, so no client ever crosses a container boundary to find it.
 */
describe("rendezvous path defaults", () => {
  it("defaults to <state>/reader, with the socket and token beside each other", () => {
    const env = { THINGS_API_STATE_DIR: "/var/state/things-api" };
    expect(readerRendezvousDir(env)).toBe("/var/state/things-api/reader");
    expect(readerSocketPath(env)).toBe("/var/state/things-api/reader/reader.sock");
    expect(readerTokenPath(env)).toBe("/var/state/things-api/reader/token");
    // A sibling of the deputy's state, never inside it: install owns
    // `<state>/deputy/bin` wholesale and deletes it on every run.
    expect(readerRendezvousDir(env)).not.toContain(deputyStateDir(env));
  });

  it("no default path leads into a sandbox container", () => {
    const env = { THINGS_API_STATE_DIR: "/var/state/things-api" };
    expect(readerSocketPath(env)).not.toContain("Library/Containers");
    expect(readerTokenPath(env)).not.toContain("Library/Containers");
    // The BOOKMARK is the one thing that stays in the container, by design —
    // and the OS picks that path from the bundle id, not from our state dir.
    expect(readerSandboxContainerDir(env)).toContain(
      "Library/Containers/com.pixelcog.things-reader/Data",
    );
  });

  it("THINGS_API_READER_DIR relocates every reader-side path together", () => {
    const env = { THINGS_API_STATE_DIR: "/var/state/things-api", THINGS_API_READER_DIR: "/tmp/mk" };
    expect(readerRendezvousDir(env)).toBe("/tmp/mk");
    expect(readerSocketPath(env)).toBe("/tmp/mk/reader.sock");
    expect(readerTokenPath(env)).toBe("/tmp/mk/token");
    expect(readerSandboxContainerDir(env)).toBe("/tmp/mk");
  });
});

/**
 * Reader routing is HOST-UNIVERSAL: the rendezvous is `<state>/reader`, ours
 * and outside every App Sandbox container, so a client finds and reaches the
 * reader with no Full Disk Access, no witnessed app-data grant, and nothing to
 * prove before looking. These cells are the regression against ever putting a
 * host gate back in front of a reader probe.
 */
describe("reader routing needs no grant of its own (permissions doctrine, Article I)", () => {
  /** No override, no FDA (an empty HOME has no TCC.db), no witnessed grant. */
  function ungrantedHost(): string {
    const home = join(stateDir, "home");
    mkdirSync(home, { recursive: true });
    delete process.env["THINGS_API_READER_DIR"];
    process.env["HOME"] = home;
    return home;
  }

  it("a grant-less host reads the rendezvous and routes on what it finds", async () => {
    // The override is gone, so the rendezvous resolves to `<state>/reader` —
    // and the mock lives exactly there, because that is where the real one
    // does now. A host with no grants of any kind routes to it.
    ungrantedHost();
    await startMockReader({ granted: true });
    expect(readerRouting()).toMatchObject({ active: true, granted: true });
    expect(deputyFilesActive()).toBe(true);
    expect(deputyRoutesDb(undefined)).toBe(true);
  });

  it("an absent rendezvous on a grant-less host is 'not installed', not 'unreachable'", () => {
    ungrantedHost();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(readerRouting()).toMatchObject({
      active: false,
      granted: false,
      reason: "reader not installed",
    });
    expect(deputyFilesActive()).toBe(false);
    stderrSpy.mockRestore();
  });

  it("helpersExpected answers from our own state dir, on any host", () => {
    ungrantedHost();
    // Nothing installed under `auto`: an ordinary un-onboarded machine.
    process.env["THINGS_API_HELPERS"] = "auto";
    expect(helpersExpected()).toBe(false);
    mkdirSync(dirname(readerInstalledAppPath(process.env)), { recursive: true });
    writeFileSync(readerInstalledAppPath(process.env), "app");
    expect(helpersExpected()).toBe(true);
  });

  it("an unreadable access token is a reported state, never a thrown EPERM", async () => {
    // The rendezvous is ours, so this is no longer a TCC denial — but a file
    // that will not open must still be a state we REPORT. `helpers status`
    // used to die here with a raw EPERM out of readFileSync.
    await startMockReader({ granted: true });
    resetDeputyRoutingForTests();
    chmodSync(readerTokenPath(process.env), 0o000);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(() => readerRouting()).not.toThrow();
    expect(readerRouting()).toMatchObject({ active: false });
    expect(readerRouting().reason).toContain("access token could not be read");
    chmodSync(readerTokenPath(process.env), 0o600);
    stderrSpy.mockRestore();
  });
});

describe("helpersRouting (what the mode resolved to — doctor's input)", () => {
  it("reports both halves carrying traffic", async () => {
    await startMock();
    await startMockReader({ granted: true });
    const routing = helpersRouting();
    expect(routing).toMatchObject({ mode: "true", automation: true, files: true });
    expect(routing.deputyReason).toBeNull();
    expect(routing.readerReason).toBeNull();
  });

  it("names the ceremony when the reader is running but ungranted", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await startMock();
    await startMockReader({ granted: false });
    const routing = helpersRouting();
    expect(routing.automation).toBe(true);
    expect(routing.files).toBe(false);
    expect(routing.readerReason).toContain("things helpers setup");
    stderrSpy.mockRestore();
  });

  it("reports mode false as fully direct", () => {
    process.env["THINGS_API_HELPERS"] = "false";
    expect(helpersRouting()).toMatchObject({
      mode: "false",
      automation: false,
      files: false,
      deputyReason: "disabled",
      readerReason: "disabled",
    });
  });
});

describe("db facade", () => {
  it("prepare().all/get round-trip with blob revival", async () => {
    await startMockReader({
      sqlRows: [
        {
          uuid: "u1",
          n: 5,
          real: 1.5,
          none: null,
          blob: { $b64: Buffer.from("hi").toString("base64") },
        },
      ],
    });
    const db = createDeputyDbFacade();
    const rows = db.prepare("SELECT x FROM y WHERE z = ?").all("v") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["uuid"]).toBe("u1");
    expect(rows[0]?.["n"]).toBe(5);
    expect(rows[0]?.["blob"]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(rows[0]?.["blob"] as Uint8Array).toString()).toBe("hi");
    const row = db.prepare("SELECT x FROM y").get() as Record<string, unknown>;
    expect(row["uuid"]).toBe("u1");
  });

  it("get() is undefined when no rows come back", async () => {
    await startMockReader({ sqlRows: [] });
    const db = createDeputyDbFacade();
    expect(db.prepare("SELECT x").get()).toBeUndefined();
  });

  it("write/unknown members throw teaching errors, never a silent no-op", async () => {
    await startMockReader({});
    const db = createDeputyDbFacade();
    expect(() => db.prepare("SELECT 1").run()).toThrow(/not available on a deputy-routed/);
    expect(() => db.exec("VACUUM")).toThrow(/not available/);
    expect(() => (db as unknown as { backup: () => void }).backup()).toThrow(/backup/);
    expect(() => db.close()).not.toThrow();
  });

  it("rejects parameters it cannot carry faithfully", async () => {
    await startMockReader({});
    const db = createDeputyDbFacade();
    expect(() => db.prepare("SELECT ?").all(new Uint8Array([1]) as never)).toThrow(
      /unsupported object parameter/,
    );
  });
});

describe("osascript routing", () => {
  it("async osaExec maps the deputy result to the execFile shape", async () => {
    await startMock({ osaResult: { exitCode: 0, stdout: "42\n", stderr: "" } });
    const res = await osaExec("tell app", { timeoutMs: 5000 });
    expect(res).toEqual({ exitCode: 0, stdout: "42\n", stderr: "" });
  });

  it("async osaExec surfaces a deputy-side timeout as timedOut", async () => {
    await startMock({
      osaResult: { exitCode: 1, stdout: "", stderr: "", timedOut: true, signal: 15 },
    });
    const res = await osaExec("tell app", { timeoutMs: 5000 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  it("osaExecSync returns stdout on success", async () => {
    await startMock({ osaResult: { exitCode: 0, stdout: "3 areas\n", stderr: "" } });
    expect(osaExecSync("count", 5000)).toBe("3 areas\n");
  });

  it("osaExecSync throws an execFileSync-shaped error the probes can classify", async () => {
    await startMock({
      osaResult: {
        exitCode: 1,
        stdout: "",
        stderr: "execution error: Not authorized to send Apple events to Things3. (-1743)",
      },
    });
    let caught: ExecShapedError | null = null;
    try {
      osaExecSync("count", 5000);
    } catch (err) {
      caught = err as ExecShapedError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.stderr).toContain("-1743");
    expect(caught?.status).toBe(1);
    expect(caught?.killed).toBe(false);
  });

  it("osaExecSync marks a deputy-side timeout killed/SIGTERM like execFileSync", async () => {
    await startMock({ osaResult: { exitCode: 1, stdout: "", stderr: "", timedOut: true } });
    let caught: ExecShapedError | null = null;
    try {
      osaExecSync("count", 5000);
    } catch (err) {
      caught = err as ExecShapedError;
    }
    expect(caught?.killed).toBe(true);
    expect(caught?.signal).toBe("SIGTERM");
  });
});

describe("shortcuts routing", () => {
  it("run and list ride the deputy when active", async () => {
    await startMock();
    const run = await shortcutsRunExec("things-proxy-create-heading", "/tmp/in", "/tmp/out", 5000);
    expect(run).toEqual({ exitCode: 0, stdout: "run:things-proxy-create-heading", stderr: "" });
    expect(shortcutsListSync(5000)).toBe("list:");
  });
});

describe("container file reads", () => {
  it("routes through the granted reader when active", async () => {
    await startMockReader({});
    const bytes = readContainerFileSync("/mock/container/prefs.plist");
    expect(bytes.toString()).toBe("mock:/mock/container/prefs.plist");
  });
});

describe("reviveRow", () => {
  it("revives only $b64-tagged objects", () => {
    const row = reviveRow({ a: 1, b: null, c: { $b64: Buffer.from("x").toString("base64") } });
    expect(row["a"]).toBe(1);
    expect(row["b"]).toBeNull();
    expect(row["c"]).toBeInstanceOf(Uint8Array);
  });
});
