/**
 * Deputy routing against a mock broker (worker-thread net server, no Swift
 * required — these run on any platform, CI included). Covers the activation
 * matrix (disabled / not-running / active / skew), the sync bridge + facade,
 * the async osascript path, error-shape synthesis for the probes, and the
 * db-routing override rules. The REAL Swift broker is certified separately in
 * test/deputy/broker-integration.test.ts (darwin-gated).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PKG_VERSION } from "../../src/contracts.ts";
import { createDeputyDbFacade } from "../../src/deputy/db-facade.ts";
import { readContainerFileSync } from "../../src/deputy/files.ts";
import { osaExec, osaExecSync } from "../../src/deputy/osa.ts";
import { shortcutsListSync, shortcutsRunExec } from "../../src/deputy/shortcuts-exec.ts";
import {
  deputySocketPath,
  deputyTokenPath,
  readerSocketPath,
  readerTokenPath,
  reviveRow,
} from "../../src/deputy/protocol.ts";
import {
  deputyDbPath,
  deputyFilesActive,
  deputyRoutesDb,
  deputyRouting,
  resetDeputyRoutingForTests,
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
}

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
      deputyVersion: overrides.deputyVersion ?? PKG_VERSION,
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
    },
  });
  workers.push(worker);
  await new Promise((resolve) => worker.once("message", resolve));
}

/** A second mock at the READER socket (its own container dir in prod; a temp dir here). */
async function startMockReader(
  overrides: { granted?: boolean; helloDbPath?: string | null } = {},
): Promise<void> {
  mkdirSync(join(stateDir, "reader"), { recursive: true });
  writeFileSync(readerTokenPath(process.env), TOKEN);
  const worker = new Worker(new URL("./helpers/mock-deputy-worker.ts", import.meta.url), {
    workerData: {
      socketPath: readerSocketPath(process.env),
      token: TOKEN,
      deputyVersion: PKG_VERSION,
      protocol: 1,
      dbPath: "/tmp/mock-things/D.thingsdatabase/main.sqlite",
      helloDbPath:
        overrides.helloDbPath === undefined
          ? "/tmp/mock-things/D.thingsdatabase/main.sqlite"
          : overrides.helloDbPath,
      reader: { granted: overrides.granted ?? true },
      sqlRows: [],
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
    THINGS_API_DEPUTY: process.env["THINGS_API_DEPUTY"],
    THINGS_DB: process.env["THINGS_DB"],
  };
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
  process.env["THINGS_API_DEPUTY"] = "true";
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

describe("activation matrix", () => {
  it("is inactive by default (no env, no config)", () => {
    delete process.env["THINGS_API_DEPUTY"];
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toBe("disabled");
  });

  it("THINGS_API_DEPUTY=false forces inactive even with a live broker", async () => {
    await startMock();
    process.env["THINGS_API_DEPUTY"] = "false";
    expect(deputyRouting().active).toBe(false);
  });

  it("enabled but not running: inactive with one stderr notice, direct fallback", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("not running");
    deputyRouting(); // second ask: memoized, no second notice
    const notices = stderrSpy.mock.calls.filter((c) => String(c[0]).includes("things-api deputy"));
    expect(notices).toHaveLength(1);
    expect(String(notices[0]?.[0])).toContain("running DIRECT");
    stderrSpy.mockRestore();
  });

  it("activates against a live broker and carries the handshake", async () => {
    await startMock();
    const routing = deputyRouting();
    expect(routing.active).toBe(true);
    expect(routing.hello?.deputyVersion).toBe(PKG_VERSION);
    expect(routing.hello?.dbPath).toContain("main.sqlite");
  });

  it("protocol skew deactivates with a notice", async () => {
    await startMock({ protocol: 99 });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("protocol skew");
    stderrSpy.mockRestore();
  });

  it("package-version skew on matching protocol proceeds with a notice", async () => {
    await startMock({ deputyVersion: "0.0.1" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(true);
    const notices = stderrSpy.mock.calls.filter((c) => String(c[0]).includes("things-api deputy"));
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(String(notices[0]?.[0])).toContain("0.0.1");
    stderrSpy.mockRestore();
  });

  it("a wrong token file fails the handshake closed (inactive, direct)", async () => {
    await startMock();
    writeFileSync(deputyTokenPath(process.env), "0".repeat(64));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const routing = deputyRouting();
    expect(routing.active).toBe(false);
    expect(routing.reason).toContain("handshake failed");
    stderrSpy.mockRestore();
  });
});

describe("db routing rules", () => {
  it("routes only the default container database", async () => {
    await startMock();
    expect(deputyRoutesDb(undefined)).toBe(true);
    expect(deputyRoutesDb({ dbPath: "/tmp/explicit.sqlite" })).toBe(false);
    process.env["THINGS_DB"] = "/tmp/env.sqlite";
    expect(deputyRoutesDb(undefined)).toBe(false);
  });

  it("deputyDbPath uses the handshake cache when warm", async () => {
    await startMock();
    expect(deputyDbPath()).toContain("main.sqlite");
  });

  it("deputyDbPath falls back to locate on a cold handshake (first contact)", async () => {
    await startMock({ helloDbPath: null });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyDbPath()).toContain("main.sqlite");
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("consent dialog");
    stderrSpy.mockRestore();
  });

  it("deputyDbPath is null (direct fallback) when locate cannot resolve", async () => {
    await startMock({ helloDbPath: null, dbPath: null });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(deputyDbPath()).toBeNull();
    stderrSpy.mockRestore();
  });
});

describe("reader transport (file verbs)", () => {
  it("a granted reader is preferred over the deputy for sql", async () => {
    await startMock({ sqlRows: [{ x: 1 }] });
    await startMockReader({ granted: true });
    const db = createDeputyDbFacade();
    const rows = db.prepare("SELECT 1").all() as Record<string, unknown>[];
    expect(rows[0]?.["servedBy"]).toBe("reader");
  });

  it("a present-but-UNGRANTED reader is skipped — the deputy serves", async () => {
    await startMock({ sqlRows: [{ x: 1 }] });
    await startMockReader({ granted: false });
    const db = createDeputyDbFacade();
    const rows = db.prepare("SELECT 1").all() as Record<string, unknown>[];
    expect(rows[0]?.["servedBy"]).toBeUndefined();
    expect(rows[0]?.["x"]).toBe(1);
  });

  it("reader alone: file verbs route, automation runs direct", async () => {
    await startMockReader({ granted: true });
    expect(deputyFilesActive()).toBe(true);
    expect(deputyRoutesDb(undefined)).toBe(true);
    // No deputy: the automation half is honestly inactive.
    expect(deputyRouting().active).toBe(false);
  });

  it("deputyDbPath resolves through the reader's handshake cache", async () => {
    await startMockReader({ granted: true });
    expect(deputyDbPath()).toContain("main.sqlite");
  });

  it("neither half up: files inactive, everything direct", () => {
    expect(deputyFilesActive()).toBe(false);
    expect(deputyRoutesDb(undefined)).toBe(false);
  });
});

describe("db facade", () => {
  it("prepare().all/get round-trip with blob revival", async () => {
    await startMock({
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
    await startMock({ sqlRows: [] });
    const db = createDeputyDbFacade();
    expect(db.prepare("SELECT x").get()).toBeUndefined();
  });

  it("write/unknown members throw teaching errors, never a silent no-op", async () => {
    await startMock();
    const db = createDeputyDbFacade();
    expect(() => db.prepare("SELECT 1").run()).toThrow(/not available on a deputy-routed/);
    expect(() => db.exec("VACUUM")).toThrow(/not available/);
    expect(() => (db as unknown as { backup: () => void }).backup()).toThrow(/backup/);
    expect(() => db.close()).not.toThrow();
  });

  it("rejects parameters it cannot carry faithfully", async () => {
    await startMock();
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
  it("routes through the deputy when active", async () => {
    await startMock();
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
