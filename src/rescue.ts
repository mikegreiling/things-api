/**
 * `things rescue` — the headless emergency surface for un-sticking Things
 * (issue #640).
 *
 * WHY THIS EXISTS. Things can reach a state where the app is up, answering, and
 * unusable to automation, with no scripted way back. Three measured behaviours
 * converge on it:
 *
 *   - a standing modal sheet EMPTIES the app's top-level AppleScript collections
 *     (oddities §25 / MODALX1), so `delete` reports `-1728 Can't get to do id` on
 *     a row the database holds open — issue #620's "ghost clone", which has no
 *     second cause;
 *   - a standing sheet GATES Things Cloud sync entirely (oddities §24), so writes
 *     land locally and silently never leave the Mac;
 *   - a Repeat dialog opened while Things is BACKGROUNDED becomes a detached
 *     window that nothing dismisses (oddities §26 / DRVLAT1 §5) — not its own
 *     Cancel, not Escape, not ⌘W, not a real HID click at its Cancel frame.
 *
 * The shipped driver never creates the third state (every dialog recipe
 * activates Things first, which is exactly why that step is permanent), but a
 * killed client, a harness tool-timeout or a person walking away mid-dialog can
 * all leave the first two. {@link rescueStatus} reports them; the other two
 * verbs act on them. This is the single home for both halves — the read-only
 * census that was once the top-level `ui-state` command lives here now.
 *
 * THE THREE VERBS, separated by what they can cost you:
 *
 *   - {@link rescueStatus}   free, ungated, read-only — the census + the lock
 *                            table + a "we must not touch that" verdict;
 *   - {@link rescueDismiss}  gated two ways — presses ONE dialog's own Cancel;
 *   - {@link rescueRelaunch} gated two ways — ends the process and starts it
 *                            again, the only cure measured for oddities §26.
 *
 * PERMISSIONS DOCTRINE. Nothing here raises a macOS consent dialog. The screen
 * is read behind the prompt-free capability verdict, exactly as `doctor
 * --ui-state` reads it, and a machine that has not granted the access is TOLD so
 * rather than
 * prompted. {@link rescueRelaunch} is the deliberate exception to needing that
 * grant at all — see its own note.
 *
 * TWO consent classes are in play here, not one, and #664 was what happens when
 * only the first is remembered. The GUI grant covers the census and the polite
 * quit; the app-data grant covers the group container, which the post-relaunch
 * database check reaches. They are held by different things and are missing
 * independently, so each touch is gated on its own verdict — see
 * {@link realSchemaStatus}.
 */
import { createAuditWriter, type AuditWriter } from "./audit/log.ts";
import type { AuditRecord } from "./audit/schema.ts";
import {
  directContainerAccessAllowed,
  readAllowed,
  readCapability,
  uiAllowed,
  uiCapability as uiCapabilityDefault,
  type UiCapability,
} from "./capability.ts";
import { loadConfig, type Profile } from "./config.ts";
import { PKG_VERSION } from "./contracts.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, ThingsDbOpenError } from "./db/connection.ts";
import { compareToBaseline, observeSchema } from "./db/fingerprint.ts";
import { locateThingsDb, ThingsDbNotFoundError } from "./db/locate.ts";
import { createDeputyDbFacade } from "./deputy/db-facade.ts";
import { deputyDbPath, deputyRoutesDb } from "./deputy/routing.ts";
import { auditDir, mutationLockPath } from "./paths.ts";
import { formatHeldFor, readLockHolder } from "./write/lock.ts";
import {
  censusUnverifiable,
  describeUiState,
  describeUnprovenProbes,
  SYNC_GATE_WARNING,
  THINGS_PROCESS,
  type UiProbe,
  type UiState,
} from "./write/vectors/ui-state.ts";
import {
  axCancelDialogScript,
  axCancelFrameScript,
  defaultUiRunner,
  parseFrameCenter,
  readLiveUiState,
  uiClickPointCommand,
  type UiRunner,
} from "./write/vectors/ui.ts";
import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- timings

/**
 * Budget for the AppleScript `quit` rung. A standing sheet swallows ⌘Q, and the
 * scripting `quit` verb can itself block behind one — which is the whole reason
 * this rung is bounded rather than awaited. Short on purpose: the rungs under it
 * cost nothing and always work.
 */
const QUIT_TIMEOUT_MS = 6_000;

/** How long each rung of the kill ladder waits for the process to actually go. */
const DEATH_WAIT_MS = 5_000;

/** How long to wait for a relaunched Things to be answering again. */
const RELAUNCH_WAIT_MS = 45_000;

/** Poll interval for every "has it happened yet" loop in this module. */
const POLL_MS = 250;

/** Per-hop budget for the two Cancel scripts (resolve + press). */
const CANCEL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- the seams

/** What a relaunch could establish about the database it left behind. */
export interface RescueSchemaVerdict {
  /**
   * Was the check performed at all? False on a host with no standing to open
   * the group container — the relaunch still happens, the check is skipped, and
   * `detail` says so (issue #664).
   */
  checked: boolean;
  /** Did the database open and read as a shape this build understands? Null when unchecked. */
  ok: boolean | null;
  /** One sentence, for the report. */
  detail: string;
}

