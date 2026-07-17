/**
 * Core bench types: task specs (the declarative corpus), run records (one graded
 * attempt), and the aggregated scorecard. Kept dependency-free so the corpus JSON
 * and the report tooling share one vocabulary.
 */

export type Family =
  | "discovery"
  | "reads"
  | "domain-reasoning"
  | "gui-perception"
  | "writes"
  | "compound"
  | "longtail"
  | "recovery-safety";

export type Tier = 1 | 2 | 3 | 4;

export type Split = "dev" | "validation" | "holdout";

export type Arm = "cli" | "skill" | "mcp";

/** The pinned clock a task runs under (drives THINGS_NOW / THINGS_TZ). */
export interface Clock {
  /** ISO-8601 instant pinning "now". */
  now: string;
  /** IANA time zone (e.g. "America/Chicago"). */
  tz: string;
}

/**
 * A declarative seed row. Mirrors the `test/fixtures` builders: `kind` selects the
 * builder, `key` is a stable handle other seeds reference via `container`, and the
 * remaining fields map onto that builder's options. All content must be synthetic.
 */
export type SeedSpec =
  | AreaSeed
  | ProjectSeed
  | TodoSeed
  | HeadingSeed
  | TagSeed
  | ChecklistItemSeed;

/** Fields common to the task-like seeds (todo / project / heading). */
export interface TaskSeedFields {
  title?: string;
  notes?: string;
  status?: "open" | "canceled" | "completed";
  start?: "inbox" | "active" | "someday";
  /** ISO date; encoded to the packed int by the builder. */
  startDate?: string | null;
  /** ISO date. */
  deadline?: string | null;
  /** HH:mm reminder. */
  reminder?: string | null;
  evening?: boolean;
  trashed?: boolean;
  index?: number;
}

export interface SeedBase {
  key: string;
  /** Tag titles to attach (tags are auto-created if a `tag` seed did not declare them). */
  tags?: string[];
}

export interface AreaSeed extends SeedBase {
  kind: "area";
  title: string;
  index?: number;
}

export interface ProjectSeed extends SeedBase, TaskSeedFields {
  kind: "project";
  /** key-ref to an `area` seed. */
  container?: string;
}

export interface TodoSeed extends SeedBase, TaskSeedFields {
  kind: "todo";
  /** key-ref to an `area`, `project`, or `heading` seed. */
  container?: string;
}

export interface HeadingSeed extends SeedBase, TaskSeedFields {
  kind: "heading";
  /** key-ref to a `project` seed. */
  container?: string;
}

export interface TagSeed extends SeedBase {
  kind: "tag";
  title: string;
  /** key-ref to a parent `tag` seed. */
  parent?: string;
  index?: number;
}

export interface ChecklistItemSeed extends SeedBase {
  kind: "checklist-item";
  title: string;
  /** key-ref to the owning `todo` seed. */
  container: string;
  status?: "open" | "canceled" | "completed";
  index?: number;
}

/** A machine-checkable assertion evaluated after the agent finishes. */
export type Assertion =
  | SqlAssertion
  | DbUnchangedAssertion
  | AnswerAssertion
  | AnswerIncludesAssertion;

/** Run a query against the post-run fixture; compare the JSON rows to `expect`. */
export interface SqlAssertion {
  type: "sql";
  query: string;
  /** Expected rows as JSON (array of row objects), deep-compared. */
  expect: unknown;
}

/** The fixture DB must be byte-identical to its pre-run snapshot. */
export interface DbUnchangedAssertion {
  type: "db-unchanged";
}

/** A dotted path into the parsed final-answer JSON must equal `equals`. */
export interface AnswerAssertion {
  type: "answer";
  path: string;
  equals: unknown;
}

/** A dotted path into the parsed final-answer JSON (an array) must include every value. */
export interface AnswerIncludesAssertion {
  type: "answer-includes";
  path: string;
  values: unknown[];
}

/** The shape of a required final answer (documentation for the task author). */
export interface FinalAnswerSpec {
  required: boolean;
  /** Human description of the expected answer object shape. */
  shape: string;
}

/** One declarative task in the corpus. */
export interface TaskSpec {
  id: string;
  family: Family;
  tier: Tier;
  split: Split;
  /** The primary natural-language prompt handed to the subject model. */
  prompt: string;
  /** Alternate phrasings; a run may select one to guard against phrasing memorization. */
  paraphrases?: string[];
  clock: Clock;
  seed: SeedSpec[];
  finalAnswer?: FinalAnswerSpec;
  assertions: Assertion[];
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Scripted bash commands replayed by `--pseudo` mode (no LLM). Exercises the
   * seed → sandbox → grade → report plumbing at zero API cost.
   */
  pseudoScript?: string[];
}

/** Deterministic safety verdict for a single run. */
export type Safety = "ok" | "violated";

/** One graded attempt at one task by one arm/model. Appended to runs.jsonl. */
export interface RunRecord {
  runId: string;
  taskId: string;
  /** Index into `paraphrases` when a paraphrase was used, else null (primary prompt). */
  paraphrase: number | null;
  rep: number;
  arm: Arm;
  model: string;
  provider: string;
  /** Hash of the fixed system prompt used (versioned prompt identity). */
  promptHash: string;
  gitSha: string;
  success: boolean;
  safety: Safety;
  /** Error responses the agent saw (nonzero CLI exits / MCP isError results). */
  errorsSeen: number;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** System prompt + tool defs (+ skill bytes if loaded). */
  staticContextTokens: number;
  /** Everything else in context (prompt, results, errors). */
  dynamicContextTokens: number;
  wallMs: number;
  /**
   * PRNG seed of the evergreen world profile the run's fixture carried
   * (bench/world.ts), or null when the world was disabled (`--no-world`).
   */
  worldSeed: number | null;
  /** Path (relative to the run's out dir) to the transcript file. */
  transcript: string;
  failureNotes?: string;
}

/** Aggregated metrics for one arm × model × family cell (successful runs only for 3–5). */
export interface ScorecardCell {
  arm: Arm;
  model: string;
  family: Family;
  runs: number;
  successes: number;
  successRate: number;
  /** Means below are over SUCCESSFUL runs only. */
  meanErrorsSeen: number;
  meanTokensIn: number;
  meanTokensOut: number;
  meanStaticContextTokens: number;
  meanDynamicContextTokens: number;
  meanTurns: number;
  meanToolCalls: number;
  meanWallMs: number;
  /** Safety violations across ALL runs in the cell (never averaged away). */
  safetyViolations: number;
}

/** Provenance for a scorecard. */
export interface ScorecardPins {
  gitSha: string;
  /** Distinct (arm → promptHash) pairs observed in the aggregated runs. */
  promptHashes: Record<string, string>;
  models: string[];
  generatedAt: string;
}

export interface Scorecard {
  pins: ScorecardPins;
  cells: ScorecardCell[];
}
