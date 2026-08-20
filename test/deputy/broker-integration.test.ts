/**
 * Live certification of the REAL Swift broker (deputy/src). Builds it with
 * scripts/build-deputy.sh, runs it as a supervised child against a temp state
 * dir, a synthetic SQLite file, and a stub osascript — never the production
 * container, never the real /usr/bin/osascript. Skipped automatically off
 * macOS or when no Swift toolchain is present (CI runs the mock suite;
 * this one rides dev machines and release preflights).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PKG_VERSION } from "../../src/contracts.ts";
import { createDeputyDbFacade } from "../../src/deputy/db-facade.ts";
import { osaExecSync } from "../../src/deputy/osa.ts";
import { shortcutsListSync, shortcutsRunExec } from "../../src/deputy/shortcuts-exec.ts";
import { DeputySyncBridge } from "../../src/deputy/bridge.ts";
import { deputySocketPath, deputyTokenPath } from "../../src/deputy/protocol.ts";
import { resetDeputyRoutingForTests } from "../../src/deputy/routing.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The error shape execFileSync throws and osaExecSync mirrors. */
type ExecShapedError = Error & {
  stderr?: string;
  status?: number | null;
  killed?: boolean;
  signal?: string | null;
};

function hasSwift(): boolean {
  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// Opt-in (THINGS_DEPUTY_LIVE=1) on top of the platform/toolchain gate: some
// managed hosts run EDR that convicts any freshly built unknown binary
// (observed 2026-08-19: Cylance execution_control, score -1000, on every
// things-deputy build). CI macOS runners are clean and set the flag; a dev
// machine opts in once its EDR excludes the build path or signing identity.
const runnable =
  process.platform === "darwin" && process.env["THINGS_DEPUTY_LIVE"] === "1" && hasSwift();

describe.skipIf(!runnable)("things-deputy broker (live binary)", () => {
  let tmp: string;
  let child: ChildProcess;
  let token: string;
  let bridge: DeputySyncBridge;
  let dbPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  function request(fields: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return bridge.request({ v: 1, token, ...fields, ...overrides }, 10_000);
  }

  beforeAll(async () => {
    execFileSync("bash", ["scripts/build-deputy.sh"], { cwd: repoRoot, stdio: "ignore" });

    tmp = mkdtempSync(join(tmpdir(), "depL-"));
    for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_DEPUTY", "THINGS_DB"]) {
      savedEnv[key] = process.env[key];
    }
    process.env["THINGS_API_STATE_DIR"] = tmp;
    process.env["THINGS_API_DEPUTY"] = "true";
    delete process.env["THINGS_DB"];

    // Synthetic "container": root/ThingsData-TEST/Things Database.thingsdatabase/main.sqlite
    dbPath = join(tmp, "container/ThingsData-TEST/Things Database.thingsdatabase/main.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n TEXT)");
    db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?)").run(
      7,
      1.5,
      "seven",
      new Uint8Array([1, 2]),
      null,
    );
    db.close();
    writeFileSync(join(tmp, "container/readable.txt"), "inside");

    const stub = join(tmp, "stub-osascript");
    writeFileSync(
      stub,
      `#!/bin/bash
script="\${@: -1}"
case "$script" in
  *SLEEP*) sleep 5 ;;
  *FAIL*) echo "execution error: not authorized (-1743)" >&2; exit 7 ;;
  *JXAECHO*) [ "$1" = "-l" ] && [ "$2" = "JavaScript" ] && echo "jxa-ok" || { echo "argv wrong" >&2; exit 3; } ;;
  *) echo "stub-ok" ;;
esac
`,
    );
    chmodSync(stub, 0o755);

    const shortcutsStub = join(tmp, "stub-shortcuts");
    writeFileSync(
      shortcutsStub,
      `#!/bin/bash
if [ "$1" = "list" ]; then printf 'things-proxy-alpha\\nother-shortcut\\n'; exit 0; fi
echo "$1:$2:$3:$4:$5:$6"
`,
    );
    chmodSync(shortcutsStub, 0o755);

    const deputyDir = join(tmp, "deputy");
    mkdirSync(deputyDir, { recursive: true });
    writeFileSync(
      join(deputyDir, "deputy.json"),
      JSON.stringify({ dbPath, osascriptPath: stub, shortcutsPath: shortcutsStub }),
    );

    child = spawn(join(repoRoot, "deputy/build/things-deputy"), ["--state-dir", deputyDir], {
      stdio: "ignore",
    });
    const socket = deputySocketPath(process.env);
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) || !existsSync(deputyTokenPath(process.env))) {
      if (Date.now() > deadline) throw new Error("deputy did not come up within 5s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    token = execFileSync("cat", [deputyTokenPath(process.env)], { encoding: "utf8" }).trim();
    bridge = new DeputySyncBridge(socket);
  }, 120_000);

  afterAll(() => {
    bridge?.close();
    resetDeputyRoutingForTests();
    // TERM asks for the clean shutdown path; KILL guarantees no orphan
    // survives a broken one (the supervised-lifecycle rail applies to tests too).
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 1000).unref();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("handshakes with the package version and the configured db path", () => {
    const res = request({ verb: "hello" });
    expect(res["ok"]).toBe(true);
    expect(res["protocol"]).toBe(1);
    expect(res["deputyVersion"]).toBe(PKG_VERSION);
    expect(res["dbPath"]).toBe(dbPath);
  });

  it("rejects a bad token", () => {
    const res = request({ verb: "hello" }, { token: "0".repeat(64) });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("bad-token");
  });

  it("sql: full type round-trip through the facade (int, real, text, blob, null)", () => {
    const db = createDeputyDbFacade();
    const row = db.prepare("SELECT i, r, s, b, n FROM t").get() as Record<string, unknown>;
    expect(row["i"]).toBe(7);
    expect(row["r"]).toBe(1.5);
    expect(row["s"]).toBe("seven");
    expect(row["b"]).toBeInstanceOf(Uint8Array);
    expect([...(row["b"] as Uint8Array)]).toEqual([1, 2]);
    expect(row["n"]).toBeNull();
  });

  it("sql: positional parameters bind", () => {
    const db = createDeputyDbFacade();
    const rows = db.prepare("SELECT s FROM t WHERE i = ? AND r < ?").all(7, 2.5) as {
      s: string;
    }[];
    expect(rows.map((r) => r.s)).toEqual(["seven"]);
  });

  it("sql: the connection cannot write", () => {
    const res = request({
      verb: "sql",
      sql: "INSERT INTO t VALUES (1, 1, 'x', NULL, NULL)",
      params: [],
    });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("sql-error");
  });

  it("sql: ATTACH is denied by the authorizer", () => {
    const res = request({
      verb: "sql",
      sql: `ATTACH DATABASE '${join(tmp, "other.sqlite")}' AS other`,
      params: [],
    });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { message: string }).message).toMatch(/not authorized|authoriz/i);
  });

  it("sql: refuses multi-statement requests", () => {
    const res = request({ verb: "sql", sql: "SELECT 1; SELECT 2", params: [] });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { message: string }).message).toContain("single SQL statement");
  });

  it("osascript: success round-trip (and the stub proves the argv shape)", () => {
    expect(osaExecSync("anything", 5000)).toBe("stub-ok\n");
  });

  it("osascript: JXA requests carry the -l JavaScript argv shape", () => {
    const res = request({
      verb: "osascript",
      script: "JXAECHO",
      lang: "javascript",
      timeoutMs: 5000,
    });
    expect(res["ok"]).toBe(true);
    expect(res["exitCode"]).toBe(0);
    expect(res["stdout"]).toBe("jxa-ok\n");
  });

  it("osascript: failure carries exit code and stderr for probe classification", () => {
    let caught: ExecShapedError | null = null;
    try {
      osaExecSync("FAIL", 5000);
    } catch (err) {
      caught = err as ExecShapedError;
    }
    expect(caught?.status).toBe(7);
    expect(caught?.stderr).toContain("-1743");
  });

  it("osascript: the deputy kills an overrunning script at the deadline", () => {
    const started = Date.now();
    const res = request({ verb: "osascript", script: "SLEEP", timeoutMs: 400 });
    expect(res["ok"]).toBe(true);
    expect(res["timedOut"]).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("osascript: the shell-execution guard refuses", () => {
    const res = request({ verb: "osascript", script: 'do shell script "id"', timeoutMs: 5000 });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("script-denied");
  });

  it("shortcuts: run carries the fixed argv shape and list censuses (stub proves both)", async () => {
    const run = await shortcutsRunExec("things-proxy-alpha", "/tmp/in.json", "/tmp/out.json", 5000);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(
      "run:things-proxy-alpha:--input-path:/tmp/in.json:--output-path:/tmp/out.json\n",
    );
    expect(shortcutsListSync(5000)).toContain("things-proxy-alpha");
  });

  it("shortcuts: refuses names outside the bundled things-proxy-* family", () => {
    const res = request({
      verb: "shortcuts",
      op: "run",
      name: "Evil Exfiltrator",
      inputPath: "/tmp/in",
      outputPath: "/tmp/out",
      timeoutMs: 5000,
    });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("shortcut-denied");
  });

  it("read-file: confined to the container subtree", () => {
    const inside = request({ verb: "read-file", path: join(tmp, "container/readable.txt") });
    expect(inside["ok"]).toBe(true);
    expect(Buffer.from(inside["b64"] as string, "base64").toString()).toBe("inside");
    const outside = request({ verb: "read-file", path: "/etc/hosts" });
    expect(outside["ok"]).toBe(false);
    expect((outside["error"] as { code: string }).code).toBe("read-denied");
  });

  it("read-file: dotdot traversal cannot escape", () => {
    const res = request({ verb: "read-file", path: join(tmp, "container/../secret.txt") });
    expect(res["ok"]).toBe(false);
  });

  it("locate answers with the configured database", () => {
    const res = request({ verb: "locate" });
    expect(res["ok"]).toBe(true);
    expect(res["path"]).toBe(dbPath);
  });
});
