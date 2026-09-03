/**
 * Live certification of the REAL Swift broker (deputy/src). Builds it with
 * scripts/build-helpers.sh, runs it as a supervised child against a temp state
 * dir, a synthetic SQLite file, and a stub osascript — never the production
 * container, never the real /usr/bin/osascript. Skipped automatically off
 * macOS or when no Swift toolchain is present (CI runs the mock suite;
 * this one rides dev machines and release preflights).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPECTED_HELPERS_VERSION } from "../../src/deputy/protocol.ts";
import { osaExecSync } from "../../src/deputy/osa.ts";
import { shortcutsListSync, shortcutsRunExec } from "../../src/deputy/shortcuts-exec.ts";
import { DeputySyncBridge } from "../../src/deputy/bridge.ts";
import { deputySocketPath, deputyTokenPath } from "../../src/deputy/protocol.ts";
import { resetDeputyRoutingForTests } from "../../src/deputy/routing.ts";
import { everyUiScript, POLLING_SHAPE } from "../unit/helpers/ui-script-catalog.ts";

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
    execFileSync("bash", ["scripts/build-helpers.sh"], { cwd: repoRoot, stdio: "ignore" });

    tmp = mkdtempSync(join(tmpdir(), "depL-"));
    for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_HELPERS", "THINGS_DB"]) {
      savedEnv[key] = process.env[key];
    }
    process.env["THINGS_API_STATE_DIR"] = tmp;
    process.env["THINGS_API_HELPERS"] = "true";
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
      JSON.stringify({ osascriptPath: stub, shortcutsPath: shortcutsStub }),
    );

    execFileSync(
      "swiftc",
      [
        "-O",
        join(repoRoot, "deputy/src/sqlite.swift"),
        join(repoRoot, "test/deputy/helpers/sqlite-harness/main.swift"),
        "-o",
        join(tmp, "sqlite-harness"),
      ],
      { stdio: "ignore", timeout: 120_000 },
    );

    child = spawn(
      join(repoRoot, "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy"),
      ["--state-dir", deputyDir],
      {
        stdio: "ignore",
      },
    );
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

  it("handshakes with the helpers version as a mutations-only deputy", () => {
    const res = request({ verb: "hello" });
    expect(res["ok"]).toBe(true);
    expect(res["protocol"]).toBe(1);
    expect(res["deputyVersion"]).toBe(EXPECTED_HELPERS_VERSION);
    expect(res["role"]).toBe("deputy");
  });

  it("carries its own TCC standing in the handshake, prompt-free", () => {
    // The VALUES depend on the host's grants; the shape and vocabulary do not.
    // prime-ax is deliberately NOT exercised here — it raises a system dialog.
    const res = request({ verb: "hello" });
    expect(typeof res["axTrusted"]).toBe("boolean");
    const automation = res["automation"] as { things: string; systemEvents: string };
    for (const value of [automation.things, automation.systemEvents]) {
      expect(["granted", "denied", "not-running", "unknown"]).toContain(value);
    }
  });

  /**
   * THE SETTLE OBSERVER, AGAINST THE REAL BINARY (DEPOBS1).
   *
   * Everything here rides a SELF-TEST session: no `AXObserver`, no
   * Accessibility, no other process's UI tree — arrivals are injected. That is
   * deliberate and it is the only way this can be certified at all on the hosts
   * that run it. A child deputy is not the installed bundle, so it is not
   * Accessibility-trusted and never will be (asking would raise a dialog, which
   * the permissions doctrine forbids outside a ceremony); what a REAL session
   * adds on top of this is exactly one thing — whether Things posts the
   * notifications — and VOPAT1 measured that in the lab.
   *
   * So these cells own the half that is protocol rather than app behavior: the
   * cursor semantics, the ANY-OF/ALL-OF matcher, role discrimination, the burst
   * debounce, the wait timeout, an unknown token, a stopped session, and the
   * malformed-request refusals.
   */
  describe("the settle observer", () => {
    function start(fields: Record<string, unknown> = {}) {
      const res = request({ verb: "observer-start", selfTest: true, ...fields });
      expect(res["ok"]).toBe(true);
      return res["observer"] as string;
    }

    it("advertises the observer capability in the handshake", () => {
      const res = request({ verb: "hello" });
      expect(res["capabilities"]).toContain("observer");
    });

    it("mints a session, moves a cursor, and stops it", () => {
      const observer = start();
      expect(typeof observer).toBe("string");
      const first = request({ verb: "observer-mark", observer });
      expect(first["seq"]).toBe(0);
      const injected = request({
        verb: "observer-inject",
        observer,
        events: ["AXMenuOpened:AXMenu", "AXValueChanged:AXTextField"],
      });
      expect(injected["added"]).toBe(2);
      const second = request({ verb: "observer-mark", observer });
      expect(second["seq"]).toBe(2);
      expect(request({ verb: "observer-stop", observer })["stopped"]).toBe(true);
      // AND IT IS GONE: a second stop is honest about finding nothing, and
      // every other verb refuses by name rather than answering out of thin air.
      expect(request({ verb: "observer-stop", observer })["stopped"]).toBe(false);
      const after = request({ verb: "observer-mark", observer });
      expect(after["ok"]).toBe(false);
      expect((after["error"] as { code: string }).code).toBe("no-session");
    });

    it("waits for an arrival past the cursor, and reports what fired", () => {
      const observer = start();
      const before = request({ verb: "observer-mark", observer })["seq"] as number;
      request({ verb: "observer-inject", observer, events: ["AXSheetCreated:AXSheet"] });
      const res = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: ["AXSheetCreated"],
        timeoutMs: 1000,
      });
      expect(res["ok"]).toBe(true);
      expect(res["timedOut"]).toBe(false);
      expect(res["fired"]).toBe("AXSheetCreated:AXSheet");
      expect(res["seen"]).toBe(1);
      request({ verb: "observer-stop", observer });
    });

    it("discriminates on ROLE, and an ALL-OF requirement must also land", () => {
      const observer = start();
      const before = request({ verb: "observer-mark", observer })["seq"] as number;
      // The wrong role for the same notification is NOT the settle's arrival —
      // this is the 366-ms-too-early defect VOPAT1 §4.2 g found.
      request({ verb: "observer-inject", observer, events: ["AXValueChanged:AXStaticText"] });
      const missed = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: ["AXValueChanged:AXPopUpButton"],
        timeoutMs: 150,
      });
      expect(missed["timedOut"]).toBe(true);
      expect(missed["seen"]).toBe(1);
      request({ verb: "observer-inject", observer, events: ["AXValueChanged:AXPopUpButton"] });
      const hit = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: ["AXValueChanged:AXPopUpButton"],
        all: ["AXValueChanged:AXStaticText"],
        timeoutMs: 1000,
      });
      expect(hit["timedOut"]).toBe(false);
      expect(hit["fired"]).toBe("AXValueChanged:AXPopUpButton");
      // An ALL-OF class that never arrives is named in the timeout's `missing`.
      const incomplete = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: ["AXValueChanged:AXPopUpButton"],
        all: ["AXMenuClosed"],
        timeoutMs: 150,
      });
      expect(incomplete["timedOut"]).toBe(true);
      expect(incomplete["missing"]).toBe("AXMenuClosed");
      request({ verb: "observer-stop", observer });
    });

    it("a wait with no matcher is the non-blocking count", () => {
      // How a caller asks "did the previous step actuate ANYTHING?" — the
      // question that is only meaningful because Things is silent when nothing
      // happens (VOPAT1-6). No matcher, no budget, no waiting.
      const observer = start();
      const before = request({ verb: "observer-mark", observer })["seq"] as number;
      const quiet = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: [],
        timeoutMs: 0,
      });
      expect(quiet["seen"]).toBe(0);
      request({ verb: "observer-inject", observer, events: ["AXMoved", "AXResized"] });
      const busy = request({
        verb: "observer-wait",
        observer,
        after: before,
        want: [],
        timeoutMs: 0,
      });
      expect(busy["seen"]).toBe(2);
      request({ verb: "observer-stop", observer });
    });

    it("times out inside its budget rather than hanging the connection", () => {
      const observer = start();
      const started = Date.now();
      const res = request({
        verb: "observer-wait",
        observer,
        after: 0,
        want: ["AXMenuOpened"],
        timeoutMs: 250,
      });
      const waited = Date.now() - started;
      expect(res["timedOut"]).toBe(true);
      expect(res["seen"]).toBe(0);
      expect(waited).toBeGreaterThanOrEqual(200);
      expect(waited).toBeLessThan(5000);
      // The connection is still good afterwards — the wait is dispatched off
      // the read loop precisely so it cannot strand what is queued behind it.
      expect(request({ verb: "hello" })["ok"]).toBe(true);
      request({ verb: "observer-stop", observer });
    });

    it("refuses malformed requests, an unknown token, and injection into a real session", () => {
      const observer = start();
      const cases: [Record<string, unknown>, string][] = [
        [{ verb: "observer-mark" }, "bad-request"],
        [{ verb: "observer-mark", observer: "" }, "bad-request"],
        [{ verb: "observer-mark", observer: "deadbeef" }, "no-session"],
        [{ verb: "observer-wait", observer, want: ["AXMenuOpened"] }, "bad-request"],
        [{ verb: "observer-wait", observer, after: -1, timeoutMs: 10 }, "bad-request"],
        [{ verb: "observer-inject", observer, events: "AXMoved" }, "bad-request"],
        [{ verb: "observer-start", pid: 0 }, "bad-request"],
      ];
      for (const [fields, code] of cases) {
        const res = request(fields);
        expect(res["ok"], JSON.stringify(fields)).toBe(false);
        expect((res["error"] as { code: string }).code, JSON.stringify(fields)).toBe(code);
      }
      // A REAL session that cannot attach refuses, and never prompts.
      //
      // The pid is deliberately one that cannot exist (macOS pid_max is 99998):
      // this suite must never register an observer on the DEVELOPER MACHINE's
      // running Things. It nearly did — the child deputy is signed with the same
      // identity as the installed bundle, so TCC hands it the same Accessibility
      // grant, and a bare `observer-start` here succeeded against the live app
      // (2026-09-03). Passive or not, a test does not attach to the user's
      // running app. What the cell is actually for is the REFUSAL path, and an
      // unattachable pid exercises it on a trusted host and an untrusted one
      // alike — the message says which.
      const real = request({ verb: "observer-start", pid: 999_999 });
      expect(real["ok"]).toBe(false);
      expect((real["error"] as { code: string }).code).toBe("observer-unavailable");
      expect(String((real["error"] as { message: string }).message)).toMatch(
        /Accessibility|registrations|AXObserverCreate/,
      );
      request({ verb: "observer-stop", observer });
    });

    it("injection is refused on anything but a self-test session", () => {
      // The seam cannot be turned on a live ledger: only a session that was
      // STARTED as a self-test will take injected events, so nothing can put a
      // fabricated arrival in front of a real settle.
      const res = request({ verb: "observer-inject", observer: "deadbeef", events: ["AXMoved"] });
      expect(res["ok"]).toBe(false);
      expect((res["error"] as { code: string }).code).toBe("no-session");
    });
  });

  it("rejects a bad token", () => {
    const res = request({ verb: "hello" }, { token: "0".repeat(64) });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("bad-token");
  });

  it("file verbs are structurally absent — they live on the reader", () => {
    for (const fields of [
      { verb: "sql", sql: "SELECT 1", params: [] },
      { verb: "read-file", path: "/tmp/x" },
      { verb: "locate" },
    ]) {
      const res = request(fields);
      expect(res["ok"]).toBe(false);
      expect((res["error"] as { code: string }).code).toBe("unsupported-verb");
    }
  });

  // The shared SQLite executor (deputy/src/sqlite.swift, consumed by the
  // sandboxed reader whose granted path only the SANDBOX1 VM rig can unlock)
  // stays live-covered through an unsandboxed one-shot harness.
  it("sqlite executor: type round-trip, param binding, readonly, ATTACH deny, single-statement", () => {
    const harness = join(tmp, "sqlite-harness");
    const run = (sql: string, ...params: string[]) =>
      execFileSync(harness, [dbPath, sql, ...params], { encoding: "utf8" }).trim();
    const rows = JSON.parse(run("SELECT i, r, s, n FROM t WHERE s = ?", "seven")) as Record<
      string,
      unknown
    >[];
    expect(rows).toEqual([{ i: 7, r: 1.5, s: "seven", n: null }]);
    const blob = JSON.parse(run("SELECT b FROM t")) as { b: { $b64: string } }[];
    expect(Buffer.from(blob[0]!.b.$b64, "base64")).toEqual(Buffer.from([1, 2]));
    expect(run("INSERT INTO t VALUES (1, 1, 'x', NULL, NULL)")).toContain("ERROR");
    expect(run(`ATTACH DATABASE '${join(tmp, "other.sqlite")}' AS other`)).toMatch(/authoriz/i);
    expect(run("SELECT 1; SELECT 2")).toContain("single SQL statement");
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

  /**
   * THE ROUTED ARM (#695). The guard above proves the lint BITES; this proves it
   * bites nothing the library actually sends.
   *
   * Every ui-vector certification the lab has ever run drove scripts DIRECT —
   * goldens have no helpers installed — so "does the broker accept this script"
   * was a dimension with no arm at all, and 0.20.7 shipped a settle sidecar whose
   * `do shell script` hop made `todo add-repeating --dangerously-drive-gui` fail
   * in two seconds on every helpers-routed Mac. The static guard
   * (test/unit/ui-script-broker-safety.test.ts) checks the rendered scripts
   * against a MIRROR of the Swift list; this checks them against the REAL binary,
   * so the class cannot survive a mirror that has drifted either.
   *
   * The stub osascript never looks at the script, so nothing here is driven and
   * no GUI is touched: what is certified is acceptance at the broker's door,
   * which is exactly where the field failure happened.
   */
  it("osascript: the broker accepts every acting script the ui vector generates", () => {
    const scripts = everyUiScript([POLLING_SHAPE]);
    expect(scripts.length).toBeGreaterThan(30);
    const refused = scripts
      .map((s) => ({
        label: s.label,
        res: request({
          verb: "osascript",
          script: s.script,
          lang: s.lang === "javascript" ? "javascript" : "applescript",
          timeoutMs: 5000,
        }),
      }))
      .filter((r) => r.res["ok"] !== true)
      .map((r) => `${r.label} — ${JSON.stringify(r.res["error"])}`);
    expect(refused).toEqual([]);
  }, 120_000);

  it("shortcuts: run carries the fixed argv shape and list censuses (stub proves both)", async () => {
    const run = await shortcutsRunExec("things-proxy-alpha", "/tmp/in.json", "/tmp/out.json", 5000);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(
      "run:things-proxy-alpha:--input-path:/tmp/in.json:--output-path:/tmp/out.json\n",
    );
    expect(shortcutsListSync(5000)).toContain("things-proxy-alpha");
  });

  /**
   * Graceful drain (§3c item 3): `helpers install` / `restart` boot a running
   * helper out mid-flight. A request already dispatched must still get its
   * answer, and the process must then exit CLEANLY (0, socket removed) —
   * otherwise upgrade-while-busy silently kills whatever was in progress.
   *
   * Its own deputy instance with its own state dir, so the shared one above
   * survives for the rest of the suite.
   */
  it("SIGTERM drains: the in-flight request completes, then the process exits 0", async () => {
    const drainDir = join(tmp, "drain");
    mkdirSync(drainDir, { recursive: true });
    writeFileSync(
      join(drainDir, "deputy.json"),
      JSON.stringify({ osascriptPath: join(tmp, "stub-osascript") }),
    );
    const victim = spawn(
      join(repoRoot, "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy"),
      ["--state-dir", drainDir],
      { stdio: "ignore" },
    );
    const socketPath = join(drainDir, "deputy.sock");
    const tokenPath = join(drainDir, "token");
    const upBy = Date.now() + 5000;
    while (!existsSync(socketPath) || !existsSync(tokenPath)) {
      if (Date.now() > upBy) throw new Error("drain-test deputy did not come up within 5s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const drainToken = readFileSync(tokenPath, "utf8").trim();

    // The SLEEP stub holds the request for ~5s; SIGTERM lands while it runs.
    const conn = connect(socketPath);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += String(chunk);
        const nl = buffer.indexOf("\n");
        if (nl >= 0) resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      });
      conn.on("error", reject);
      conn.on("close", () => reject(new Error("connection closed before the response arrived")));
    });
    await new Promise((resolve) => conn.once("connect", resolve));
    conn.write(
      `${JSON.stringify({ v: 1, token: drainToken, verb: "osascript", script: "SLEEP", timeoutMs: 20_000 })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 750)); // let it reach osascript
    const exited = new Promise<number | null>((resolve) =>
      victim.once("exit", (code) => resolve(code)),
    );
    victim.kill("SIGTERM");

    const res = await response;
    expect(res["ok"]).toBe(true);
    expect(res["exitCode"]).toBe(0);
    expect(res["timedOut"]).toBeUndefined();
    conn.destroy();
    expect(await exited).toBe(0);
    // The socket is removed on the way out, so no client can find a dead helper.
    expect(existsSync(socketPath)).toBe(false);
  }, 30_000);

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
});
