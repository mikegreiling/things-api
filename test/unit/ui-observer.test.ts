/**
 * THE AX SETTLE SIDECAR (VOPAT2, #676) — the protocol, the fallback, and the
 * bounded exits.
 *
 * Three properties are certified here, and the third is the one that keeps this
 * change safe:
 *
 *  1. THE PROTOCOL WORKS, against the real `python3` sidecar. The `--self-test`
 *     mode runs the whole socket/token/matcher/debounce/TTL machine with the
 *     Accessibility half removed, so it certifies everything that is not AX on
 *     any host — including the Linux CI runner. What only a Mac with Things can
 *     answer (does the app post these notifications?) is the lab's job, and
 *     VOPAT1 already measured it.
 *  2. THE MATCHER DISCRIMINATES. A settle that accepted any `AXValueChanged`
 *     would be satisfied by the static text the same rebuild also changes, 366 ms
 *     too early (VOPAT1 §4.2 g). The role is part of the expectation and is
 *     tested as such.
 *  3. WITH NO SIDECAR, THE SCRIPTS ARE THE OLD SCRIPTS — byte for byte, not
 *     merely equivalently. That is what makes the polling settle a certified
 *     fallback rather than a second implementation to maintain.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  inertSettleInjector,
  observerCount,
  OBSERVER_ENV,
  OBSERVER_PY,
  observerAwait,
  observerDisabled,
  observerMark,
  observerScriptPath,
  observerSpawnScript,
  parseReply,
  parseSettleLog,
  type SidecarSession,
  type SettleSpec,
  settleInjectorFor,
  stopObserver,
} from "../../src/write/vectors/ui-observer.ts";
import {
  axSelectNextOccurrenceScript,
  axSelectPopupCandidatesScript,
  axSetGroupNumberScript,
  axSetRowFieldScript,
  axSetValueScript,
  axSettleOccurrencesScript,
  axPressScript,
  commandForStep,
  OK_ALREADY,
} from "../../src/write/vectors/ui.ts";
import { makeRepeatingRecipe, rescheduleRepeatRecipe } from "../../src/write/vectors/ui-recipes.ts";

const PYTHON = "/usr/bin/python3";
const HAVE_PYTHON = existsSync(PYTHON);

const SESSION: SidecarSession = {
  transport: "sidecar",
  socketPath: "/tmp/things-api-observer/s-0123abcd.sock",
  token: "0123456789abcdef0123456789abcdef",
  logPath: "/tmp/things-api-observer/observer.log",
  registered: "16/16",
  pid: 4242,
};

describe("settle replies", () => {
  it("parses an ok reply's fields", () => {
    expect(parseReply("ok seq=7 lat=5.1 fired=AXMenuOpened:AXMenu hits=1")).toEqual({
      ok: true,
      fields: { seq: "7", lat: "5.1", fired: "AXMenuOpened:AXMenu", hits: "1" },
    });
  });

  it("parses an err reply", () => {
    const reply = parseReply("err reason=timeout since=3 waited=2000 seen=0");
    expect(reply?.ok).toBe(false);
    expect(reply?.fields["reason"]).toBe("timeout");
  });

  it("refuses to read anything that is not a reply", () => {
    expect(parseReply("")).toBeNull();
    expect(parseReply("nc: unix connect failed")).toBeNull();
  });
});

describe("the settle log rides stderr and is stripped from it", () => {
  it("collects every record and leaves the operator's text alone", () => {
    const stderr = [
      "#AXSETTLE the Repeat dialog opening ~ ok seq=1 lat=441.0 fired=AXSheetCreated:AXSheet",
      "something the operator should read",
      "#AXSETTLE the field taking keyboard focus ~ err reason=timeout waited=1000",
    ].join("\n");
    const out = parseSettleLog(stderr);
    expect(out.settles).toHaveLength(2);
    expect(out.settles[0]).toContain("AXSheetCreated");
    expect(out.stderr).toBe("something the operator should read");
  });

  it("says nothing when the hop settled on nothing", () => {
    expect(parseSettleLog("plain failure").settles).toEqual([]);
    expect(parseSettleLog("plain failure").stderr).toBe("plain failure");
  });
});

describe("the off switch", () => {
  it("reads the falsey spellings as off and everything else as auto", () => {
    for (const raw of ["0", "false", "no", "off", "OFF"]) {
      expect(observerDisabled({ [OBSERVER_ENV]: raw })).toBe(true);
    }
    for (const raw of ["", "1", "true", "auto"]) {
      expect(observerDisabled({ [OBSERVER_ENV]: raw })).toBe(false);
    }
    expect(observerDisabled({})).toBe(false);
  });
});

describe("with no sidecar the scripts are the polling scripts", () => {
  const inert = inertSettleInjector();

  it("keeps every typing primitive byte-identical to its default form", () => {
    expect(axSetValueScript("text field 1", "3", 3, inert)).toBe(
      axSetValueScript("text field 1", "3"),
    );
    expect(axSetGroupNumberScript("group 1", "interval", "3", 3, 8, null, inert)).toBe(
      axSetGroupNumberScript("group 1", "interval", "3"),
    );
    expect(axSetRowFieldScript("sheet 1", "days earlier", "2", 3, 8, inert)).toBe(
      axSetRowFieldScript("sheet 1", "days earlier", "2"),
    );
  });

  it("keeps the two fixed delays the observer replaces", () => {
    const script = axSetValueScript("text field 1", "3", 3, inert);
    // 0.15 after asking for focus, 0.1 after the keystroke (FGRD1).
    expect(script).toContain("    set focused of tf to true\n    delay 0.15");
    expect(script).toContain('      keystroke "3"\n      delay 0.1');
    expect(script).not.toContain("obs");
  });

  it("keeps the pop-up's in-script menu poll and the occurrence poll", () => {
    const popup = axSelectPopupCandidatesScript("pop up button 1", ["monthly"], inert, {
      what: "x",
      want: ["AXValueChanged"],
      timeoutMs: 1000,
    });
    expect(popup).toBe(axSelectPopupCandidatesScript("pop up button 1", ["monthly"]));
    expect(popup).toContain("repeat 6 times");
    const occ = axSettleOccurrencesScript("pop up button 2 of group 1", 1200, 100, inert);
    expect(occ).toBe(axSettleOccurrencesScript("pop up button 2 of group 1"));
    expect(occ).toContain("repeat 12 times");
  });

  it("ignores a step's declared settle entirely", () => {
    const settle: SettleSpec = { what: "x", want: ["AXSheetCreated"], timeoutMs: 5000 };
    expect(axPressScript("menu item 1", inert, settle)).toBe(axPressScript("menu item 1"));
  });
});

describe("with a sidecar the scripts wait to be told", () => {
  const live = settleInjectorFor(SESSION);

  it("is inert for a null session", () => {
    expect(settleInjectorFor(null).live).toBe(false);
  });

  it("renders the await request with every part of the expectation", () => {
    const line = live.settle(
      "obsSeq",
      {
        what: "the cadence group rebuilding",
        want: ["AXValueChanged:AXPopUpButton"],
        require: ["AXValueChanged:AXPopUpButton", "AXUIElementDestroyed"],
        timeoutMs: 2000,
        quietMs: 80,
      },
      "  ",
    );
    expect(line).toContain("want=AXValueChanged:AXPopUpButton");
    expect(line).toContain("timeout=2000");
    expect(line).toContain("require=AXValueChanged:AXPopUpButton,AXUIElementDestroyed");
    expect(line).toContain("quiet=80");
    // The transport's idle timeout sits PAST the settle's budget, so what
    // expires is the settle rather than `nc`.
    expect(line).toContain(", 4, ");
  });

  it("addresses the shell locally, never through System Events", () => {
    expect(live.handlers()).toContain("tell current application to return do shell script");
    expect(live.handlers()).toContain("/usr/bin/nc -U -w ");
    expect(live.handlers()).toContain(SESSION.socketPath);
    expect(live.handlers()).toContain(SESSION.token);
  });

  it("names the observable and the off switch in the hard refusal", () => {
    expect(live.handlers()).toContain(`set ${OBSERVER_ENV}=0`);
    expect(live.handlers()).toContain("Nothing further was sent.");
  });

  it("carries on when a soft settle hears nothing, and raises when a hard one does", () => {
    const handlers = live.handlers();
    // obsWait returns the reply; obsSettle raises on anything but `ok `.
    expect(handlers).toContain("on obsWait(");
    expect(handlers).toContain("on obsSettle(");
    expect(handlers).toContain('return "err reason=nomark"');
    // BEEP1: a miss must still cost the beat the poll cost, so a soft settle
    // inside a retry loop can never become a click storm.
    expect(handlers).toContain('if r does not start with "ok " then delay 0.05');
    const soft = live.soft("obsSeq", { what: "x", want: ["AXMenuOpened"], timeoutMs: 1000 }, "");
    expect(soft.startsWith("my obsWait(")).toBe(true);
    const hard = live.settle("obsSeq", { what: "x", want: ["AXMenuOpened"], timeoutMs: 1000 }, "");
    expect(hard.startsWith("my obsSettle(")).toBe(true);
  });

  it("marks the ledger BEFORE the actuation in every settled script", () => {
    const press = axPressScript("menu item 1", live, {
      what: "the Repeat dialog opening",
      want: ["AXSheetCreated"],
      timeoutMs: 8000,
    });
    const mark = press.indexOf("set obsSeq to my obsMark()");
    const click = press.indexOf("to click (menu item 1)");
    const wait = press.indexOf("my obsWait(obsSeq");
    expect(mark).toBeGreaterThan(0);
    expect(mark).toBeLessThan(click);
    expect(click).toBeLessThan(wait);
  });

  it("waits for the field to take focus and for the keystroke to land", () => {
    const script = axSetGroupNumberScript("group 1", "interval", "3", 3, 8, null, live);
    // The two sleeps the observables replace are GONE from the typing loop. (The
    // `delay 0.1` inside cgSettle's own agreement poll is a different gate and
    // is deliberately untouched — it is the retained oracle.)
    expect(script).not.toContain("set focused of tf to true\n    delay 0.15");
    expect(script).not.toContain('keystroke "3"\n      delay 0.1');
    expect(script).toContain("want=AXFocusedUIElementChanged:AXTextField");
    expect(script).toContain("want=AXValueChanged:AXTextField");
    // The commit and the inter-attempt gap have no measured observable and stay.
    expect(script).toContain("delay 0.2");
    expect(script).toContain("delay 0.3");
    // The certified gates are untouched: prove focus, then read the value back.
    expect(script).toContain("set gotFocus to (focused of tf) as boolean");
    expect(script).toContain('if ((value of tf) as text) is "3" then return "OK"');
  });

  it("keeps BEEP1's one-click-per-round cadence and the exists verdict", () => {
    const popup = axSelectPopupCandidatesScript("pop up button 1", ["monthly"], live, {
      what: "the pop-up reporting the value this step selected",
      want: ["AXValueChanged:AXPopUpButton"],
      timeoutMs: 2000,
    });
    expect(popup).toContain("want=AXMenuOpened");
    expect(popup).toContain("if (exists menu 1 of pu) then exit repeat");
    expect(popup.match(/click pu/g)).toHaveLength(1);
    expect(popup).not.toContain("repeat 6 times");
  });
});

/**
 * THE `Next:` PRE-READ (field report 2026-09-02: "the drive opens the `Next:`
 * pop-up only to select the option that was ALREADY selected").
 *
 * Not an observer feature — a read-back-first skip that applies on every host,
 * sidecar or not, which is why it is asserted against the bare script.
 */
