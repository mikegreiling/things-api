// Shared types for the lab probe harness (host side).
//
// The guest executor (lab/guest/probe-runner.py) is deliberately dumb: it
// enforces app state, runs commands, polls waits, and dumps raw table
// snapshots + execution records. Everything judgmental — DB diffing,
// disruption tiers, assertions, verdicts — happens here on the host, where
// it is unit-testable.

/** One value in a snapshot row: whatever node:sqlite/python json gives us. */
export type CellValue = string | number | null;

/** rows keyed by primary key (uuid, or "a|b" for join tables). */
export type TableSnapshot = Record<string, Record<string, CellValue>>;

/** Full DB snapshot: table name -> keyed rows. */
export type DbSnapshot = Record<string, TableSnapshot>;

export interface FieldChange {
  field: string;
  before: CellValue;
  after: CellValue;
}

export interface DbDelta {
  inserted: { table: string; key: string; row: Record<string, CellValue> }[];
  deleted: { table: string; key: string; row: Record<string, CellValue> }[];
  changed: { table: string; key: string; fields: FieldChange[] }[];
}

/** One NDJSON line from the disruption monitor (or a MARK from the runner). */
export interface MonitorEvent {
  ts: string;
  kind: string;
  detail?: Record<string, unknown>;
}

export interface DisruptionSignals {
  launch: boolean;
  activated: boolean;
  windowNew: number;
  windowClose: number;
  titleChanges: number;
}

export interface Disruption {
  tier: 0 | 1 | 2 | 3;
  signals: DisruptionSignals;
  events: MonitorEvent[];
}

// ---------------------------------------------------------------- suite DSL

export type Vector = "url" | "applescript" | "shortcuts" | "sqlite";
export type AppState = "not-running" | "running-background" | "frontmost" | "modal-open";

/** Guest-executed command steps. Strings support {ctx:…} {seed:…} {uuid:…} placeholders. */
export type ProbeCommand =
  | { openUrl: string; foreground?: boolean; note?: string }
  | { exec: string[]; note?: string }
  | { osascript: string; note?: string }
  /**
   * Apple Shortcuts vector. The guest writes `input` (a JSON dict; string
   * values resolve the same {ctx:…}/{seed:…}/{uuid:…} placeholders) to a temp
   * file and runs `shortcuts run <shortcut> --input-path <in> --output-path
   * <out>`. The output file (falling back to process stdout) becomes the
   * command's stdout, so `stdoutMatches` assertions see the proxy's result.
   * Only the output-class proxies (find/create-heading/edit-title/set-detail)
   * run headless in clones — the delete-class proxies re-prompt every run, so
   * any probe driving one MUST be tagged `group: "interactive"` (lab:run skips
   * those; they need a human sitting).
   */
  | { shortcut: string; input?: Record<string, unknown>; timeoutSeconds?: number; note?: string }
  | { waitSql: string; timeoutSeconds?: number; note?: string }
  | { waitCrash: true; timeoutSeconds?: number; note?: string }
  | { sleep: number; note?: string };

/** Row selector: column -> literal or "@uuidOf:Table:col=value" / "@seed:NAME" / "@ctx:KEY". */
export type Where = Record<string, CellValue>;

export type Assertion =
  | { kind: "rowExists"; table: string; where: Where }
  | { kind: "rowAbsent"; table: string; where: Where }
  | { kind: "inserted"; table: string; where: Where }
  | { kind: "notInserted"; table: string; where?: Where }
  | { kind: "fieldEquals"; table: string; where: Where; field: string; value: CellValue }
  | { kind: "fieldUnchanged"; table: string; where: Where; fields: string[] }
  | { kind: "unchanged"; table: string; where: Where }
  | { kind: "rowCount"; table: string; where: Where; count: number }
  | { kind: "deltaEmpty" }
  /** Row existed before and is gone after (delta.deleted); refs resolve against the BEFORE snapshot. */
  | { kind: "deleted"; table: string; where: Where }
  /** Regex against the stdout of commands[command] (probe commands only, 0-based). */
  | { kind: "stdoutMatches"; command: number; pattern: string };

export type Verdict =
  | "supported"
  | "unsupported"
  | "silent-noop"
  | "partial"
  | "crash"
  | "disruptive-only";

export interface ProbeExpectation {
  verdict: Verdict;
  tier: 0 | 1 | 2 | 3;
  crash?: boolean;
  /** Non-zero transport exit codes that are acceptable (e.g. osascript failures under test). */
  allowNonzeroExit?: boolean;
  /**
   * `waitSql` steps that never become true are acceptable. Reserved for cells
   * whose wait ASSERTS the very effect the app has stopped producing: a wire
   * command the app now accepts and ignores exits 0, so the only observable is
   * a wait that times out and a delta that stays empty. Without this the probe
   * could not express "the command ran and nothing happened".
   *
   * DISCIPLINE: because this removes the wait oracle, an expectation that sets
   * it MUST carry a POSITIVE assertion of the inertness in its place —
   * `deltaEmpty` for a cell whose whole command list is the dead wire, or a
   * `fieldUnchanged` over the rows the dead leg would have moved for a cell
   * that mixes live and dead legs. That assertion is what goes RED when a later
   * app release restores the behavior; a wait that merely stops timing out
   * would not (some waits are satisfiable by the fixture's pre-existing order).
   */
  allowUnsatisfiedWaits?: boolean;
  assertions: Assertion[];
}

