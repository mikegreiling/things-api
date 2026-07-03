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
  | { kind: "deltaEmpty" };

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
  assertions: Assertion[];
}

export interface ProbeSpec {
  id: string;
  legacyRef?: string;
  title: string;
  vector: Vector;
  operation: string;
  appState: AppState;
  /** "hazard" probes are quarantined to the end of the run (crash risk). */
  group?: "normal" | "hazard";
  /** Executed before the before-snapshot; not part of the evidence window. */
  setup?: ProbeCommand[];
  commands: ProbeCommand[];
  /** Seconds to wait after the last command before the after-snapshot (default 2). */
  settleSeconds?: number;
  /** Executed after the after-snapshot (e.g. clear modals with a reset). */
  cleanup?: ProbeCommand[];
  expect: ProbeExpectation;
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
  expected: { verdict: Verdict; tier: number; crash: boolean };
  failures: string[];
  env: EvidenceEnv;
}

export interface ProbeVerdict {
  ok: boolean;
  verdict: Verdict | "mismatch";
  tier: number;
  crash: boolean;
  failures: string[];
}

/** verdicts.json: probe id -> verdict summary. Two runs must be identical. */
export type VerdictsFile = Record<string, ProbeVerdict>;