describe("select-next-occurrence reads before it opens", () => {
  const script = axSelectNextOccurrenceScript("pop up button 2 of group 1", "2026-09-22");

  it("reads the pop-up ONCE and returns the already-set token without opening a menu", () => {
    expect(script).toContain("set already to (value of pu) as text");
    expect(script).toContain("set alreadyYMD to my parsedYMD(already)");
    expect(script).toContain(`return "${OK_ALREADY}"`);
    // The read precedes the menu open, or it would not be saving anything.
    expect(script.indexOf("value of pu")).toBeLessThan(script.indexOf("click pu"));
    // It is one element, and it says so (RDLAT2 §E.1).
    expect(script).toContain('log "#AXELEMS 1"');
  });

  it("names the skip in the trace", () => {
    expect(script).toContain("skip reason=next-already-satisfied");
  });

  it("treats an unparseable value as the app's Today item, and only when today is wanted", () => {
    // The menu walk already takes an unparseable FIRST ITEM to be today; this is
    // the same law applied to the same control's value.
    expect(script).toContain("else if isToday then");
    expect(script).toContain('if already is not "" then set alreadySatisfied to true');
  });

  it("keeps the whole menu walk, its cascade and its fail-closed refusal", () => {
    expect(script).toContain("click menu item hit of theMenu");
    expect(script).toContain("set theMenu to deeper");
    expect(script).toContain("is not one of them");
    // And the post-click read-back that proves the selection took.
    expect(script).toContain("set shown to (value of pu) as text");
    expect(script).toContain("the selection did not take");
  });
});