/**
 * Every side-effecting thing this module does, injectable. Production defaults
 * are the real ones; the unit suite substitutes all of them, which is what makes
 * the gating, the refusals and the kill ladder testable without an app.
 */
export interface RescueDeps {
  /** The prompt-free GUI capability verdict. */
  uiCapability?: () => UiCapability;
  /** The osascript / reveal dispatch seam — the same transport the drive uses. */
  run?: UiRunner;
  /** Process environment, for config, the lock path and the change-history directory. */
  env?: NodeJS.ProcessEnv;
  /** Where a rescue ACTION records what it did. */
  audit?: AuditWriter;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  /** Which pids Things is running as, newest first; empty when it is not running. */
  thingsPids?: () => Promise<number[]>;
  /** Signal one pid. Never throws for a pid that has already gone. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Start Things in the BACKGROUND — we do not steal the screen to fix the screen. */
  launch?: () => Promise<{ ok: boolean; detail: string }>;
  /** Read the database's own verdict, for the post-relaunch check. */
  schemaStatus?: () => RescueSchemaVerdict;
  sleep?: (ms: number) => Promise<void>;
}

interface Resolved {
  uiCapability: () => UiCapability;
  run: UiRunner;
  env: NodeJS.ProcessEnv;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  thingsPids: () => Promise<number[]>;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  launch: () => Promise<{ ok: boolean; detail: string }>;
  schemaStatus: () => RescueSchemaVerdict;
  sleep: (ms: number) => Promise<void>;
  audit: AuditWriter | null;
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((settle) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      settle({ ok: err === null, out: String(stdout ?? "").trim() });
    });
  });
}