/**
 * A version-conditional expectation: from `fromVersion` of the Things app
 * onward, THIS is what the probe's own wire command does, and the top-level
 * `expect` describes the older app.
 *
 * The suites drive RAW wire commands, not the shipped engine, so an override
 * here is not a restatement of a shipped guard — it is the app-behavior fact
 * the guard was built on top of. That makes the suite the BEHAVIORAL arm the
 * sdef canary cannot be: if a later Things release restores the behavior, the
 * override goes red and tells us to lift the corresponding shipped gate.
 *
 * Bounds are lower-only and evaluated against the golden's `thingsVersion`
 * with the SAME comparator the shipped version gate uses
 * (`src/write/experimental.ts` `compareAppVersions`). The highest matching
 * entry wins; none matching leaves `expect` in force.
 */
export interface VersionedExpectation {
  /** Inclusive lower bound on the golden's Things marketing version, e.g. "3.23". */
  fromVersion: string;
  /** One line: what the app does differently from this version on, and the evidence. */
  because: string;
  expect: ProbeExpectation;
}

export interface ProbeSpec {
  id: string;
  legacyRef?: string;
  title: string;
  vector: Vector;
  operation: string;
  appState: AppState;
  /**
   * "hazard" probes are quarantined to the end of the run (crash risk).
   * "interactive" probes need a human present (e.g. delete-class Shortcuts that
   * re-prompt every run) — lab:run/regress skip them; they are documented in
   * the suite for human sittings (see lab/scripts/l5-consent-absorb.sh).
   */
  group?: "normal" | "hazard" | "interactive";
  /** Executed before the before-snapshot; not part of the evidence window. */
  setup?: ProbeCommand[];
  commands: ProbeCommand[];
  /** Seconds to wait after the last command before the after-snapshot (default 2). */
  settleSeconds?: number;
  /** Executed after the after-snapshot (e.g. clear modals with a reset). */
  cleanup?: ProbeCommand[];
  expect: ProbeExpectation;
  /**
   * Version-conditional overrides of `expect`, newest-app-last is NOT required
   * (the resolver picks the highest matching `fromVersion`). See
   * {@link VersionedExpectation} and docs/reference/suite-audit.md
   * ("Version-conditional expectations").
   */
  expectFrom?: VersionedExpectation[];
}

export interface SuiteSpec {
  suite: string;
  description: string;
  probes: ProbeSpec[];
}

// -------------------------------------------------- guest execution records

export interface CommandResult {
  resolved: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WaitResult {
  sql: string;
  satisfied: boolean;
  waitedMs: number;
  rows?: CellValue[][];
}

/** One line of execution.ndjson written by probe-runner.py. */
export interface ExecutionRecord {
  probe: string;
  startedAt: string;
  endedAt: string;
  appState: AppState;
  appRunningBefore: boolean;
  commands: CommandResult[];
  waits: WaitResult[];
  snapshotBefore: string;
  snapshotAfter: string;
  crash: { pidDied: boolean; ipsFiles: string[] };
  errors: string[];
}

// ----------------------------------------------------------------- evidence

export interface EvidenceEnv {
  thingsVersion: string;
  golden: string;
  schemaFingerprint: string;
  pinnedDate: string;
  runId: string;
}

/** One evidence record per probe execution (docs/design/lab.md §4.2). */
export interface EvidenceRecord {
  probe_id: string;
  legacy_ref: string | null;
  vector: Vector;
  operation: string;
  app_state_before: AppState;
  commands: CommandResult[];
  waits: WaitResult[];
  started_at: string;
  duration_ms: number;
  db_delta: DbDelta;
  disruption: Disruption;
  crash: { pidDied: boolean; ipsFiles: string[] } | null;
  verdict: Verdict | "mismatch";
  expected: {
    verdict: Verdict;
    tier: number;
    crash: boolean;
    /** The `fromVersion` of the override that applied, or null for the base `expect`. */
    appliedFrom: string | null;
    /** The override's `because`, carried into the evidence so the row explains itself. */
    because: string | null;
  };
  failures: string[];
  env: EvidenceEnv;
}

export interface ProbeVerdict {
  ok: boolean;
  verdict: Verdict | "mismatch";
  tier: number;
  crash: boolean;
  /** The `expectFrom` bound that judged this probe, or null for the base `expect`. */
  appliedFrom?: string | null;
  failures: string[];
}

/** verdicts.json: probe id -> verdict summary. Two runs must be identical. */
export type VerdictsFile = Record<string, ProbeVerdict>;