describe("the recipes declare only measured observables", () => {
  const ALLOWED = new Set([
    "AXSheetCreated",
    "AXCreated:AXSheet",
    "AXWindowCreated",
    "AXValueChanged:AXPopUpButton",
  ]);

  it("settles the dialog-opening press and every dialog pop-up, and nothing else", () => {
    for (const recipe of [
      makeRepeatingRecipe("T-1", "monthly", 2, { ends: { kind: "after", count: 4 } }),
      rescheduleRepeatRecipe("T-1", "weekly", 1, { weekdays: ["monday"] }),
    ]) {
      const settled = recipe.steps.filter((s) => s.settle !== undefined);
      expect(settled.length).toBeGreaterThan(1);
      for (const step of settled) {
        expect(["press", "select-popup"]).toContain(step.primitive);
        for (const want of step.settle?.want ?? []) expect(ALLOWED.has(want)).toBe(true);
      }
      // AXLayoutChanged NEVER fires (VOPAT1-12) and no settle may name it.
      const all = JSON.stringify(recipe.steps);
      expect(all).not.toContain("AXLayoutChanged");
    }
  });

  it("leaves a menu-only recipe with nothing to observe", () => {
    const steps = makeRepeatingRecipe("T-1", "daily", 1).steps;
    expect(steps.filter((s) => s.settle !== undefined).map((s) => s.primitive)).toEqual([
      "press",
      "select-popup",
    ]);
  });

  it("compiles the same recipe to a settled script only when a sidecar is live", () => {
    const step = makeRepeatingRecipe("T-1", "daily", 1).steps.find(
      (s) => s.primitive === "press" && s.settle !== undefined,
    );
    expect(step).toBeDefined();
    const plain = commandForStep(step!, "T-1");
    const observed = commandForStep(step!, "T-1", settleInjectorFor(SESSION));
    expect(plain.script).not.toContain("obsMark");
    expect(observed.script).toContain("obsMark");
  });
});