/** `pgrep -x Things3` — the process table, asked by name, costing no grant. */
async function livePids(): Promise<number[]> {
  const res = await run("/usr/bin/pgrep", ["-x", THINGS_PROCESS], 5_000);
  if (!res.ok) return []; // pgrep exits 1 when nothing matches
  return res.out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The post-relaunch database check — and the one place in this module that
 * touches the group container at all.
 *
 * IT IS AN ENRICHMENT, NEVER THE JOB (issue #664). `rescue relaunch` exists to
 * end a wedged Things and start it again; whether the database still reads as a
 * known shape afterwards is worth saying and is worth nothing at the price of
 * the verb. So the container is opened only behind a prompt-free standing that
 * already covers it, and a host without one is TOLD the check was skipped.
 *
 * What went wrong without this gate: `locateThingsDb()` globs and stats inside
 * `~/Library/Group Containers/JLMPQHK86H.…`, and `openConnection()` opens the
 * database there. Both are `kTCCServiceSystemPolicyAppData` accesses. From a
 * host app holding Full Disk Access — every terminal this project was ever
 * developed in — macOS answers them silently. From a host app without it (the
 * report was an MCP/agent runner) the FIRST of them raises the "access data
 * from other apps" modal outside any ceremony, which is an Article I violation
 * on its own; and because that class PARKS the syscall in the kernel until the
 * dialog is answered, the command that was already past the point of relaunch
 * simply never returned. One missing gate, both halves of the report.
 *
 * Three ways it can be answered, in the order they are consulted:
 *
 *   - the helpers are serving — the reader opens the database under its own
 *     bookmark grant and we never touch the container (full behavior);
 *   - this process's own standing covers the container (Full Disk Access, a
 *     live session grant, or an explicit path) — open it locally, as before;
 *   - otherwise — skip, and report the skip.
 */
function unchecked(why: string): RescueSchemaVerdict {
  return { checked: false, ok: null, detail: `the database was not checked — ${why}` };
}

function realSchemaStatus(env: NodeJS.ProcessEnv = process.env): RescueSchemaVerdict {
  const standing = readCapability({}, { env });
  if (!readAllowed(standing)) return unchecked(standing.detail);

  // The reader's own path when it is serving; null when this process must open
  // the file itself — and then only on a standing that covers its own syscalls.
  const routed = deputyRoutesDb(undefined, env) ? deputyDbPath(env) : null;
  if (routed === null && !directContainerAccessAllowed(standing)) {
    return unchecked(standing.detail);
  }

  let path: string;
  try {
    path = routed ?? locateThingsDb().path;
  } catch (err) {
    return {
      checked: true,
      ok: false,
      detail:
        err instanceof ThingsDbNotFoundError
          ? "the Things database could not be found"
          : "the Things database could not be located",
    };
  }
  let conn: { db: DatabaseSync; close: () => void };
  try {
    conn =
      routed !== null ? { db: createDeputyDbFacade(env), close: () => {} } : openConnection(path);
  } catch (err) {
    return {
      checked: true,
      ok: false,
      detail:
        err instanceof ThingsDbOpenError
          ? "the Things database is there but would not open yet"
          : "the Things database would not open",
    };
  }
  try {
    const status = compareToBaseline(observeSchema(conn.db), BASELINES);
    return status.kind === "ok"
      ? {
          checked: true,
          ok: true,
          detail: "the database opened and reads as the shape this version expects",
        }
      : {
          checked: true,
          ok: false,
          detail: "the database opened but no longer matches the shape this version expects",
        };
  } finally {
    conn.close();
  }
}

function resolve(deps: RescueDeps): Resolved {
  const env = deps.env ?? process.env;
  return {
    uiCapability: deps.uiCapability ?? (() => uiCapabilityDefault()),
    run: deps.run ?? defaultUiRunner,
    env,
    now: deps.now ?? Date.now,
    pidAlive:
      deps.pidAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    thingsPids: deps.thingsPids ?? livePids,
    signal:
      deps.signal ??
      ((pid, sig) => {
        try {
          process.kill(pid, sig);
        } catch {
          // already gone — that is the outcome we wanted
        }
      }),
    launch:
      deps.launch ??
      (async () => {
        const res = await run("/usr/bin/open", ["-g", "-a", THINGS_PROCESS], 15_000);
        return {
          ok: res.ok,
          detail: res.ok ? "Things was started in the background" : "Things would not start",
        };
      }),
    schemaStatus: deps.schemaStatus ?? (() => realSchemaStatus(env)),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    audit:
      deps.audit ??
      (() => {
        const config = loadConfig(env);
        return config.auditEnabled
          ? createAuditWriter({ dir: auditDir(env), secrets: [], enabled: true })
          : null;
      })(),
  };
}

// ------------------------------------------------------------------ status

/**
 * A modal that is NOT ours. `inspectable: false` is the signature of a secure
 * system modal — a macOS privacy/consent dialog, which belongs to no
 * application's Accessibility tree and which no rescue verb may ever press a
 * button on. It is reported so the operator knows to look at the screen, and so
 * they know the refusal that follows is deliberate rather than a failure.
 */
export interface RescueForeignModal {
  /** The application that owns the screen, or null when even that could not be read. */
  owner: string | null;
  detail: string;
}

/** The mutation lock, as `rescue status` reports it. Read-only, always. */
export interface RescueLockView {
  path: string;
  held: boolean;
  pid: number | null;
  /** ISO instant the holder took it. */
  since: string | null;
  /** Human age ("4m 12s"), or null when it could not be computed. */
  heldFor: string | null;
  /** Does a process with that pid still exist? */
  alive: boolean;
  /** Alive AND older than any change takes — old enough to say so. */
  suspect: boolean;
  detail: string;
}

export interface RescueStatusReport {
  /** Could the screen be read at all on this machine? */
  screenReadable: boolean;
  /** One sentence: the census summary, or the reason there is none. */
  detail: string;
  /** The census; null when it could not be read. */
  state: UiState | null;
  lock: RescueLockView;
  /** Set when something we must not touch owns the screen. */
  foreignModal: RescueForeignModal | null;
  /** Consequences worth stating — the open-dialog sync gate. */
  warnings: string[];
  /** What to do next, including which rescue verb applies. */
  remediation: string[];
}

/**
 * Read everything a stuck machine can be asked about, without touching any of
 * it. Never throws and never refuses: the cases this exists for are exactly the
 * ones where something is already wrong, so every failure is a REPORTED state.
 */
export async function rescueStatus(deps: RescueDeps = {}): Promise<RescueStatusReport> {
  const d = resolve(deps);
  const path = mutationLockPath(d.env);
  const holder = readLockHolder(path, { pidAlive: d.pidAlive, now: d.now });
  const lock: RescueLockView = {
    path,
    held: holder.holder !== null,
    pid: holder.holder?.pid ?? null,
    since: holder.holder?.ts ?? null,
    heldFor: holder.heldForMs === null ? null : formatHeldFor(holder.heldForMs),
    alive: holder.alive,
    suspect: holder.suspect,
    detail:
      holder.holder === null
        ? "no change is holding the lock"
        : holder.alive
          ? `pid ${holder.holder.pid} has held it${
              holder.heldForMs === null ? "" : ` for ${formatHeldFor(holder.heldForMs)}`
            }${
              holder.suspect
                ? " — far longer than any change takes; that process may be hung, and killing it releases the lock"
                : ""
            }`
          : `pid ${holder.holder.pid} holds it but is no longer running — the next change takes it`,
  };

  const capability = d.uiCapability();
  if (!uiAllowed(capability)) {
    return {
      screenReadable: false,
      detail: `the Things window cannot be read on this machine — ${capability.detail}`,
      state: null,
      lock,
      foreignModal: null,
      warnings: [],
      remediation: capability.remediation,
    };
  }

  const state = await readLiveUiState(d.run);
  if (state === null) {
    return {
      screenReadable: true,
      detail:
        "the window and focus state could not be read — Things may have stopped answering, or a " +
        "system dialog is covering the screen",
      state: null,
      lock,
      foreignModal: null,
      warnings: [],
      remediation: [
        "look at the screen: a macOS privacy or consent dialog is not exposed to any app and has " +
          "to be answered by hand",
        "if Things itself has stopped answering, `things rescue relaunch` ends it and starts it again",
      ],
    };
  }

  const foreignModal: RescueForeignModal | null = state.inspectable
    ? null
    : {
        owner: state.frontmostApp,
        detail:
          "a system dialog owns the screen — macOS does not expose it to other apps, so nothing " +
          `here can identify or close it${
            state.frontmostApp === null ? "" : ` (frontmost application: ${state.frontmostApp})`
          }`,
      };

  return {
    screenReadable: true,
    detail: describeUiState(state),
    state,
    lock,
    foreignModal,
    warnings: state.sheetOpen ? [SYNC_GATE_WARNING] : [],
    remediation: statusAdvice(state, foreignModal, lock),
  };
}

/** What the operator should do, given everything the census and the lock proved. */
function statusAdvice(
  state: UiState,
  foreignModal: RescueForeignModal | null,
  lock: RescueLockView,
): string[] {
  const next: string[] = [];
  if (foreignModal !== null) {
    next.push(
      "answer that dialog at the screen — no rescue command will press a button on a dialog it " +
        "cannot identify, and this one belongs to macOS rather than to Things",
    );
  } else if (censusUnverifiable(state)) {
    next.push(
      `part of the screen read did not answer (${describeUnprovenProbes(state)}) — run this ` +
        "again, and if it keeps happening `things rescue relaunch` ends Things and starts it again",
    );
  } else if (state.sheetOpen) {
    if (state.sheetKind === "other") {
      next.push(
        "the open dialog is not one this command recognizes, so it will not press its buttons — " +
          "close it at the screen, or run `things rescue relaunch` to end Things and start it again",
      );
    } else {
      next.push(
        "`things rescue dismiss` closes the dialog in front by pressing its own Cancel button" +
          (state.sheetDepth > 1
            ? `; ${state.sheetDepth} are stacked, and each one needs its own invocation`
            : ""),
      );
    }
    if (state.sheetForm === "detached") {
      next.push(
        "this dialog is the detached kind, which has been measured to ignore every way of closing " +
          "it — expect `things rescue dismiss` to report that it is still there, and use " +
          "`things rescue relaunch`",
      );
    }
  }
  if (lock.suspect) {
    next.push(
      `the change lock has been held by pid ${lock.pid} for ${lock.heldFor ?? "a long time"}; if ` +
        `that process is hung, \`kill ${lock.pid}\` releases it`,
    );
  }
  return next;
}

// ----------------------------------------------------------------- dismiss

export type RescueDismissOutcome =
  /** Nothing was stranded — no dialog was open. */
  | "no-dialog"
  /** Cancel was pressed and the dialog is confirmed gone. */
  | "dismissed"
  /** Cancel was pressed and the dialog is demonstrably still there (oddities §26). */
  | "still-open"
  /** Cancel was pressed and the screen could not be re-read to confirm either way. */
  | "unverified"
  /** Nothing was pressed. */
  | "refused";

export interface RescueDismissResult {
  outcome: RescueDismissOutcome;
  /** Which press worked, when one did. */
  how: "cancel-button" | "cancel-click" | null;
  before: UiState | null;
  after: UiState | null;
  /** Dialogs still stacked after this one; null when it could not be re-read. */
  levelsRemaining: number | null;
  detail: string;
  remediation: string[];
  notes: string[];
  warnings: string[];
}

/** The two keys `rescue dismiss` needs, spelled the way each surface spells them. */
export interface RescueDismissAck {
  /** `--dangerously-dismiss-dialog`. */
  dangerouslyDismissDialog?: boolean;
}

/**
 * Close the dialog IN FRONT by pressing its own Cancel button — FGRD2's proven
 * Cancel, generalized off the drive's abort path and onto a dialog no drive
 * opened.
 *
 * EXACTLY ONE LIFO LEVEL PER INVOCATION. Sheets nest as `AXSheet` children of
 * the sheet below and dismiss strictly last-in-first-out (MODALX1 §6). A loop
 * that cleared a whole stack in one command would be a loop pressing an unknown
 * number of buttons on an unknown number of dialogs; instead this closes the top
 * one, re-reads, and reports how many remain so the caller decides.
 *
 * PROVEN, never assumed. The press reporting success is NOT closure: the
 * detached editor of oddities §26 accepts an AXPress on its Cancel and stays
 * exactly where it is. Closure is decided by a fresh census showing the stack one
 * level shorter, and an unconfirmable press is reported as unconfirmed.
 *
 * WHAT IT CAN COST YOU: the dialog's own pending edits, and nothing else. The
 * database is untouched, and a URL command parked behind a consent sheet is
 * discarded with it (URLEN1).
 */
export async function rescueDismiss(
  ack: RescueDismissAck = {},
  deps: RescueDeps = {},
): Promise<RescueDismissResult> {
  const d = resolve(deps);
  const startedAt = new Date(d.now());

  const refuse = (detail: string, remediation: string[], before: UiState | null = null) => {
    const result: RescueDismissResult = {
      outcome: "refused",
      how: null,
      before,
      after: null,
      levelsRemaining: before?.sheetDepth ?? null,
      detail,
      remediation,
      notes: [],
      warnings: before?.sheetOpen === true ? [SYNC_GATE_WARNING] : [],
    };
    return result;
  };

  if (ack.dangerouslyDismissDialog !== true) {
    return refuse(
      "this closes a dialog that is open in Things, discarding whatever was typed into it",
      [
        "pass dangerouslyDismissDialog (--dangerously-dismiss-dialog) to proceed",
        "run `things rescue status` first to see what is open",
      ],
    );
  }
  const capability = d.uiCapability();
  if (!uiAllowed(capability)) {
    return refuse(
      `the Things window cannot be reached on this machine — ${capability.detail}`,
      capability.remediation,
    );
  }

  const before = await readLiveUiState(d.run);
  if (before === null || censusUnverifiable(before)) {
    return refuse(
      before === null
        ? "the window state could not be read, so there is no way to know which dialog a Cancel " +
            "would land on — nothing was pressed"
        : `the window state could not be established (${describeUnprovenProbes(before)}), so ` +
            "there is no way to know which dialog a Cancel would land on — nothing was pressed",
      [
        "run `things rescue status` and try again once the screen reads cleanly",
        "if it will not, `things rescue relaunch` ends Things and starts it again",
      ],
      before,
    );
  }
  if (!before.inspectable) {
    return refuse(
      "a system dialog owns the screen — macOS does not expose it to other apps, so nothing here " +
        `can identify it, and nothing here will press its buttons${
          before.frontmostApp === null ? "" : ` (frontmost application: ${before.frontmostApp})`
        }`,
      ["answer that dialog at the screen; it belongs to macOS, not to Things"],
      before,
    );
  }
  if (!before.sheetOpen) {
    return {
      outcome: "no-dialog",
      how: null,
      before,
      after: before,
      levelsRemaining: 0,
      detail: "no dialog is open in Things — nothing was stranded and nothing was pressed",
      remediation: [],
      notes: [],
      warnings: [],
    };
  }
  if (before.sheetKind === "other") {
    return refuse(
      "the dialog in front is not one this command recognizes, and it will not press buttons on a " +
        "dialog it cannot identify",
      [
        "close it at the screen if you can see it",
        "otherwise `things rescue relaunch` ends Things and starts it again",
      ],
      before,
    );
  }

  // --- press its own Cancel, then PROVE it.
  const notes: string[] = [];
  const pressed = await d.run(
    {
      primitive: "resolve",
      label: "press the open dialog's Cancel button",
      script: axCancelDialogScript(),
    },
    CANCEL_TIMEOUT_MS,
  );
  const verdict = pressed.stdout.trim();
  if (pressed.ok && verdict === "NO-CANCEL") {
    return refuse(
      "the dialog in front has no Cancel button, so there is nothing here to press",
      ["`things rescue relaunch` ends Things and starts it again"],
      before,
    );
  }
  if (pressed.ok && verdict === "NO-DIALOG") {
    const after = await readLiveUiState(d.run);
    return {
      outcome: "no-dialog",
      how: null,
      before,
      after,
      levelsRemaining: after?.sheetDepth ?? null,
      detail: "the dialog closed on its own between reading the screen and pressing Cancel",
      remediation: [],
      notes: [],
      warnings: after?.sheetOpen === true ? [SYNC_GATE_WARNING] : [],
    };
  }

  let after = await readLiveUiState(d.run);
  let how: "cancel-button" | "cancel-click" | null =
    pressed.ok && verdict === "OK" ? "cancel-button" : null;

  // The synthesized-click fallback, on the same button, resolved by address.
  if (!closedOneLevel(before, after)) {
    notes.push("its Cancel button did not close it, so the button was clicked at its own position");
    const frame = await d.run(
      { primitive: "resolve", label: "find the Cancel button", script: axCancelFrameScript() },
      CANCEL_TIMEOUT_MS,
    );
    const center = frame.ok ? parseFrameCenter(frame.stdout) : null;
    if (center !== null) {
      await d.run(
        uiClickPointCommand(center.x, center.y, "click the open dialog's Cancel button"),
        CANCEL_TIMEOUT_MS,
      );
      after = await readLiveUiState(d.run);
      if (closedOneLevel(before, after)) how = "cancel-click";
    }
  }

  const result = judgeDismissal(before, after, how, notes);
  recordRescue(d, {
    op: "rescue.dismiss",
    startedAt,
    result: result.outcome === "dismissed" ? "ok" : `blocked:${result.outcome}`,
    requested: { dangerouslyDismissDialog: true },
    pre: censusRecord(before),
    observed: after === null ? null : censusRecord(after),
  });
  return result;
}

/**
 * Did the stack get exactly one level shorter? This — not "the press returned
 * OK", and not "no sheet is open" — is what closure means here: dismissing the
 * top of a stack of two correctly leaves one standing, and a press that reported
 * success against the §26 detached editor changes nothing at all.
 */
function closedOneLevel(before: UiState, after: UiState | null): boolean {
  if (after === null || censusUnverifiable(after) || !after.inspectable) return false;
  return after.sheetDepth < before.sheetDepth;
}

function judgeDismissal(
  before: UiState,
  after: UiState | null,
  how: "cancel-button" | "cancel-click" | null,
  notes: string[],
): RescueDismissResult {
  const levelsRemaining = after === null ? null : after.sheetDepth;
  if (closedOneLevel(before, after) && after !== null) {
    const remaining = after.sheetDepth;
    return {
      outcome: "dismissed",
      how,
      before,
      after,
      levelsRemaining: remaining,
      detail:
        remaining === 0
          ? "the dialog was closed and no dialog is open in Things"
          : `the dialog in front was closed; ${remaining} still open underneath it`,
      remediation:
        remaining === 0
          ? []
          : ["run `things rescue dismiss` again to close the next one — they close one at a time"],
      notes,
      warnings: remaining === 0 ? [] : [SYNC_GATE_WARNING],
    };
  }
  if (after === null || censusUnverifiable(after) || !after.inspectable) {
    return {
      outcome: "unverified",
      how: null,
      before,
      after,
      levelsRemaining,
      detail:
        "Cancel was pressed, and the screen could not be read afterwards — so whether the dialog " +
        "closed is unknown, and this reports that rather than assuming it",
      remediation: [
        "run `things rescue status` to see the current state",
        "if the dialog is still there, `things rescue relaunch` ends Things and starts it again",
      ],
      notes,
      warnings: [SYNC_GATE_WARNING],
    };
  }
  return {
    outcome: "still-open",
    how: null,
    before,
    after,
    levelsRemaining,
    detail:
      "Cancel was pressed, both by the button and at its position on screen, and the dialog is " +
      "still open" +
      (before.sheetForm === "detached"
        ? " — this is the detached kind of dialog, which has been measured to ignore every way of " +
          "closing it"
        : ""),
    remediation: [
      "`things rescue relaunch` ends Things and starts it again — it is the only thing measured to " +
        "clear this",
    ],
    notes,
    warnings: [SYNC_GATE_WARNING],
  };
}

// ---------------------------------------------------------------- relaunch

export type RescueRelaunchOutcome = "relaunched" | "refused" | "failed";

export interface RescueRelaunchResult {
  outcome: RescueRelaunchOutcome;
  /** Which rung actually ended the process. */
  endedBy: "quit" | "sigterm" | "sigkill" | "not-running" | null;
  before: UiState | null;
  after: UiState | null;
  /** The step-by-step account of the ladder, always present. */
  ladder: string[];
  detail: string;
  remediation: string[];
  notes: string[];
  warnings: string[];
}

/** The keys `rescue relaunch` needs. The second one is profile-dependent. */
export interface RescueRelaunchAck {
  /** `--yes`. */
  yes?: boolean;
  /** `--dangerously-force-quit`; required only under the `workstation` profile. */
  dangerouslyForceQuit?: boolean;
}

/**
 * End Things and start it again — the nuclear rung, and the ONLY cure this
 * project has measured for the detached editor of oddities §26. DRVLAT1 §5 tried
 * every other route against the same live dialog (its own Cancel backgrounded,
 * foregrounded and after `AXRaise`; Escape; ⌘W then re-activate; a real HID click
 * at the AX-resolved Cancel frame) and every one was inert.
 *
 * THE LADDER, each rung bounded:
 *
 *   1. ask Things to quit through its own scripting interface. Bounded, because
 *      a standing sheet swallows ⌘Q and the `quit` verb can block behind one.
 *   2. SIGTERM, and wait for the process to go.
 *   3. SIGKILL — the lab's canonical reset for a modal that will not clear.
 *   4. start it again in the BACKGROUND: we do not steal the screen to fix the
 *      screen.
 *   5. prove it: the process is answering, the database still reads as the shape
 *      this version expects, and no dialog is open.
 *
 * WHAT IS LOST: the Things database is write-ahead-logged, so everything already
 * committed survives a kill unconditionally. The ceiling is what was never
 * committed — the edits sitting in the dialog being destroyed.
 *
 * WHAT COMES BACK: sync. While a dialog stands, Things stops sending changes to
 * Things Cloud (oddities §24); killing the dialog with the process releases that,
 * and everything written on this Mac in the meantime goes out.
 *
 * DELIBERATELY NOT GATED ON THE GUI CAPABILITY. Every other verb that touches the
 * app needs the GUI grant, because it synthesizes input into someone's window.
 * This one signals a process the user already owns, which needs no grant at all —
 * and the machines that need it most are exactly the ones where the Accessibility
 * path is what broke. The quit rung and the census still run through the granted
 * seam when it is available, and are skipped without complaint when it is not.
 */
export async function rescueRelaunch(
  ack: RescueRelaunchAck = {},
  deps: RescueDeps = {},
): Promise<RescueRelaunchResult> {
  const d = resolve(deps);
  const startedAt = new Date(d.now());
  const profile: Profile = loadConfig(d.env).profile;
  const ladder: string[] = [];

  const refuse = (detail: string, remediation: string[]): RescueRelaunchResult => ({
    outcome: "refused",
    endedBy: null,
    before: null,
    after: null,
    ladder,
    detail,
    remediation,
    notes: [],
    warnings: [],
  });

  if (ack.yes !== true) {
    return refuse(
      "this ends the Things application and starts it again; anything typed into an open dialog " +
        "and not yet saved is discarded",
      [
        "pass --yes to proceed",
        "run `things rescue status` first, and `things rescue dismiss` if the dialog will close on its own",
      ],
    );
  }
  if (profile === "workstation" && ack.dangerouslyForceQuit !== true) {
    return refuse(
      "this machine is configured as a workstation, where someone may be sitting in front of the " +
        "dialog this would destroy",
      [
        "pass --dangerously-force-quit as well to proceed",
        "or set `things config set profile dedicated-server` on a machine nobody is sitting at",
      ],
    );
  }

  const capable = uiAllowed(d.uiCapability());
  const before = capable ? await readLiveUiState(d.run) : null;
  ladder.push(
    before === null
      ? capable
        ? "the screen could not be read before starting"
        : "the screen was not read (this machine has not granted the access; it is not needed for this)"
      : `before: ${describeUiState(before)}`,
  );

  // Rung 1 — ask nicely, on a short leash.
  let pids = await d.thingsPids();
  let endedBy: RescueRelaunchResult["endedBy"] = null;
  if (pids.length === 0) {
    endedBy = "not-running";
    ladder.push("Things was not running");
  } else {
    if (capable) {
      const quit = await d.run(
        {
          primitive: "resolve",
          label: "ask Things to quit",
          script: `tell application "${THINGS_PROCESS}" to quit`,
        },
        QUIT_TIMEOUT_MS,
      );
      ladder.push(quit.ok ? "asked Things to quit" : "asked Things to quit — it did not answer");
    } else {
      ladder.push(
        "skipped asking Things to quit (that needs an access this machine has not granted)",
      );
    }
    if (await waitForDeath(d, DEATH_WAIT_MS)) {
      endedBy = "quit";
      ladder.push("it quit on its own");
    }
  }

  // Rungs 2 and 3 — SIGTERM, then SIGKILL.
  for (const [sig, label] of [
    ["SIGTERM", "sigterm"],
    ["SIGKILL", "sigkill"],
  ] as const) {
    if (endedBy !== null) break;
    pids = await d.thingsPids();
    if (pids.length === 0) break;
    for (const pid of pids) d.signal(pid, sig);
    ladder.push(`sent ${sig} to ${pids.map((p) => `pid ${p}`).join(", ")}`);
    if (await waitForDeath(d, DEATH_WAIT_MS)) {
      endedBy = label;
      ladder.push("the process ended");
    }
  }

  if (endedBy === null && (await d.thingsPids()).length > 0) {
    return {
      outcome: "failed",
      endedBy: null,
      before,
      after: null,
      ladder,
      detail: "Things would not end, even when killed — nothing was restarted",
      remediation: [
        "quit it from the Force Quit window (⌥⌘⎋) or restart the Mac",
        "this should not happen; it is worth reporting",
      ],
      notes: [],
      warnings: [],
    };
  }

  // Rung 4 — start it again, in the background.
  const launched = await d.launch();
  ladder.push(launched.detail);
  if (!launched.ok) {
    return {
      outcome: "failed",
      endedBy,
      before,
      after: null,
      ladder,
      detail: "Things was ended but would not start again",
      remediation: ["start Things by hand, then run `things rescue status` to confirm it is clear"],
      notes: [],
      warnings: [],
    };
  }

  // Rung 5 — prove it came back clean.
  const after = capable ? await waitForHealthy(d) : null;
  const schema = d.schemaStatus();
  ladder.push(schema.detail);
  const notes = [
    "everything already saved survived: only what was typed into the open dialog and not saved is gone",
    "Things sends changes to Things Cloud again now that no dialog is standing",
  ];
  const back = after !== null && after.thingsRunning && !after.sheetOpen;
  ladder.push(
    after === null
      ? capable
        ? "the screen could not be read after starting"
        : "the screen was not read after starting"
      : `after: ${describeUiState(after)}`,
  );

  const result: RescueRelaunchResult = {
    outcome: "relaunched",
    endedBy,
    before,
    after,
    ladder,
    detail: back
      ? "Things was ended and started again, and no dialog is open"
      : after !== null && after.sheetOpen
        ? "Things was ended and started again, and a dialog is open again"
        : "Things was ended and started again; whether a dialog is open could not be confirmed from here",
    remediation:
      back && schema.ok !== false ? [] : ["run `things rescue status` to see the current state"],
    notes,
    // Only a check that RAN can fail. A SKIPPED one is a gap in what we know,
    // not a finding about the database — and rendering an unmeasured default as
    // a measurement beside rows that were measured is exactly the mistake #629
    // already cost us once.
    warnings:
      schema.ok === false
        ? [
            "the Things database no longer reads as the shape this version expects — run `things doctor`",
          ]
        : [],
  };
  recordRescue(d, {
    op: "rescue.relaunch",
    startedAt,
    result: "ok",
    requested: {
      yes: true,
      ...(ack.dangerouslyForceQuit === true && { dangerouslyForceQuit: true }),
    },
    pre: before === null ? null : censusRecord(before),
    observed: {
      ...(after === null ? {} : censusRecord(after)),
      endedBy: endedBy ?? "unknown",
      schemaChecked: schema.checked,
      schemaOk: schema.ok,
    },
  });
  return result;
}

/** Poll until no Things process is left, or the budget runs out. */
async function waitForDeath(d: Resolved, budgetMs: number): Promise<boolean> {
  const deadline = d.now() + budgetMs;
  for (;;) {
    if ((await d.thingsPids()).length === 0) return true;
    if (d.now() >= deadline) return false;
    await d.sleep(POLL_MS);
  }
}

/** Poll until the relaunched app is answering the census, or the budget runs out. */
async function waitForHealthy(d: Resolved): Promise<UiState | null> {
  const deadline = d.now() + RELAUNCH_WAIT_MS;
  let last: UiState | null = null;
  for (;;) {
    last = await readLiveUiState(d.run);
    if (last !== null && last.thingsRunning && !censusUnverifiable(last)) return last;
    if (d.now() >= deadline) return last;
    await d.sleep(POLL_MS);
  }
}

// ------------------------------------------------------------ the record

/**
 * The census as a change-history payload. ROLE COUNTS and kinds only — never a
 * control's value and never a window title, exactly as the census itself
 * promises (a stranded Repeat sheet is showing the user's own to-do text).
 */
function censusRecord(state: UiState): Record<string, unknown> {
  return {
    sheetOpen: state.sheetOpen,
    sheetKind: state.sheetKind,
    sheetForm: state.sheetForm,
    sheetDepth: state.sheetDepth,
    sheetControls: state.sheetControls,
    thingsRunning: state.thingsRunning,
    thingsFrontmost: state.thingsFrontmost,
    frontmostApp: state.frontmostApp,
    inspectable: state.inspectable,
  };
}

/**
 * Record what a rescue ACTION did. `status` records nothing — it changes
 * nothing. Best-effort by construction: the writer never throws, and a machine
 * that cannot write its history is still a machine that needed rescuing.
 */
function recordRescue(
  d: Resolved,
  fields: {
    op: string;
    startedAt: Date;
    result: AuditRecord["result"];
    requested: Record<string, unknown>;
    pre: Record<string, unknown> | null;
    observed: Record<string, unknown> | null;
  },
): void {
  if (d.audit === null) return;
  const config = loadConfig(d.env);
  d.audit.append({
    v: 1,
    ts: fields.startedAt.toISOString(),
    actor: config.actor,
    host: config.host,
    op: fields.op,
    uuid: null,
    vector: "ui",
    disruption: 3,
    invocation: null,
    requested: fields.requested,
    pre: fields.pre,
    observed: fields.observed,
    result: fields.result,
    verify: null,
    durationMs: d.now() - fields.startedAt.getTime(),
    env: { pkg: PKG_VERSION, dbVersion: null, fingerprint: "unknown" },
  });
}

// ---------------------------------------------------------------- rendering

/**
 * The human render of `things rescue status`.
 *
 * A ROW WHOSE PROBE DID NOT ANSWER SAYS SO (issue #629). Printing a field's
 * unset default ("none", "unknown") beside rows that WERE measured is exactly
 * what made a stalled inspection read as a clean screen in the field, so an
 * unproven probe renders as "not established" rather than as its default, and
 * the probes are named again in full on the `unproven:` row.
 */
export function rescueStatusLines(report: RescueStatusReport): string[] {
  const lines = ["── Things ──", `screen:      ${report.detail}`];
  const state = report.state;
  if (state !== null) {
    const unproven = (p: UiProbe): boolean =>
      state.stalledProbes.includes(p) || state.failedProbes.includes(p);
    lines.push(
      `dialog:      ${
        unproven("dialog")
          ? "not established"
          : state.sheetKind === "none"
            ? "none"
            : `${state.sheetKind} (${state.sheetForm}; ${state.sheetControls ?? "no census"})`
      }`,
      `stacked:     ${unproven("dialog") ? "not established" : state.sheetDepth}`,
      `frontmost:   ${
        unproven("frontmost")
          ? "not established"
          : `${state.frontmostApp ?? (unproven("frontapp") ? "not established" : "unknown")}${
              state.thingsFrontmost ? " (Things)" : ""
            }`
      }`,
      // Which application owns the KEYBOARD, and what has focus inside it —
      // not the same question as which application owns the screen, and the
      // one that explains a keystroke landing in the void.
      `focus:       ${
        unproven("focus")
          ? "not established"
          : state.focusOwner === null
            ? "unknown"
            : `${state.focusOwner.app} · ${state.focusOwner.role || "no focused element"}${
                state.focusOwner.subrole === null ? "" : ` / ${state.focusOwner.subrole}`
              }`
      }`,
      `inspectable: ${state.inspectable ? "yes" : "no — a system dialog macOS does not expose"}`,
    );
    const unprovenText = describeUnprovenProbes(state);
    if (unprovenText !== "") lines.push(`unproven:    ${unprovenText}`);
  }
  lines.push("── Change lock ──", `lock:        ${report.lock.detail}`);
  if (report.foreignModal !== null) {
    lines.push("── Not ours ──", `dialog:      ${report.foreignModal.detail}`);
  }
  for (const warning of report.warnings) lines.push(`  warning:   ${warning}`);
  for (const step of report.remediation) lines.push(`  next:      ${step}`);
  return lines;
}

/** The human render of `things rescue dismiss`. */
export function rescueDismissLines(result: RescueDismissResult): string[] {
  const lines = [`${result.outcome}: ${result.detail}`];
  if (result.levelsRemaining !== null)
    lines.push(`  dialogs still open: ${result.levelsRemaining}`);
  for (const note of result.notes) lines.push(`  note:      ${note}`);
  for (const warning of result.warnings) lines.push(`  warning:   ${warning}`);
  for (const step of result.remediation) lines.push(`  next:      ${step}`);
  return lines;
}

/** The human render of `things rescue relaunch`. */
export function rescueRelaunchLines(result: RescueRelaunchResult): string[] {
  const lines = [`${result.outcome}: ${result.detail}`];
  for (const step of result.ladder) lines.push(`  ·          ${step}`);
  for (const note of result.notes) lines.push(`  note:      ${note}`);
  for (const warning of result.warnings) lines.push(`  warning:   ${warning}`);
  for (const step of result.remediation) lines.push(`  next:      ${step}`);
  return lines;
}