describe("the spawn hop", () => {
  it("reads the pid itself, backgrounds python3, and bounds its lifetime", () => {
    const script = observerSpawnScript("/x/ax-observer.py", "/x/s.sock", "tok", "/x/log");
    expect(script).toContain('unix id of first application process whose name is "Things3"');
    expect(script).toContain('if pidNum is 0 then return "no-process"');
    expect(script).toContain("/usr/bin/python3");
    expect(script).toContain("--ttl-ms");
    expect(script).toContain("--idle-ms");
    // Backgrounded with no stdin, everything it says in its own log: `do shell
    // script` waits for stdout EOF, and readiness is proven by the handshake.
    expect(script).toContain("</dev/null &");
    expect(script).toContain("tell current application to do shell script cmd");
  });

  it("materializes the sidecar under a content-hashed name", () => {
    const path = observerScriptPath({ THINGS_API_STATE_DIR: "/state" });
    expect(path).toMatch(/^\/state\/observer\/ax-observer-[0-9a-f]{12}\.py$/);
    // Stable for the same source: an unchanged package rewrites nothing.
    expect(observerScriptPath({ THINGS_API_STATE_DIR: "/state" })).toBe(path);
  });
});

describe("the embedded sidecar source", () => {
  it("survives being carried in a template literal", () => {
    expect(OBSERVER_PY).not.toContain("`");
    expect(OBSERVER_PY).not.toContain("${");
    expect(OBSERVER_PY.startsWith("#!/usr/bin/env python3")).toBe(true);
  });

  it("reads no content attribute but the role", () => {
    // The one AX attribute the callback may read. A record carries a
    // notification name and a role, so nothing from the database can reach a
    // log or a trace through this path (public repo, no personal data).
    // Matched as whole QUOTED attribute names: `AXValueChanged` and
    // `AXTitleChanged` are notification classes and are expected to appear.
    for (const attr of ["AXValue", "AXTitle", "AXDescription", "AXIdentifier", "AXHelp"]) {
      expect(OBSERVER_PY).not.toContain(`"${attr}"`);
    }
    expect(OBSERVER_PY).toContain('key("AXRole")');
  });

  it("registers AXLayoutChanged even though it never fires", () => {
    // VOPAT1-12: it fired for nothing, ever. Kept registered so a future app
    // version that starts posting it appears in a trace instead of nowhere.
    expect(OBSERVER_PY).toContain('"AXLayoutChanged"');
  });

  it.skipIf(!HAVE_PYTHON)("compiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-compile-"));
    const file = join(dir, "ax-observer.py");
    writeFileSync(file, OBSERVER_PY);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(PYTHON, ["-m", "py_compile", file], { stdio: "ignore" });
      child.on("exit", resolve);
    });
    expect(code).toBe(0);
  });
});

/**
 * THE LIVE PROTOCOL, against the real sidecar with Accessibility removed
 * (`--self-test`). Events are injected through a file the pump drains, so the
 * ledger, the matcher, the ALL-OF requirement, the burst debounce, the timeout
 * and the bounded exits are all exercised for real — on any host.
 */
describe.skipIf(!HAVE_PYTHON)("the sidecar, live", () => {
  const TOKEN = "cafebabecafebabecafebabecafebabe";

  async function withSidecar(
    ttlMs: number,
    body: (session: SidecarSession, inject: (spec: string) => void) => Promise<void>,
  ): Promise<number | null> {
    const dir = mkdtempSync(join(tmpdir(), "obs-live-"));
    const file = join(dir, "ax-observer.py");
    writeFileSync(file, OBSERVER_PY);
    const socketPath = join(dir, "s.sock");
    const injectPath = join(dir, "inject");
    const child = spawn(
      PYTHON,
      [
        file,
        "--socket",
        socketPath,
        "--token",
        TOKEN,
        "--self-test",
        "--ttl-ms",
        String(ttlMs),
        "--idle-ms",
        "20000",
      ],
      {
        env: { ...process.env, THINGS_API_OBSERVER_INJECT: injectPath },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const session: SidecarSession = {
      transport: "sidecar",
      socketPath,
      token: TOKEN,
      logPath: join(dir, "log"),
      registered: "0/0",
      pid: child.pid ?? 0,
    };
    try {
      // The handshake IS the readiness proof (see startObserver).
      for (let i = 0; i < 100; i += 1) {
        if ((await observerMark(session)) !== null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await body(session, (spec) => writeFileSync(injectPath, spec));
    } finally {
      child.kill("SIGTERM");
    }
    return exited;
  }

  it("answers a mark, an await that lands, and an await that does not", async () => {
    await withSidecar(20_000, async (session, inject) => {
      const seq = await observerMark(session);
      expect(seq).not.toBeNull();

      setTimeout(() => inject("AXMenuOpened:AXMenu"), 60);
      const hit = await observerAwait(session, seq!, {
        what: "the pop-up's menu opening",
        want: ["AXMenuOpened"],
        timeoutMs: 3000,
      });
      expect(hit.ok).toBe(true);

      const seq2 = (await observerMark(session))!;
      const miss = await observerAwait(session, seq2, {
        what: "the Repeat dialog opening",
        want: ["AXSheetCreated"],
        timeoutMs: 400,
      });
      expect(miss.ok).toBe(false);
      if (!miss.ok) expect(miss.reason).toBe("timeout");
    });
  });

  it("discriminates on the ROLE, so the static text does not satisfy the pop-up's settle", async () => {
    await withSidecar(20_000, async (session, inject) => {
      const seq = (await observerMark(session))!;
      inject("AXValueChanged:AXStaticText");
      const outcome = await observerAwait(session, seq, {
        what: "the pop-up reporting the value this step selected",
        want: ["AXValueChanged:AXPopUpButton"],
        timeoutMs: 500,
      });
      expect(outcome.ok).toBe(false);
      // It SAW the arrival and refused to count it — the whole point.
      if (!outcome.ok) expect(outcome.seen).toBeGreaterThan(0);
    });
  });

  it("requires every ALL-OF class and debounces the burst before answering", async () => {
    await withSidecar(20_000, async (session, inject) => {
      const seq = (await observerMark(session))!;
      const started = Date.now();
      setTimeout(() => inject("AXValueChanged:AXPopUpButton"), 40);
      setTimeout(() => inject("AXUIElementDestroyed:AXStaticText"), 300);
      const outcome = await observerAwait(session, seq, {
        what: "the cadence group rebuilding",
        want: ["AXValueChanged:AXPopUpButton"],
        require: ["AXValueChanged:AXPopUpButton", "AXUIElementDestroyed"],
        timeoutMs: 3000,
        quietMs: 100,
      });
      expect(outcome.ok).toBe(true);
      // It cannot have answered before the second class arrived, nor before the
      // quiet window after it.
      expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    });
  });

  it("counts arrivals since a sequence without blocking", async () => {
    // The question is "did the previous step actuate anything at all?", and it
    // has to be answered without waiting to find out.
    await withSidecar(20_000, async (session, inject) => {
      const seq = (await observerMark(session))!;
      expect(await observerCount(session, seq)).toBe(0);
      inject("AXMenuOpened:AXMenu,AXMenuClosed:AXMenu");
      for (let i = 0; i < 100; i += 1) {
        if ((await observerCount(session, seq)) === 2) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await observerCount(session, seq)).toBe(2);
      // A later mark starts from zero again.
      const seq2 = (await observerMark(session))!;
      expect(await observerCount(session, seq2)).toBe(0);
    });
  });

  it("refuses an unauthorized request", async () => {
    await withSidecar(20_000, async (session) => {
      const wrong: SidecarSession = { ...session, token: "not-the-token" };
      expect(await observerMark(wrong)).toBeNull();
    });
  });

  it("exits on `stop`, and unlinks its socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-stop-"));
    const file = join(dir, "ax-observer.py");
    writeFileSync(file, OBSERVER_PY);
    const socketPath = join(dir, "s.sock");
    const child = spawn(
      PYTHON,
      [file, "--socket", socketPath, "--token", TOKEN, "--self-test", "--ttl-ms", "20000"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const session: SidecarSession = {
      transport: "sidecar",
      socketPath,
      token: TOKEN,
      logPath: join(dir, "log"),
      registered: "0/0",
      pid: child.pid ?? 0,
    };
    for (let i = 0; i < 100; i += 1) {
      if ((await observerMark(session)) !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await stopObserver(session)).toBe(true);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("reaps itself on its TTL even if nobody ever says stop", async () => {
    // The property that makes a backgrounded observer safe: it cannot outlive
    // its drive, whatever happens to the drive.
    const code = await withSidecar(700, async (session) => {
      expect(await observerMark(session)).not.toBeNull();
      await new Promise((r) => setTimeout(r, 1500));
      expect(await observerMark(session)).toBeNull();
    });
    expect(code).toBe(0);
  });
});
