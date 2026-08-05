/**
 * Write commands. Help text is the agent API: every command's --help states
 * its behavior, side effects, and required confirmation flags in consumer
 * voice (docs/design/surface-copy.md) — internals stay in docs/ and the
 * capabilities/dry-run OUTPUT. No interactive prompts: risky semantics
 * require explicit flags.
 */
import type { Command } from "commander";

import { readFileSync } from "node:fs";

import { addRepeatRuleFlags, repeatRuleFlagsFromOpts } from "./repeat-flags.ts";
import {
  aggregateExitCode,
  blockedCode,
  capabilitiesTable,
  ClockError,
  describeConfig,
  errorEnvelope,
  ExitCode,
  getConfigKey,
  mutationWireData,
  okEnvelope,
  openThings,
  OP_ID_RE,
  outcomeFailed,
  ReferenceResolutionError,
  saveConfigKey,
  splitWhenSugar,
  ThingsDbNotFoundError,
  ThingsDbOpenError,
  verifyFailedCode,
  type BatchItemResult,
  type BatchOp,
  type ConfigKeyView,
  type DisruptionTier,
  type EnvelopeMeta,
  type HeadingPlacement,
  type MovePosition,
  type MoveResult,
  type OperationKind,
  type ProjectMoveDestination,
  type ProjectMoveRequest,
  type ReorderRequest,
  type ReorderResult,
  type RepeatFrequency,
  type ThingsClient,
  type TodoMoveDestination,
  type TodoMoveRequest,
  type UndoItemResult,
  type VectorId,
  type WriteOptions,
} from "../../index.ts";
import { usageError } from "../read-driver.ts";
import { dim } from "../style.ts";

interface WriteFlagOpts {
  json?: boolean;
  db?: string;
  dryRun?: boolean;
  vector?: string;
  allowDisruptive?: boolean;
  allowVeryDisruptive?: boolean;
  verifyTimeout?: string;
  actor?: string;
  dangerouslyDriveGui?: boolean;
  opId?: string;
}

function addWriteFlags(cmd: Command): Command {
  return cmd
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .option("--dry-run", "preview the planned change and its expected effect; nothing executes")
    .option(
      "--vector <id>",
      "force how the change is delivered: url-scheme | applescript | shortcuts | ui",
    )
    .option("--allow-disruptive", "permit changes that briefly steal window focus")
    .option("--allow-very-disruptive", "permit changes that visibly drive the Things UI")
    .option("--verify-timeout <ms>", "how long to wait for the change to take effect")
    .option("--actor <name>", "author name recorded for this change (default: from config)")
    .option(
      "--op-id <key>",
      "idempotency key: a resubmission with the same key is recognized as already applied " +
        "and not re-run (matches [A-Za-z0-9_-], 1-64 chars)",
    );
}

/** Validate an `--op-id`; on a malformed value emit the usage error and return false. */
function opIdOk(opts: WriteFlagOpts): boolean {
  if (opts.opId === undefined) return true;
  if (OP_ID_RE.test(opts.opId)) return true;
  usageError(opts, "--op-id must match [A-Za-z0-9_-] and be 1-64 characters");
  return false;
}

/**
 * Refuse `--op-id` on a multi-leg COMPOUND command. Single-op idempotency (phase
 * 1) replays exactly ONE recorded ok result; a compound records several (or a
 * summary) and its idempotency is the batch-shaped per-line `op_id`. Refusing is
 * honest — dropping the flag silently would leave a resubmission un-deduped.
 * Returns true when refused (the caller returns).
 */
function opIdCompoundRefused(opts: WriteFlagOpts, what: string): boolean {
  if (opts.opId === undefined) return false;
  usageError(
    opts,
    `--op-id is not available on ${what} (a multi-leg compound in phase 1) — express it as ` +
      "`things batch` with a per-line op_id for idempotent resubmission",
  );
  return true;
}

/** A commander flag value when present-with-value (bare presence yields `true`). */
const flagVal = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Writes one batch result as a FLATTENED NDJSON line to stdout: the internal
 * `outcome` union object is collapsed to one level. `outcome` becomes its tag
 * as a plain string (`"ok"`, `"blocked"`, `"verify-failed"`, `"unsupported"`,
 * `"dry-run"`, `"invalid"`, `"skipped"`, `"already-applied"`, `"bounce-aborted"`),
 * and every variant field (uuid, detail, plan, expected, observed, considered,
 * placed, remaining, cause, …) sits as a sibling of the line-level keys. The
 * outcome's own `op` duplicates the line-level `op`, so it is dropped. No
 * variant field name collides with a line-level key (index, op, outcome,
 * tempId, boundUuid, opId).
 */
const emit = (r: BatchItemResult): void => {
  const { index, op, outcome, tempId, boundUuid, opId } = r;
  const { kind, op: _outcomeOp, ...variant } = outcome;
  const line = {
    index,
    op,
    outcome: kind,
    ...variant,
    ...(tempId !== undefined && { tempId }),
    ...(boundUuid !== undefined && { boundUuid }),
    ...(opId !== undefined && { opId }),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/**
 * One `config get` line: `key: value`, plus a dim provenance marker for a
 * default, env-sourced, or derived value (stored keys render bare).
 */
function configKeyLine(entry: ConfigKeyView): string {
  const marker = entry.source === "stored" ? "" : ` ${dim(`(${entry.source})`)}`;
  return `${entry.key}: ${String(entry.value)}${marker}`;
}

function writeOptionsFrom(opts: WriteFlagOpts, extra: Partial<WriteOptions> = {}): WriteOptions {
  const maxDisruption: DisruptionTier | undefined = opts.allowVeryDisruptive
    ? 3
    : opts.allowDisruptive
      ? 2
      : undefined;
  return {
    ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
    ...(opts.vector !== undefined && { vector: opts.vector as VectorId }),
    ...(maxDisruption !== undefined && { maxDisruption }),
    ...(opts.verifyTimeout !== undefined && { verifyTimeoutMs: Number(opts.verifyTimeout) }),
    ...(opts.actor !== undefined && { actor: opts.actor }),
    ...(opts.dangerouslyDriveGui === true && { dangerouslyDriveGui: true }),
    ...(opts.opId !== undefined && { opId: opts.opId }),
    ...extra,
  };
}

/**
 * `--create-tags` on a tag-accepting command: create any named tag that does
 * not exist yet (mkdir-p for `parent/child`) before applying, instead of
 * refusing. Nesting is via the clean `make new tag` path.
 */
function addCreateTagsFlag(cmd: Command): Command {
  return cmd.option(
    "--create-tags",
    "create any missing tag (nesting parent/child) instead of failing on an unknown tag",
  );
}

/** WriteOptions extra carrying createTags when the flag is set. */
function createTagsExtra(opts: Record<string, unknown>): Partial<WriteOptions> {
  return opts["createTags"] === true ? { createTags: true } : {};
}

/** Heading selector help string (exact title or uuid — never an ordinal). */
const HEADING_SEL_HELP = "heading selector: exact title or uuid";

/** The four heading-placement flags (spec §2), shared by add/move-heading. */
function addPlacementFlags(cmd: Command): Command {
  return cmd
    .option("--first", "place it first among the project's headings")
    .option("--last", "place it last among the project's headings")
    .option("--before-heading <sel>", "place it immediately before this heading (title or uuid)")
    .option("--after-heading <sel>", "place it immediately after this heading (title or uuid)");
}

function countPlacementFlags(opts: Record<string, unknown>): number {
  return [
    opts["first"] === true,
    opts["last"] === true,
    opts["beforeHeading"] !== undefined,
    opts["afterHeading"] !== undefined,
  ].filter(Boolean).length;
}

/** Build the resolved placement from the flags, resolving anchor selectors. */
function headingPlacement(
  c: ThingsClient,
  projectUuid: string,
  opts: Record<string, unknown>,
): HeadingPlacement | undefined {
  if (opts["first"] === true) return { position: "first" };
  if (opts["last"] === true) return { position: "last" };
  if (opts["beforeHeading"] !== undefined) {
    return { before: c.resolve.heading(projectUuid, opts["beforeHeading"] as string).uuid };
  }
  if (opts["afterHeading"] !== undefined) {
    return { after: c.resolve.heading(projectUuid, opts["afterHeading"] as string).uuid };
  }
  return undefined;
}

/** Add the mandatory GUI-drive acknowledgement to a ui-vector command. */
function addDriveGuiFlag(cmd: Command): Command {
  return cmd.option(
    "--dangerously-drive-gui",
    "required: visibly drives the Things app to make a change it offers nowhere else; " +
      "also needs `things config set ui-enabled true`",
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * URL-style `--when DATE@TIME` sugar: splits into when + reminder for the
 * ops that take both (an explicit --reminder alongside the suffix errors). The
 * `@` split and its usage copy are the shared {@link splitWhenSugar} core; this
 * only mutates the parsed opts on a successful split.
 */
function applyWhenSugar(opts: Record<string, unknown>): string | null {
  const r = splitWhenSugar(opts["when"], opts["reminder"] !== undefined);
  if (r.kind === "error") return r.message;
  if (r.kind === "split") {
    opts["when"] = r.when;
    opts["reminder"] = r.reminder;
  }
  return null;
}

/** Apply the sugar or print the usage error; false = caller returns. */
function whenSugarOk(opts: Record<string, unknown> & { json?: boolean }): boolean {
  const err = applyWhenSugar(opts);
  if (err === null) return true;
  usageError(opts, err);
  return false;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

async function runWrite(
  opts: WriteFlagOpts,
  fn: (client: ThingsClient) => Promise<ReorderResult>,
  emitFn: (result: ReorderResult, opts: WriteFlagOpts, meta: EnvelopeMeta) => void = emitResult,
): Promise<void> {
  if (!opIdOk(opts)) return;
  const started = Date.now();
  let client: ThingsClient | null = null;
  const meta = (client_: ThingsClient | null): EnvelopeMeta => {
    let dbVersion: number | null = null;
    let fingerprint: EnvelopeMeta["fingerprint"] = "unknown";
    let clock;
    if (client_ !== null) {
      const fp = client_.fingerprint();
      dbVersion = fp.observation.databaseVersion;
      fingerprint = fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown";
      clock = client_.clockMeta();
    }
    return { dbVersion, fingerprint, elapsedMs: Date.now() - started, ...(clock && { clock }) };
  };

  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const result = await fn(client);
    emitFn(result, opts, meta(client));
  } catch (err) {
    // An unresolved write target (uuid/partial-uuid/name that is ambiguous or
    // not-found) is a usage-class failure carrying machine-readable candidates
    // — never the generic `unexpected`.
    if (err instanceof ReferenceResolutionError) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: err.code,
                message: err.message,
                detail: { candidates: err.candidates },
              },
              meta(client),
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exitCode = ExitCode.Usage;
      return;
    }
    // A malformed THINGS_TZ / THINGS_NOW fails closed as a usage error.
    if (err instanceof ClockError) {
      usageError(opts, err.message);
      return;
    }
    const isEnv = err instanceof ThingsDbNotFoundError || err instanceof ThingsDbOpenError;
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(errorEnvelope({ code: isEnv ? "environment" : "unexpected", message }, meta(client)))}\n`,
      );
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = isEnv ? ExitCode.Environment : ExitCode.Unexpected;
  } finally {
    client?.close();
  }
}

function emitResult(result: ReorderResult, opts: WriteFlagOpts, meta: EnvelopeMeta): void {
  switch (result.kind) {
    case "bounce-aborted": {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: "bounce-aborted",
                message: result.detail,
                detail: { placed: result.placed, remaining: result.remaining, cause: result.cause },
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(
          `BOUNCE ABORTED: ${result.detail}\n` +
            `  placed (now at the top, in order): ${result.placed.join(", ") || "none"}\n` +
            `  not placed: ${result.remaining.join(", ")}\n`,
        );
      }
      process.exitCode = ExitCode.VerifyFailed;
      return;
    }
    case "ok": {
      for (const warning of result.warnings ?? []) {
        process.stderr.write(`warning: ${warning}\n`);
      }
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("mutation-result", mutationWireData(result), meta))}\n`,
        );
      } else {
        const uuid = result.uuid === null ? "" : ` uuid=${result.uuid}`;
        const status =
          "alreadyApplied" in result && result.alreadyApplied === true
            ? "already applied — matched op-id in the change history, not re-run"
            : `vector=${result.vector}, tier=${result.tier}, verified`;
        process.stdout.write(`ok ${result.op}${uuid} (${status})\n`);
      }
      process.exitCode = ExitCode.Ok;
      return;
    }
    case "dry-run": {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(okEnvelope("mutation-plan", result.plan, meta))}\n`);
      } else {
        process.stdout.write(
          [
            `DRY RUN ${result.op}`,
            `  vector: ${result.plan.vector} (tier ${result.plan.tier})`,
            `  invocation: ${result.plan.invocation}`,
            `  hazards checked: ${result.plan.hazardsChecked.join(", ") || "none"}`,
            `  expected delta: ${JSON.stringify(result.plan.expectedDelta)}`,
            "",
          ].join("\n"),
        );
      }
      process.exitCode = ExitCode.Ok;
      return;
    }
    case "verify-failed": {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: verifyFailedCode(result),
                message: result.detail,
                ...(result.likelyCause !== undefined && { likelyCause: result.likelyCause }),
                ...(result.hint !== undefined && { remediation: result.hint }),
                detail: { expected: result.expected, observed: result.observed },
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`VERIFY FAILED (${result.reason}): ${result.detail}\n`);
        if (result.likelyCause !== undefined) {
          process.stderr.write(
            `  likely cause: ${result.likelyCause}${result.hint !== undefined ? ` — ${result.hint}` : ""}\n`,
          );
        }
      }
      process.exitCode = ExitCode.VerifyFailed;
      return;
    }
    case "blocked": {
      const code = result.reason === "drift" ? ExitCode.DriftBlocked : ExitCode.Blocked;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: blockedCode(result),
                message: result.detail,
                ...(result.likelyCause !== undefined && { likelyCause: result.likelyCause }),
                remediation: result.remediation,
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(
          `BLOCKED (${result.hazard ?? result.reason}): ${result.detail}\n  remediation: ${result.remediation}\n`,
        );
      }
      process.exitCode = code;
      return;
    }
    case "unsupported": {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: "unsupported",
                message: `no validated vector supports ${result.op}`,
                detail: { considered: result.considered },
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`UNSUPPORTED: no validated vector supports ${result.op}\n`);
        for (const c of result.considered) {
          process.stderr.write(`  ${c.vector}: ${c.why}\n`);
        }
      }
      process.exitCode = ExitCode.Unsupported;
      return;
    }
    default: {
      const exhaustive: never = result;
      throw new Error(`unknown result: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// -------------------------------------------------- move / reorder (spec §4)

/** Open the client, run a MoveResult-returning fn, and render it. */
async function runMoveCmd(
  opts: WriteFlagOpts,
  fn: (client: ThingsClient) => Promise<MoveResult>,
): Promise<void> {
  // A variadic move/reorder is a multi-leg COMPOUND (the batch-shaped case), not
  // a single recorded mutation — single-op idempotency (--op-id) does not apply
  // in phase 1. Refuse it loudly rather than silently drop it; the compound
  // analogue is `things batch` with a per-line op_id.
  if (opts.opId !== undefined) {
    usageError(
      opts,
      "--op-id is not available on a variadic move/reorder (a multi-leg compound) — express it " +
        "as `things batch` with a per-line op_id for idempotent resubmission",
    );
    return;
  }
  const started = Date.now();
  let client: ThingsClient | null = null;
  const meta = (): EnvelopeMeta => {
    let dbVersion: number | null = null;
    let fingerprint: EnvelopeMeta["fingerprint"] = "unknown";
    if (client !== null) {
      const fp = client.fingerprint();
      dbVersion = fp.observation.databaseVersion;
      fingerprint = fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown";
    }
    return { dbVersion, fingerprint, elapsedMs: Date.now() - started };
  };
  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    emitMoveResult(await fn(client), opts, meta());
  } catch (err) {
    if (err instanceof ReferenceResolutionError) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(errorEnvelope({ code: err.code, message: err.message, detail: { candidates: err.candidates } }, meta()))}\n`,
        );
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exitCode = ExitCode.Usage;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(errorEnvelope({ code: "unexpected", message }, meta()))}\n`,
      );
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = ExitCode.Unexpected;
  } finally {
    client?.close();
  }
}

function emitMoveResult(result: MoveResult, opts: WriteFlagOpts, meta: EnvelopeMeta): void {
  switch (result.kind) {
    case "move-ok": {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("move-result", mutationWireData(result), meta))}\n`,
        );
      } else {
        const who = result.movees.map((m) => m.title ?? m.uuid).join(", ");
        process.stdout.write(
          `ok ${result.op}: moved ${result.movees.length} item(s) — ${who}\n` +
            `  placement: ${result.placementClass} — ${result.note}\n`,
        );
      }
      process.exitCode = ExitCode.Ok;
      return;
    }
    case "move-dry-run": {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(okEnvelope("move-plan", result.plan, meta))}\n`);
      } else {
        process.stdout.write(
          [
            `DRY RUN ${result.op}`,
            `  movees: ${result.plan.movees.join(", ")}`,
            `  membership: ${result.plan.membership}`,
            `  placement: ${result.plan.placement} (${result.plan.placementClass})`,
            `  ${result.plan.note}`,
            "",
          ].join("\n"),
        );
      }
      process.exitCode = ExitCode.Ok;
      return;
    }
    case "move-refused": {
      const code =
        result.refusal === "usage"
          ? ExitCode.Usage
          : result.refusal === "unsupported"
            ? ExitCode.Unsupported
            : ExitCode.Blocked;
      // A hoisted placement block names its hazard — surface it with the canonical
      // `blocked:<hazard>` code + `BLOCKED (<hazard>)` copy, exactly as a direct
      // `things reorder` hazard block does (emitResult "blocked" case).
      const jsonCode =
        result.hazard !== undefined
          ? blockedCode({ hazard: result.hazard, reason: "hazard" })
          : result.refusal;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: jsonCode,
                message: result.detail,
                ...(result.remediation !== undefined && { remediation: result.remediation }),
                ...(result.candidates !== undefined && {
                  detail: { candidates: result.candidates },
                }),
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        const prefix =
          result.refusal === "usage"
            ? "error"
            : result.hazard !== undefined
              ? `BLOCKED (${result.hazard})`
              : result.refusal.toUpperCase();
        process.stderr.write(
          `${prefix}: ${result.detail}\n` +
            (result.remediation !== undefined ? `  remediation: ${result.remediation}\n` : ""),
        );
      }
      process.exitCode = code;
      return;
    }
    case "move-leg-failed": {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(errorEnvelope({ code: "verify-failed", message: result.detail, detail: { failed: result.failed, completed: result.completed } }, meta))}\n`,
        );
      } else {
        process.stderr.write(`MOVE FAILED: ${result.detail}\n`);
      }
      process.exitCode = ExitCode.VerifyFailed;
      return;
    }
  }
}

/** Build a MovePosition from the shared --first/--last/--before/--after flags. */
function movePosition(opts: Record<string, unknown>): MovePosition | undefined | "conflict" {
  const chosen = [
    opts["first"] === true,
    opts["last"] === true,
    opts["before"] !== undefined,
    opts["after"] !== undefined,
  ].filter(Boolean).length;
  if (chosen > 1) return "conflict";
  if (opts["first"] === true) return { at: "first" };
  if (opts["last"] === true) return { at: "last" };
  if (opts["before"] !== undefined) return { before: opts["before"] as string };
  if (opts["after"] !== undefined) return { after: opts["after"] as string };
  return undefined;
}

/** Build a to-do move destination; "conflict" when more than one is named. */
function todoDestination(
  opts: Record<string, unknown>,
): TodoMoveDestination | undefined | "conflict" {
  const dests: TodoMoveDestination[] = [];
  const toProject = opts["toProject"] as string | undefined;
  const toHeading = opts["toHeading"] as string | undefined;
  if (toHeading !== undefined) {
    dests.push({
      kind: "heading",
      sel: toHeading,
      ...(toProject !== undefined && { project: { uuid: toProject, title: toProject } }),
    });
  } else if (toProject !== undefined) {
    dests.push({ kind: "project", ref: { uuid: toProject, title: toProject } });
  }
  const toArea = opts["toArea"] as string | undefined;
  if (toArea !== undefined) dests.push({ kind: "area", ref: { uuid: toArea, title: toArea } });
  // Commander maps `--no-heading`/`--no-area` onto the base key as `false`.
  if (opts["heading"] === false) dests.push({ kind: "no-heading" });
  if (opts["loose"] === true) dests.push({ kind: "loose" });
  if (opts["inbox"] === true) dests.push({ kind: "inbox" });
  if (opts["area"] === false) dests.push({ kind: "no-area" });
  if (opts["detach"] === true) dests.push({ kind: "detach" });
  if (dests.length > 1) return "conflict";
  return dests[0];
}

/** Build a project move destination; "conflict" when more than one is named. */
function projectDestination(
  opts: Record<string, unknown>,
): ProjectMoveDestination | undefined | "conflict" {
  const dests: ProjectMoveDestination[] = [];
  const toArea = opts["toArea"] as string | undefined;
  if (toArea !== undefined) dests.push({ kind: "area", ref: { uuid: toArea, title: toArea } });
  // Commander maps `--no-area` onto the base key `area` as `false`.
  if (opts["area"] === false) dests.push({ kind: "no-area" });
  if (opts["loose"] === true) dests.push({ kind: "loose" });
  if (opts["detach"] === true) dests.push({ kind: "detach" });
  if (dests.length > 1) return "conflict";
  return dests[0];
}

/** The shared position flags (--first/--last/--before/--after) for move/reorder. */
function addPositionFlags(cmd: Command): Command {
  return cmd
    .option("--first", "place the block at the top of its bucket")
    .option("--last", "place the block at the bottom of its bucket")
    .option("--before <ref>", "place the block immediately before this item (same bucket)")
    .option("--after <ref>", "place the block immediately after this item (same bucket)");
}

/**
 * The universal-`reorder` anchor grammar (spec §7 ratified vocabulary):
 * --start / --end / --before / --after. `--start`/`--end` name the block's top/
 * bottom slot in its scope; --before/--after anchor against a sibling.
 */
function addReorderPositionFlags(cmd: Command): Command {
  return cmd
    .option("--start", "place the block at the start of its scope")
    .option("--end", "place the block at the end of its scope")
    .option("--before <ref>", "place the block immediately before this item")
    .option("--after <ref>", "place the block immediately after this item");
}

/** Build a MovePosition from the reorder --start/--end/--before/--after flags. */
function reorderPosition(opts: Record<string, unknown>): MovePosition | undefined | "conflict" {
  const chosen = [
    opts["start"] === true,
    opts["end"] === true,
    opts["before"] !== undefined,
    opts["after"] !== undefined,
  ].filter(Boolean).length;
  if (chosen > 1) return "conflict";
  if (opts["start"] === true) return { at: "first" };
  if (opts["end"] === true) return { at: "last" };
  if (opts["before"] !== undefined) return { before: opts["before"] as string };
  if (opts["after"] !== undefined) return { after: opts["after"] as string };
  return undefined;
}

/** One TTY line for a bulk-add batch item (the human, non-JSON multi rendering). */
function addResultLine(r: BatchItemResult): string {
  const o = r.outcome;
  switch (o.kind) {
    case "ok":
      return `ok todo.add uuid=${o.uuid ?? ""} (vector=${o.vector}, tier=${o.tier}, verified)\n`;
    case "dry-run":
      return `DRY RUN todo.add (vector=${o.plan.vector}, tier ${o.plan.tier}) ${o.plan.invocation}\n`;
    case "already-applied":
      return `already-applied todo.add uuid=${o.uuid}\n`;
    case "skipped":
      return `skipped todo.add: ${o.detail}\n`;
    case "invalid":
      return `FAILED todo.add: ${o.detail}\n`;
    case "blocked":
      return `BLOCKED todo.add (${o.hazard ?? o.reason}): ${o.detail}\n`;
    case "verify-failed":
      return `VERIFY FAILED todo.add (${o.reason}): ${o.detail}\n`;
    case "unsupported":
      return `UNSUPPORTED todo.add\n`;
    default:
      return `FAILED todo.add: ${JSON.stringify(o)}\n`;
  }
}

/**
 * Run a bulk `todo add` as ONE batch of `todo.add` legs (shared flags already
 * compiled into every op's params). Streams per-line results and a trailing
 * summary carrying the single `undoToken` that removes the whole skeleton —
 * except under `--id-only`, where output is exactly one uuid per created item,
 * in creation order, and nothing else. Exit code is the worst leg's failure.
 */
async function runBulkAdd(opts: WriteFlagOpts, ops: BatchOp[], idOnly: boolean): Promise<void> {
  let client: ThingsClient | null = null;
  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const batchResult = await client.write.batch(
      ops,
      {
        ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
        ...(opts.actor !== undefined && { actor: opts.actor }),
      },
      (r) => {
        if (idOnly) {
          if (r.outcome.kind === "ok" && r.outcome.uuid !== null)
            process.stdout.write(`${r.outcome.uuid}\n`);
        } else if (opts.json) {
          emit(r);
        } else {
          process.stdout.write(addResultLine(r));
        }
      },
    );
    const failed = batchResult.results.filter((r) => outcomeFailed(r.outcome));
    if (!idOnly) {
      const total = batchResult.results.length;
      const okCount = total - failed.length;
      if (opts.json) {
        const summary = {
          summary: {
            total,
            ok: okCount,
            failed: failed.filter((r) => r.outcome.kind !== "skipped").length,
            skipped: batchResult.results.filter((r) => r.outcome.kind === "skipped").length,
            ...(batchResult.undoToken !== undefined && { undoToken: batchResult.undoToken }),
          },
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      } else {
        const undo =
          batchResult.undoToken !== undefined
            ? ` (undo all: things undo --txn ${batchResult.undoToken})`
            : "";
        process.stdout.write(`added ${okCount}/${total} to-dos${undo}\n`);
      }
    }
    process.exitCode = aggregateExitCode(failed.map((r) => r.outcome));
  } finally {
    client?.close();
  }
}

/** Read newline-delimited titles from stdin; blank lines (whitespace-only) skipped. */
async function readStdinTitles(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");
}

function group(program: Command, name: string, description: string): Command {
  const existing = program.commands.find((c) => c.name() === name);
  if (existing !== undefined) return existing;
  return program.command(name).description(description);
}

const containerRef = (value: string | undefined): { uuid?: string; title?: string } | undefined =>
  value === undefined ? undefined : { uuid: value, title: value };

export function registerWriteCommands(program: Command): void {
  const todo = group(program, "todo", "To-do–scoped operations");

  addCreateTagsFlag(
    addWriteFlags(
      todo
        .command("add [titles...]")
        .description(
          "Create one or more to-dos; each new uuid is printed on success. Pass several " +
            "titles to create a quick skeleton in one call, or stream them with --stdin " +
            "(one title per line); every shared flag below applies to each title. Projects, " +
            "areas, and headings must name existing items — unknown or ambiguous references " +
            "are rejected. A tag may be a name or a parent/child path, and must exist unless " +
            "--create-tags. Adding into a completed/canceled project reopens that project — " +
            "requires --acknowledge-project-reopen. When several to-dos are created, one undo " +
            "token removes the whole skeleton at once.",
        )
        .option("--notes <text>", "notes body")
        .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
        .option(
          "--reminder <HH:mm>",
          "time-of-day reminder (24h); requires --when today|evening|YYYY-MM-DD",
        )
        .option("--deadline <date>", "YYYY-MM-DD")
        .option(
          "--tags <list>",
          "comma-separated tags; each a name or a parent/child path (must exist unless --create-tags)",
        )
        .option("--checklist-item <text>", "checklist item (repeatable)", collect, [])
        .option("--project <ref>", "destination project (uuid or unique name)")
        .option("--area <ref>", "destination area (uuid or unique name)")
        .option("--heading <name>", "existing heading in the destination project")
        .option(
          "--created-at <iso>",
          "born with this creation timestamp (ISO date or datetime; a date is noon in the effective zone)",
        )
        .option(
          "--completed-at <iso>",
          "born completed (in the Logbook) with this completion timestamp (ISO date or datetime); drop --when/--reminder",
        )
        .option("--acknowledge-project-reopen", "allow adding into a completed/canceled project")
        .option(
          "--stdin",
          "read newline-delimited titles from stdin (blank lines skipped); exclusive with title arguments",
        )
        .option(
          "--id-only",
          "print only the new uuid(s), one per line in creation order, and nothing else (exclusive with --json)",
        ),
    ),
  ).action(async (titles: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
    const idOnly = opts["idOnly"] === true;
    const useStdin = opts["stdin"] === true;
    if (idOnly && opts.json === true) {
      usageError(opts, "--id-only and --json are mutually exclusive");
      return;
    }
    if (useStdin && titles.length > 0) {
      usageError(opts, "--stdin is mutually exclusive with title arguments");
      return;
    }
    const finalTitles = useStdin ? await readStdinTitles() : titles;
    if (finalTitles.length === 0) {
      usageError(
        opts,
        useStdin
          ? "no titles: --stdin received no non-empty lines"
          : "provide at least one title, or pass --stdin to read titles from stdin",
      );
      return;
    }
    const checklist = opts["checklistItem"] as string[];
    const tags = splitCsv(opts["tags"] as string | undefined);
    const project = containerRef(opts["project"] as string | undefined);
    const area = containerRef(opts["area"] as string | undefined);
    if (!whenSugarOk(opts)) return;
    const buildParams = (title: string): Record<string, unknown> => ({
      title,
      ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
      ...(opts["when"] !== undefined && { when: opts["when"] as never }),
      ...(opts["reminder"] !== undefined && { reminder: opts["reminder"] as string }),
      ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
      ...(tags !== undefined && { tags }),
      ...(checklist.length > 0 && { checklistItems: checklist }),
      ...(project !== undefined && { project }),
      ...(area !== undefined && { area }),
      ...(opts["heading"] !== undefined && { heading: opts["heading"] as string }),
      ...(opts["createdAt"] !== undefined && { createdAt: opts["createdAt"] as string }),
      ...(opts["completedAt"] !== undefined && { completedAt: opts["completedAt"] as string }),
    });
    const ackReopen =
      opts["acknowledgeProjectReopen"] !== undefined
        ? { acknowledgeProjectReopen: opts["acknowledgeProjectReopen"] as boolean }
        : {};

    // A multi-title add compiles onto the batch machinery (below), where
    // idempotency is a per-LINE op_id, not one key for the whole skeleton —
    // refuse --op-id there rather than drop it. A single-title add is a single
    // mutation and takes --op-id normally (validated inside runWrite).
    if (finalTitles.length > 1 && opts.opId !== undefined) {
      usageError(
        opts,
        "--op-id applies to a single-title add — for a multi-title add use `things batch` with a " +
          "per-line op_id",
      );
      return;
    }

    // Single title (positional or a one-line stdin) keeps today's single
    // mutation-result envelope exactly — unless --id-only, which prints just
    // the new uuid. Multiple titles compile onto the batch machinery.
    if (finalTitles.length === 1) {
      const params = buildParams(finalTitles[0] as string);
      const wopts = writeOptionsFrom(opts, { ...ackReopen, ...createTagsExtra(opts) });
      if (!idOnly) {
        await runWrite(opts, (c) => c.write.addTodo(params as never, wopts));
        return;
      }
      await runWrite(
        opts,
        (c) => c.write.addTodo(params as never, wopts),
        (result, o, meta) => {
          if (result.kind === "ok") {
            if (result.uuid !== null) process.stdout.write(`${result.uuid}\n`);
            process.exitCode = ExitCode.Ok;
          } else if (result.kind === "dry-run") {
            // --id-only mints no uuid to print on a dry-run; stay silent.
            process.exitCode = ExitCode.Ok;
          } else {
            emitResult(result, { ...o, json: false }, meta);
          }
        },
      );
      return;
    }

    // Multi-title: one batch of todo.add legs, shared flags applied to each.
    const perOpOptions: NonNullable<BatchOp["options"]> = {
      ...ackReopen,
      ...(opts["createTags"] === true && { createTags: true }),
      ...(opts.vector !== undefined && { vector: opts.vector as VectorId }),
      ...(opts.allowVeryDisruptive === true
        ? { maxDisruption: 3 as DisruptionTier }
        : opts.allowDisruptive === true
          ? { maxDisruption: 2 as DisruptionTier }
          : {}),
      ...(opts.verifyTimeout !== undefined && { verifyTimeoutMs: Number(opts.verifyTimeout) }),
    };
    const hasPerOpOptions = Object.keys(perOpOptions).length > 0;
    const ops: BatchOp[] = finalTitles.map((title) => {
      const op: BatchOp = { op: "todo.add" as OperationKind, params: buildParams(title) };
      if (hasPerOpOptions) op.options = perOpOptions;
      return op;
    });
    await runBulkAdd(opts, ops, idOnly);
  });

  addWriteFlags(
    todo
      .command("update <uuid>")
      .description(
        "Update title/notes/when/reminder/deadline. Schedule and deadline changes are not " +
          "available for repeating to-dos (title/notes are). --reminder needs --when " +
          "today|evening|YYYY-MM-DD; when re-scheduling WITHOUT --reminder an existing " +
          "reminder is auto-preserved. --clear-reminder works while the to-do is scheduled " +
          "for today|evening — a DATED reminder can only be changed, not cleared " +
          "(re-schedule to today first). --append-notes/--prepend-notes join with a " +
          "newline (exclusive with --notes).",
      )
      .option("--title <text>", "new title")
      .option("--notes <text>", "replace notes")
      .option("--append-notes <text>", "append to existing notes (newline-joined)")
      .option("--prepend-notes <text>", "prepend to existing notes (newline-joined)")
      .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
      .option("--reminder <HH:mm>", "set a reminder (24h); requires --when today|evening|date")
      .option("--clear-reminder", "clear the reminder (works while scheduled today|evening)")
      .option("--deadline <date>", "YYYY-MM-DD")
      .option("--clear-deadline", "remove the deadline")
      .option(
        "--created-at <iso>",
        "rewrite the creation timestamp (ISO date or datetime; a date is noon in the effective zone); status-safe",
      )
      .option(
        "--completed-at <iso>",
        "rewrite the completion timestamp of an already-resolved to-do (a canceled one stays canceled); open to-dos are refused — use complete/cancel",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const notesModes = ["notes", "appendNotes", "prependNotes"].filter(
      (k) => opts[k] !== undefined,
    );
    if (notesModes.length > 1) {
      usageError(opts, "--notes, --append-notes, --prepend-notes are exclusive");
      return;
    }
    if (opts["reminder"] !== undefined && opts["clearReminder"] === true) {
      usageError(opts, "pass at most one of --reminder / --clear-reminder");
      return;
    }
    if (!whenSugarOk(opts)) return;
    await runWrite(opts, (c) =>
      c.write.updateTodo(
        uuid,
        {
          ...(opts["title"] !== undefined && { title: opts["title"] as string }),
          ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
          ...(opts["appendNotes"] !== undefined && { appendNotes: opts["appendNotes"] as string }),
          ...(opts["prependNotes"] !== undefined && {
            prependNotes: opts["prependNotes"] as string,
          }),
          ...(opts["when"] !== undefined && { when: opts["when"] as never }),
          ...(opts["reminder"] !== undefined && { reminder: opts["reminder"] as string }),
          ...(opts["clearReminder"] === true && { reminder: null }),
          ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
          ...(opts["clearDeadline"] === true && { deadline: null }),
          ...(opts["createdAt"] !== undefined && { createdAt: opts["createdAt"] as string }),
          ...(opts["completedAt"] !== undefined && { completedAt: opts["completedAt"] as string }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  for (const verb of ["complete", "cancel"] as const) {
    const method = verb === "complete" ? "completeTodo" : "cancelTodo";
    const stampNote =
      verb === "complete"
        ? "resolving it first if needed, then backdating"
        : "keeping it canceled via the certified flip legs";
    addWriteFlags(
      todo
        .command(`${verb} <uuid>`)
        .description(
          `${verb[0]?.toUpperCase()}${verb.slice(1)} a to-do. Not available for repeating to-dos. ` +
            '--completed-at sets the completion timestamp (also the "Completed on" stamp for a canceled ' +
            `item), ${stampNote} — a multi-leg sequence, disclosed in the result and --dry-run.`,
        )
        .option(
          "--completed-at <iso>",
          "completion timestamp (ISO date or datetime; a date is noon in the effective zone)",
        ),
    ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      const resolution =
        opts["completedAt"] !== undefined ? { completedAt: opts["completedAt"] as string } : {};
      await runWrite(opts, (c) => c.write[method](uuid, resolution, writeOptionsFrom(opts)));
    });
  }

  addWriteFlags(
    todo
      .command("reopen <uuid>")
      .description("Reopen a to-do. Not available for repeating to-dos."),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.reopenTodo(uuid, writeOptionsFrom(opts)));
  });

  addPositionFlags(
    addWriteFlags(
      todo
        .command("move <refs...>")
        .description(
          "Move one or more to-dos as an ordered block (the argument order is the order they " +
            "land — name them backwards to reverse). MOVE changes WHAT a to-do belongs to; to " +
            "rearrange to-dos that already share a container use `things todo reorder`. Pass one " +
            "destination: --to-project / --to-heading / --to-area, or the detach family " +
            "--no-heading (leave the heading, stay in the project) / --loose (leave heading, " +
            "project, AND area). --inbox files back to the Inbox. Position with " +
            "--first/--last/--before/--after (an anchor positions but never migrates — an " +
            "anchor-only move that would cross containers is refused). Membership always " +
            "succeeds; placement is guaranteed for loose lists, a project's/area's members, a " +
            "heading's children, and a container's same-day scheduled children — the result " +
            "states the placement class, and a bounce that co-bounces unnamed siblings to honor " +
            "an anchor lists them. Set bounce-max-items to cap how many items a bounce touches; " +
            "bounce-enabled=false refuses bounce-dependent placements. Moving into a " +
            "completed/canceled project reopens it — requires --acknowledge-project-reopen.",
        )
        .option("--to-project <ref>", "destination project (uuid or unique name)")
        .option(
          "--to-heading <sel>",
          "destination heading (exact title or uuid; within --to-project)",
        )
        .option("--to-area <ref>", "destination area (uuid or unique name)")
        .option(
          "--no-heading",
          "leave the heading but stay in the current project (unheaded block)",
        )
        .option("--loose", "detach from heading, project, AND area (keeping the schedule)")
        .option("--inbox", "move back to the Inbox — removes any schedule")
        .option("--no-area", "(not a to-do flag — teaches the correct spelling)")
        .option("--detach", "(removed — teaches the replacement family)")
        .option("--acknowledge-project-reopen", "allow moving into a completed/canceled project"),
    ),
  ).action(async (refs: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
    const dest = todoDestination(opts);
    if (dest === "conflict") {
      usageError(
        opts,
        "pass at most one destination (--to-project/--to-heading/--to-area/--no-heading/--loose/--inbox)",
      );
      return;
    }
    const position = movePosition(opts);
    if (position === "conflict") {
      usageError(opts, "pass at most one of --first/--last/--before/--after");
      return;
    }
    const request: TodoMoveRequest = {
      uuids: refs,
      ...(dest !== undefined && { destination: dest }),
      ...(position !== undefined && { position }),
    };
    await runMoveCmd(opts, (c) =>
      c.write.moveTodos(
        request,
        writeOptionsFrom(opts, {
          ...(opts["acknowledgeProjectReopen"] !== undefined && {
            acknowledgeProjectReopen: opts["acknowledgeProjectReopen"] as boolean,
          }),
        }),
      ),
    );
  });

  addWriteFlags(
    todo
      .command("duplicate <uuid>")
      .description(
        "Duplicate a to-do — an exact copy; the copy's uuid is printed on success. Not " +
          "available for repeating to-dos.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.duplicateTodo(uuid, writeOptionsFrom(opts)));
  });

  addCreateTagsFlag(
    addWriteFlags(
      todo
        .command("tags <uuid>")
        .description(
          "Set or extend a to-do's tags. --set REPLACES the full tag set (an empty value " +
            "clears all tags); --add merges with the current tags. Each tag may be a name " +
            "or a parent/child path, and must exist unless --create-tags.",
        )
        .option("--set <list>", "comma-separated tags: full replacement")
        .option("--add <list>", "comma-separated tags: merge with existing"),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const set = splitCsv(opts["set"] as string | undefined);
    const add = splitCsv(opts["add"] as string | undefined);
    if ((set === undefined) === (add === undefined)) {
      usageError(opts, "pass exactly one of --set or --add");
      return;
    }
    await runWrite(opts, (c) =>
      set !== undefined
        ? c.write.setTags(uuid, set, writeOptionsFrom(opts, createTagsExtra(opts)))
        : c.write.addTags(uuid, add ?? [], writeOptionsFrom(opts, createTagsExtra(opts))),
    );
  });

  addWriteFlags(
    todo
      .command("checklist <uuid>")
      .description(
        "Edit a to-do's checklist. WHOLESALE: --item (repeatable) replaces the whole list, " +
          "discarding the existing items and their checked states — requires " +
          "--acknowledge-checklist-reset when items exist. GRANULAR (one action per call): " +
          "the flags below add, remove, check, uncheck, rename, or move a single item, with " +
          "every other item's checked state PRESERVED. Target an item by title or by --index " +
          "(1-based); duplicate titles resolve best-effort. Checklist items have no exposed uuid.",
      )
      .option("--item <text>", "wholesale: checklist item in order (repeatable)", collect, [])
      .option("--acknowledge-checklist-reset", "accept wholesale replacement of existing items")
      .option("--add <title>", "granular: append an item")
      .option("--at <n>", "with --add: 1-based insert position")
      .option("--remove [title]", "granular: delete an item (by title or --index)")
      .option("--check [title]", "granular: mark an item completed (by title or --index)")
      .option("--uncheck [title]", "granular: mark an item open (by title or --index)")
      .option(
        "--rename [title]",
        "granular: rename an item (target by title or --index; requires --to)",
      )
      .option("--move-item [title]", "granular: reposition an item (requires --to-position)")
      .option(
        "--index <n>",
        "granular: target the item at this 1-based position instead of a title",
      )
      .option("--to <title>", "new title for --rename")
      .option("--to-position <n>", "1-based position for --move-item"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const granular = ["add", "remove", "check", "uncheck", "rename", "moveItem"].filter(
      (k) => opts[k] !== undefined,
    );
    if (granular.length > 1) {
      usageError(opts, "pass at most ONE granular checklist action per call");
      return;
    }
    const action = granular[0];
    if (action !== undefined) {
      if ((opts["item"] as string[]).length > 0) {
        usageError(opts, "--item (wholesale) is exclusive with granular actions");
        return;
      }
      if (action === "rename" && opts["to"] === undefined) {
        usageError(opts, "--rename requires --to <title>");
        return;
      }
      if (action === "moveItem" && opts["toPosition"] === undefined) {
        usageError(opts, "--move-item requires --to-position <n>");
        return;
      }
      // Target: --index (1-based) OR the action flag's title value. When a
      // targeting flag is present without a value commander yields `true`.
      const target: { index?: number; item?: string } =
        opts["index"] !== undefined
          ? { index: Number(opts["index"]) }
          : { item: flagVal(opts[action]) ?? "" };
      if (action !== "add" && opts["index"] === undefined && target.item === "") {
        usageError(opts, `--${action} needs a title, or use --index <n>`);
        return;
      }
      const edit =
        action === "add"
          ? {
              action: "add" as const,
              title: opts["add"] as string,
              ...(opts["at"] !== undefined && { at: Number(opts["at"]) }),
            }
          : action === "remove"
            ? { action: "remove" as const, ...target }
            : action === "check"
              ? { action: "check" as const, ...target }
              : action === "uncheck"
                ? { action: "uncheck" as const, ...target }
                : action === "rename"
                  ? { action: "rename" as const, ...target, title: opts["to"] as string }
                  : { action: "move" as const, ...target, to: Number(opts["toPosition"]) };
      if (opIdCompoundRefused(opts, "a granular checklist edit")) return;
      await runWrite(opts, (c) => c.write.editChecklist(uuid, edit, writeOptionsFrom(opts)));
      return;
    }
    await runWrite(opts, (c) =>
      c.write.replaceChecklist(
        uuid,
        opts["item"] as string[],
        writeOptionsFrom(opts, {
          ...(opts["acknowledgeChecklistReset"] !== undefined && {
            acknowledgeChecklistReset: opts["acknowledgeChecklistReset"] as boolean,
          }),
        }),
      ),
    );
  });

  addWriteFlags(
    todo
      .command("delete <uuid>")
      .description(
        "Move a to-do to the Trash (recover with `things todo restore`). Not available " +
          "for repeating to-dos.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.deleteTodo(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    todo
      .command("restore <uuid>")
      .description(
        "Restore a TRASHED to-do: it returns to the Inbox, DE-SCHEDULED — its previous " +
          "list and schedule are not restored. Only trashed to-dos qualify; for projects " +
          "use `things project restore`.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.restoreTodo(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    todo
      .command("clear-reminder <uuid>")
      .description(
        "Clear a to-do's time-of-day reminder, keeping its scheduled date. With the proxy " +
          "shortcuts installed (`things setup shortcuts`) this is in place, and is the only " +
          "way for a repeating to-do; otherwise a date-scheduled to-do is cleared by a brief " +
          "re-schedule through Today. Reversible with `things undo`.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    if (opIdCompoundRefused(opts, "clear-reminder")) return;
    await runWrite(opts, (c) => c.write.clearReminder(uuid, writeOptionsFrom(opts)));
  });

  // NB: the bespoke `todo backdate` / `todo add-logged` commands were removed
  // (plan PR A). Backdated creation and Logbook import are now `todo add
  // --created-at/--completed-at`; rewriting an existing item's timestamps is
  // `todo update --created-at/--completed-at` (or complete/cancel --completed-at).

  // --- ui vector: GUI-driven transforms (two-key gated) --------------------

  const REPEAT_FREQ_HELP = "daily | weekly | monthly | yearly";
  const REPEAT_INTERVAL_HELP = "every N units (1–99)";

  for (const [verb, op, desc] of [
    [
      "make-repeating",
      "todo.make-repeating",
      "Turn a plain to-do into a repeating one. This REPLACES the to-do with a new repeating " +
        "series — the original disappears and a fresh recurring item takes its place " +
        "(cannot be undone). Set the rule with the flags below; see `things help repeating`.",
    ],
    [
      "reschedule-repeat",
      "todo.reschedule-repeat",
      "Change an existing repeating to-do's rule in place (the item keeps its identity). Set the " +
        "new rule with the flags below; see `things help repeating`. `things undo` restores the " +
        "previous rule.",
    ],
  ] as const) {
    addDriveGuiFlag(
      addRepeatRuleFlags(
        addWriteFlags(
          todo
            .command(`${verb} <uuid>`)
            .description(desc)
            .requiredOption("--frequency <freq>", REPEAT_FREQ_HELP)
            .requiredOption("--interval <n>", REPEAT_INTERVAL_HELP),
        ),
      ),
    ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      const frequency = opts["frequency"] as RepeatFrequency;
      await runWrite(opts, (c) =>
        c.write.run(
          op,
          {
            uuid,
            frequency,
            interval: Number(opts["interval"]),
            ...repeatRuleFlagsFromOpts(opts, frequency),
          },
          writeOptionsFrom(opts),
        ),
      );
    });
  }

  for (const [verb, op, desc] of [
    [
      "pause-repeat",
      "todo.pause-repeat",
      "Pause a repeating to-do: it stops spawning new occurrences but keeps its rule. Reversible " +
        "with `things todo resume-repeat`.",
    ],
    [
      "resume-repeat",
      "todo.resume-repeat",
      "Resume a paused repeating to-do: it starts spawning occurrences again.",
    ],
    [
      "convert-to-project",
      "todo.convert-to-project",
      "Convert a to-do into a project. This REPLACES the to-do with a new project (its notes are " +
        "kept); the to-do's identity is gone and it cannot be undone. The new project's uuid is " +
        "printed on success.",
    ],
  ] as const) {
    addDriveGuiFlag(addWriteFlags(todo.command(`${verb} <uuid>`).description(desc))).action(
      async (uuid: string, opts: WriteFlagOpts) => {
        await runWrite(opts, (c) => c.write.run(op, { uuid }, writeOptionsFrom(opts)));
      },
    );
  }

  const project = group(program, "project", "Project-scoped operations");

  // --- project headings (spec §2) ------------------------------------------
  // A heading exists only inside a project. Each verb takes <project-ref> then
  // a heading selector: an exact title OR a uuid (never an ordinal — an index
  // silently re-targets a different heading after any reorder). An empty-string
  // title selects a titleless heading; duplicates fail closed with uuid
  // candidates.

  addPlacementFlags(
    addWriteFlags(
      project
        .command("add-heading <project> <title>")
        .description(
          "Create a heading inside an existing project; its uuid is printed on success. The " +
            "project must name an existing project (uuid or unique name). Uses the Things proxy " +
            "shortcuts — run `things setup shortcuts` once first. By default the heading is " +
            "appended; a placement flag positions it among the project's headings (that leg " +
            "needs `things config set allow-experimental true`).",
        ),
    ),
  ).action(
    async (projectRef: string, title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      if (countPlacementFlags(opts) > 1) {
        usageError(
          opts,
          "pass at most one of --first / --last / --before-heading / --after-heading",
        );
        return;
      }
      if (opIdCompoundRefused(opts, "add-heading")) return;
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const placement = headingPlacement(c, proj.uuid, opts);
        return c.write.addHeading({ uuid: proj.uuid }, title, placement, writeOptionsFrom(opts));
      });
    },
  );

  addWriteFlags(
    project
      .command("rename-heading <project> <heading>")
      .description(
        `Rename a heading in place (works on archived headings too). <heading> is a ${HEADING_SEL_HELP}.`,
      )
      .requiredOption("--to <title>", "the new heading title"),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const h = c.resolve.heading(proj.uuid, sel);
        return c.write.renameHeading(h.uuid, opts["to"] as string, writeOptionsFrom(opts));
      });
    },
  );

  addWriteFlags(
    project
      .command("archive-heading <project> <heading>")
      .description(
        "Archive a heading — it leaves the active project view (reversible with " +
          "`things project unarchive-heading`). This is the preferred way to retire a heading: " +
          "row DELETION exists only in the app's UI and Shortcuts with a per-run consent " +
          "dialog, never headlessly. With open children, --children is required: " +
          "complete/cancel resolve them with the heading (one atomic cascade); reparent " +
          "moves them to the project root first, keeping them open — a compound sequence " +
          `that \`things undo\` reverses as one unit. <heading> is a ${HEADING_SEL_HELP}.`,
      )
      .option(
        "--children <policy>",
        "complete | cancel | reparent (required when children are open)",
      ),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      const children = opts["children"] as "complete" | "cancel" | "reparent" | undefined;
      if (opIdCompoundRefused(opts, "archive-heading")) return;
      await runWrite(opts, async (c) => {
        const proj = c.resolve.project(projectRef);
        const h = c.resolve.heading(proj.uuid, sel);
        const outcome = await c.write.archiveHeading(
          h.uuid,
          children ? { children } : {},
          writeOptionsFrom(opts),
        );
        for (const leg of outcome.reparented) {
          process.stderr.write(`reparented: ${leg.title} (${leg.result.kind})\n`);
        }
        return outcome.heading;
      });
    },
  );

  addWriteFlags(
    project
      .command("unarchive-heading <project> <heading>")
      .description(
        "Un-archive a heading. --restore-children also reopens the children the archive " +
          "cascade resolved with it (identified by matching resolution timestamps; a " +
          "someday child comes back as someday). Children resolved at other times are " +
          `never touched. <heading> is a ${HEADING_SEL_HELP}.`,
      )
      .option("--restore-children", "reopen cascade-resolved children too"),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      if (opIdCompoundRefused(opts, "unarchive-heading")) return;
      await runWrite(opts, async (c) => {
        const proj = c.resolve.project(projectRef);
        const h = c.resolve.heading(proj.uuid, sel);
        const outcome = await c.write.unarchiveHeading(
          h.uuid,
          opts["restoreChildren"] === true ? { restoreChildren: true } : {},
          writeOptionsFrom(opts),
        );
        for (const child of outcome.children) {
          process.stderr.write(`restored: ${child.title} (${child.result.kind})\n`);
        }
        return outcome.heading;
      });
    },
  );

  addDriveGuiFlag(
    addWriteFlags(
      project
        .command("promote-heading <project> <heading>")
        .description(
          "Promote a heading into a project. This REPLACES the heading with a new project — it " +
            "is promoted alongside its parent project (into the same area) and the heading's " +
            "to-dos move under the new project. The heading's identity is gone and it cannot be " +
            `undone. The new project's uuid is printed on success. <heading> is a ${HEADING_SEL_HELP}.`,
        ),
    ),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const h = c.resolve.heading(proj.uuid, sel);
        return c.write.run("project.promote-heading", { uuid: h.uuid }, writeOptionsFrom(opts));
      });
    },
  );

  addPlacementFlags(
    addWriteFlags(
      project
        .command("move-heading <project> <headings...>")
        .description(
          "Reposition one or more of a project's headings as an ordered block — the selection " +
            "order is the resulting order, and each heading's to-dos follow it. Pass exactly one " +
            "placement: --first, --last, --before-heading <sel>, or --after-heading <sel>. Each " +
            `<heading> is a ${HEADING_SEL_HELP}. Reordering headings rides the same experimental ` +
            "surface as `things reorder` — enable it once with `things config set " +
            "allow-experimental true`.",
        ),
    ),
  ).action(
    async (projectRef: string, sels: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
      if (countPlacementFlags(opts) !== 1) {
        usageError(
          opts,
          "pass exactly one of --first / --last / --before-heading / --after-heading",
        );
        return;
      }
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const headings = sels.map((s) => c.resolve.heading(proj.uuid, s).uuid);
        const placement = headingPlacement(c, proj.uuid, opts) as HeadingPlacement;
        return c.write.moveHeading(
          { uuid: proj.uuid },
          headings,
          placement,
          writeOptionsFrom(opts),
        );
      });
    },
  );

  addWriteFlags(
    project
      .command("move-heading-to-project <project> <heading>")
      .requiredOption("--to <project>", "destination project (uuid or unique title)")
      .description(
        "Move a heading — WITH its to-dos — to a DIFFERENT project. This is the cross-project " +
          "relocation, distinct from `move-heading` (which only reorders a heading within its own " +
          `project). <heading> is a ${HEADING_SEL_HELP} in the SOURCE <project>; --to names the ` +
          "destination. GUI-ONLY: it drives the heading row's ellipsis Move… menu, so enable it " +
          "once with `things config set ui.enabled true` and pass --dangerously-drive-gui. Fails " +
          "closed when the heading title is shared by another heading in the project, or the " +
          "destination title by another project (the drive addresses both by title). No undo — " +
          "move it back to reverse.",
      ),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const dest = c.resolve.project(String(opts["to"]));
        return c.write.moveHeadingToProject(
          { uuid: proj.uuid },
          sel,
          { uuid: dest.uuid },
          writeOptionsFrom(opts),
        );
      });
    },
  );

  addWriteFlags(
    project
      .command("dissolve-heading <project> <heading>")
      .description(
        "Dissolve a heading — remove it but KEEP its to-dos, which become direct children of the " +
          "project (in the same order), NOT trashed. This is the opposite of deleting: nothing is " +
          `lost. <heading> is a ${HEADING_SEL_HELP}. Contrast \`things todo delete\` and the ` +
          "Shortcuts heading-delete cascade, which TRASH the children. GUI-ONLY (drives the " +
          "heading row's ellipsis Delete): enable it once with `things config set ui.enabled true` " +
          "and pass --dangerously-drive-gui. Fails closed when the heading title is shared by " +
          "another heading in the project. No undo — re-create the heading and move the to-dos back.",
      ),
  ).action(
    async (projectRef: string, sel: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      await runWrite(opts, (c) => {
        const proj = c.resolve.project(projectRef);
        const h = c.resolve.heading(proj.uuid, sel);
        return c.write.dissolveHeading(h.uuid, writeOptionsFrom(opts));
      });
    },
  );

  // --- ui vector: repeating-project transforms (two-key gated) -------------
  addDriveGuiFlag(
    addRepeatRuleFlags(
      addWriteFlags(
        project
          .command("reschedule-repeat <ref>")
          .description(
            "Change an existing repeating project's rule in place (target by uuid or unique name; " +
              "the project keeps its identity). Set the new rule with the flags below; see " +
              "`things help repeating`. `things undo` restores the previous rule.",
          )
          .requiredOption("--frequency <freq>", REPEAT_FREQ_HELP)
          .requiredOption("--interval <n>", REPEAT_INTERVAL_HELP),
      ),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const frequency = opts["frequency"] as RepeatFrequency;
    await runWrite(opts, (c) =>
      c.write.run(
        "project.reschedule-repeat",
        {
          uuid,
          frequency,
          interval: Number(opts["interval"]),
          ...repeatRuleFlagsFromOpts(opts, frequency),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  for (const [verb, op, desc] of [
    [
      "pause-repeat",
      "project.pause-repeat",
      "Pause a repeating project: it stops spawning new occurrences but keeps its rule. Reversible " +
        "with `things project resume-repeat`.",
    ],
    [
      "resume-repeat",
      "project.resume-repeat",
      "Resume a paused repeating project: it starts spawning occurrences again.",
    ],
  ] as const) {
    addDriveGuiFlag(addWriteFlags(project.command(`${verb} <ref>`).description(desc))).action(
      async (uuid: string, opts: WriteFlagOpts) => {
        await runWrite(opts, (c) => c.write.run(op, { uuid }, writeOptionsFrom(opts)));
      },
    );
  }

  addDriveGuiFlag(
    addRepeatRuleFlags(
      addWriteFlags(
        project
          .command("make-repeating <ref>")
          .description(
            "Turn a project into a repeating one. This REPLACES the project with a new repeating " +
              "series — the original disappears and a fresh recurring project takes its place (its " +
              "area is kept; cannot be undone). An Anytime project with no area is moved to Someday " +
              "first (a cleanup-free intermediate step, shown in --dry-run). Set the rule with the " +
              "flags below; see `things help repeating`.",
          )
          .requiredOption("--frequency <freq>", REPEAT_FREQ_HELP)
          .requiredOption("--interval <n>", REPEAT_INTERVAL_HELP),
      ),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const frequency = opts["frequency"] as RepeatFrequency;
    if (opIdCompoundRefused(opts, "project make-repeating")) return;
    await runWrite(opts, (c) =>
      c.write.makeRepeatingProject(
        uuid,
        {
          frequency,
          interval: Number(opts["interval"]),
          ...repeatRuleFlagsFromOpts(opts, frequency),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addDriveGuiFlag(
    addWriteFlags(
      project
        .command("add-repeating <title>")
        .description(
          "Create a project and turn it into a repeating series in ONE call. Two operations: the " +
            "project is created first and PERSISTS even if the make-repeating step refuses; then it " +
            "is promoted (which drives the GUI). Give --area to place it, or omit it to create in " +
            "Someday. The new repeating project's uuid is printed on success.",
        )
        .option("--notes <text>", "notes body")
        .option("--area <ref>", "destination area (uuid or unique name)")
        .option("--deadline <date>", "YYYY-MM-DD")
        .option("--todo <title>", "initial child to-do (repeatable)", collect, [])
        .requiredOption("--frequency <freq>", REPEAT_FREQ_HELP)
        .requiredOption("--interval <n>", REPEAT_INTERVAL_HELP),
    ),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const todos = opts["todo"] as string[];
    const area = containerRef(opts["area"] as string | undefined);
    if (opIdCompoundRefused(opts, "project add-repeating")) return;
    await runWrite(opts, (c) =>
      c.write.addRepeatingProject(
        {
          title,
          ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
          ...(area !== undefined && { area }),
          ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
          ...(todos.length > 0 && { todos }),
          frequency: opts["frequency"] as RepeatFrequency,
          interval: Number(opts["interval"]),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    project
      .command("add <title>")
      .description(
        "Create a project; its uuid is printed on success. Give --todo (repeatable) to " +
          "seed it with child to-dos in the same call — the quick way to stand up a new " +
          "project skeleton.",
      )
      .option("--notes <text>", "notes body")
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
      .option("--deadline <date>", "YYYY-MM-DD")
      .option(
        "--todo <title>",
        "initial child to-do, repeatable (seeds the new project)",
        collect,
        [],
      )
      .option(
        "--created-at <iso>",
        "born with this creation timestamp (ISO date or datetime; a date is noon in the effective zone)",
      )
      .option(
        "--completed-at <iso>",
        "born completed (in the Logbook) with this completion timestamp; cannot seed open child to-dos (§5b)",
      ),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const todos = opts["todo"] as string[];
    const area = containerRef(opts["area"] as string | undefined);
    await runWrite(opts, (c) =>
      c.write.addProject(
        {
          title,
          ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
          ...(area !== undefined && { area }),
          ...(opts["when"] !== undefined && { when: opts["when"] as never }),
          ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
          ...(todos.length > 0 && { todos }),
          ...(opts["createdAt"] !== undefined && { createdAt: opts["createdAt"] as string }),
          ...(opts["completedAt"] !== undefined && { completedAt: opts["completedAt"] as string }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    project
      .command("update <ref>")
      .description(
        "Update a project's title/notes/when/deadline/reminder. Target by uuid or unique " +
          "name — a duplicated project name is refused, listing the candidates to pick from " +
          "by uuid. --append-notes/--prepend-notes join with a newline (exclusive with " +
          "--notes). --reminder needs --when today|evening|YYYY-MM-DD; when re-scheduling " +
          "WITHOUT --reminder an existing reminder is auto-preserved.",
      ),
  )
    .option("--title <text>", "new title")
    .option("--notes <text>", "replace notes")
    .option("--append-notes <text>", "append to existing notes (newline-joined)")
    .option("--prepend-notes <text>", "prepend to existing notes (newline-joined)")
    .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
    .option("--reminder <HH:mm>", "set a reminder (24h); requires --when today|evening|date")
    .option("--clear-reminder", "clear the reminder (works while scheduled today|evening)")
    .option("--deadline <date>", "YYYY-MM-DD")
    .option("--clear-deadline", "remove the deadline")
    .option(
      "--created-at <iso>",
      "rewrite the creation timestamp (ISO date or datetime; a date is noon in the effective zone); status-safe",
    )
    .option(
      "--completed-at <iso>",
      "rewrite the completion timestamp of an already-resolved project (a canceled one stays canceled); open projects are refused — use complete/cancel",
    )
    .action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      const notesModes = ["notes", "appendNotes", "prependNotes"].filter(
        (k) => opts[k] !== undefined,
      );
      if (notesModes.length > 1) {
        usageError(opts, "--notes, --append-notes, --prepend-notes are exclusive");
        return;
      }
      if (opts["reminder"] !== undefined && opts["clearReminder"] === true) {
        usageError(opts, "pass at most one of --reminder / --clear-reminder");
        return;
      }
      if (!whenSugarOk(opts)) return;
      await runWrite(opts, (c) =>
        c.write.updateProject(
          uuid,
          {
            ...(opts["title"] !== undefined && { title: opts["title"] as string }),
            ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
            ...(opts["appendNotes"] !== undefined && {
              appendNotes: opts["appendNotes"] as string,
            }),
            ...(opts["prependNotes"] !== undefined && {
              prependNotes: opts["prependNotes"] as string,
            }),
            ...(opts["when"] !== undefined && { when: opts["when"] as never }),
            ...(opts["reminder"] !== undefined && { reminder: opts["reminder"] as string }),
            ...(opts["clearReminder"] === true && { reminder: null }),
            ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
            ...(opts["clearDeadline"] === true && { deadline: null }),
            ...(opts["createdAt"] !== undefined && { createdAt: opts["createdAt"] as string }),
            ...(opts["completedAt"] !== undefined && {
              completedAt: opts["completedAt"] as string,
            }),
          },
          writeOptionsFrom(opts),
        ),
      );
    });

  addCreateTagsFlag(
    addWriteFlags(
      project
        .command("tags <ref>")
        .description(
          "Set or extend a project's tags (target by uuid or unique name). --set REPLACES the " +
            "full tag set (an empty value clears all tags); --add merges with the current tags. " +
            "Each tag may be a name or a parent/child path, and must exist unless " +
            "--create-tags.",
        )
        .option("--set <list>", "comma-separated tags: full replacement")
        .option("--add <list>", "comma-separated tags: merge with existing"),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const set = splitCsv(opts["set"] as string | undefined);
    const add = splitCsv(opts["add"] as string | undefined);
    if ((set === undefined) === (add === undefined)) {
      usageError(opts, "pass exactly one of --set or --add");
      return;
    }
    await runWrite(opts, (c) =>
      set !== undefined
        ? c.write.setProjectTags(uuid, set, writeOptionsFrom(opts, createTagsExtra(opts)))
        : c.write.addProjectTags(uuid, add ?? [], writeOptionsFrom(opts, createTagsExtra(opts))),
    );
  });

  addPositionFlags(
    addWriteFlags(
      project
        .command("move <refs...>")
        .description(
          "Move one or more projects as an ordered block (argument order = resulting order). " +
            "Pass one destination: --to-area (uuid or unique name) or --no-area (leave the " +
            "area — a project's complete detach). Position among siblings with " +
            "--first/--last/--before/--after (an anchor positions but never migrates). " +
            "Membership always succeeds; top-of-bucket placement is guaranteed only where a " +
            "reorder protocol exists (the result states the class). Status and schedule are " +
            "untouched.",
        )
        .option("--to-area <ref>", "destination area (uuid or unique name)")
        .option("--no-area", "leave the current area (a project's single-level detach)")
        .option("--loose", "(not a project flag — teaches the correct spelling)")
        .option("--detach", "(removed — teaches the replacement)"),
    ),
  ).action(async (refs: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
    const dest = projectDestination(opts);
    if (dest === "conflict") {
      usageError(opts, "pass at most one of --to-area / --no-area");
      return;
    }
    const position = movePosition(opts);
    if (position === "conflict") {
      usageError(opts, "pass at most one of --first/--last/--before/--after");
      return;
    }
    const request: ProjectMoveRequest = {
      uuids: refs,
      ...(dest !== undefined && { destination: dest }),
      ...(position !== undefined && { position }),
    };
    await runMoveCmd(opts, (c) => c.write.moveProjects(request, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    project
      .command("cancel <ref>")
      .description(
        "Cancel a project (target by uuid or unique name). Canceling also cancels its open " +
          "to-dos, so an explicit --children policy is required; already-completed children " +
          "are never altered. --completed-at sets the completion timestamp and keeps the project " +
          "canceled via the certified flip legs (multi-leg, disclosed); it is refused while the " +
          "project still has open children.",
      )
      .requiredOption(
        "--children <policy>",
        "require-resolved (error if open to-dos remain) | auto-cancel (cancel them too)",
      )
      .option(
        "--completed-at <iso>",
        "completion timestamp (ISO date or datetime; a date is noon in the effective zone)",
      ),
  ).action(
    async (uuid: string, opts: WriteFlagOpts & { children: string } & Record<string, unknown>) => {
      await runWrite(opts, (c) =>
        c.write.cancelProject(
          uuid,
          {
            children: opts.children as "require-resolved" | "auto-cancel",
            ...(opts["completedAt"] !== undefined && {
              completedAt: opts["completedAt"] as string,
            }),
          },
          writeOptionsFrom(opts),
        ),
      );
    },
  );

  addWriteFlags(
    project
      .command("reopen <ref>")
      .description(
        "Reopen a completed/canceled project (target by uuid or unique name). Its children " +
          "stay completed/canceled unless " +
          "--restore-children also reopens the ones that were resolved together with the " +
          "project — children resolved earlier are never touched. Exit 3 if any child " +
          "restore fails.",
      )
      .option("--restore-children", "also reopen the children resolved with the project"),
  ).action(async (uuid: string, opts: WriteFlagOpts & { restoreChildren?: boolean }) => {
    if (opIdCompoundRefused(opts, "project reopen")) return;
    const started = Date.now();
    let client: ThingsClient | null = null;
    try {
      client = openThings(opts.db ? { dbPath: opts.db } : {});
      const outcome = await client.write.reopenProject(uuid, {
        ...writeOptionsFrom(opts),
        ...(opts.restoreChildren === true && { restoreChildren: true }),
      });
      const failedChildren = outcome.children.filter(
        (c) => c.result.kind !== "ok" && c.result.kind !== "dry-run",
      );
      if (opts.json) {
        const fp = client.fingerprint();
        const meta: EnvelopeMeta = {
          dbVersion: fp.observation.databaseVersion,
          fingerprint: fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown",
          elapsedMs: Date.now() - started,
        };
        process.stdout.write(`${JSON.stringify(okEnvelope("project-reopen", outcome, meta))}\n`);
      } else {
        emitResult(
          outcome.project,
          { ...opts, json: false },
          {
            dbVersion: null,
            fingerprint: "unknown",
            elapsedMs: Date.now() - started,
          },
        );
        for (const child of outcome.children) {
          process.stdout.write(
            `  child ${child.result.kind === "ok" || child.result.kind === "dry-run" ? "reopened" : "FAILED"}: ${child.title} (${child.uuid})\n`,
          );
        }
      }
      process.exitCode =
        outcome.project.kind === "ok" || outcome.project.kind === "dry-run"
          ? failedChildren.length > 0
            ? ExitCode.VerifyFailed
            : ExitCode.Ok
          : process.exitCode;
    } finally {
      client?.close();
    }
  });

  addWriteFlags(
    project
      .command("restore <ref>")
      .description(
        "Restore a TRASHED project IN PLACE (target by uuid or unique name): schedule, area, " +
          "and children all keep their state. Only trashed projects qualify.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.restoreProject(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    project
      .command("duplicate <ref>")
      .description(
        "Duplicate a project (target by uuid or unique name) INCLUDING its children; the " +
          "copy's uuid is printed on success. Not available for repeating projects.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.duplicateProject(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    project
      .command("complete <ref>")
      .description(
        "Complete a project (target by uuid or unique name). Completing also completes its " +
          "open to-dos, so an explicit --children policy is required. --completed-at sets the " +
          "completion timestamp and backdates it (multi-leg, disclosed).",
      )
      .requiredOption(
        "--children <policy>",
        "require-resolved (error if open to-dos remain) | auto-complete (complete them too)",
      )
      .option(
        "--completed-at <iso>",
        "completion timestamp (ISO date or datetime; a date is noon in the effective zone)",
      ),
  ).action(
    async (uuid: string, opts: WriteFlagOpts & { children: string } & Record<string, unknown>) => {
      await runWrite(opts, (c) =>
        c.write.completeProject(
          uuid,
          {
            children: opts.children as "require-resolved" | "auto-complete",
            ...(opts["completedAt"] !== undefined && {
              completedAt: opts["completedAt"] as string,
            }),
          },
          writeOptionsFrom(opts),
        ),
      );
    },
  );

  addWriteFlags(
    project
      .command("delete <ref>")
      .description(
        "Move a project (target by uuid or unique name) to the Trash; its children go with " +
          "it (recover with `things project restore`).",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.deleteProject(uuid, writeOptionsFrom(opts)));
  });

  const area = group(program, "area", "Area-scoped operations");
  addCreateTagsFlag(
    addWriteFlags(
      area
        .command("add <title>")
        .description(
          "Create an area, optionally tagged. Each tag may be a name or a " +
            "parent/child path, and must exist unless --create-tags.",
        )
        .option(
          "--tags <list>",
          "comma-separated tags; each a name or a parent/child path (must exist unless --create-tags)",
        ),
    ),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const tags = splitCsv(opts["tags"] as string | undefined);
    await runWrite(opts, (c) =>
      c.write.addArea(
        { title, ...(tags !== undefined && { tags }) },
        writeOptionsFrom(opts, createTagsExtra(opts)),
      ),
    );
  });
  addCreateTagsFlag(
    addWriteFlags(
      area
        .command("update <ref>")
        .description(
          "Rename an area and/or replace its tags (the full set). Each tag may be a name " +
            "or a parent/child path, and must exist unless --create-tags. Target by " +
            "uuid or unique name.",
        )
        .option("--title <text>", "new name")
        .option(
          "--tags <list>",
          'comma-separated tags (full replacement; "" clears all); each a name or a parent/child path',
        ),
    ),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const tags = splitCsv(opts["tags"] as string | undefined);
    if (opts["title"] === undefined && tags === undefined) {
      usageError(opts, "pass --title and/or --tags");
      return;
    }
    await runWrite(opts, (c) =>
      c.write.updateArea(
        target,
        {
          ...(opts["title"] !== undefined && { title: opts["title"] as string }),
          ...(tags !== undefined && { tags }),
        },
        writeOptionsFrom(opts, createTagsExtra(opts)),
      ),
    );
  });

  addDriveGuiFlag(
    addWriteFlags(
      area
        .command("reorder <ref>")
        .description(
          "Move an area to a new position in the area order (target by uuid or unique name). " +
            "Pass exactly one destination: --before/--after another area, or --first/--last. " +
            "This visibly drives the Things app (the window comes forward and the sidebar may " +
            "scroll); the area's projects and to-dos are untouched.",
        )
        .option("--before <area>", "place it immediately above this area (uuid or unique name)")
        .option("--after <area>", "place it immediately below this area (uuid or unique name)")
        .option("--first", "move it to the top of the area list")
        .option("--last", "move it to the bottom of the area list"),
    ),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const chosen = [
      opts["before"] !== undefined,
      opts["after"] !== undefined,
      opts["first"] === true,
      opts["last"] === true,
    ].filter(Boolean).length;
    if (chosen !== 1) {
      usageError(opts, "pass exactly one of --before / --after / --first / --last");
      return;
    }
    await runWrite(opts, (c) =>
      c.write.run(
        "area.reorder",
        {
          target,
          ...(opts["before"] !== undefined && { before: opts["before"] as string }),
          ...(opts["after"] !== undefined && { after: opts["after"] as string }),
          ...(opts["first"] === true && { position: "first" as const }),
          ...(opts["last"] === true && { position: "last" as const }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    area
      .command("delete <ref>")
      .description(
        "Delete an area PERMANENTLY — areas do not go to the Trash, so this cannot be " +
          "undone; requires --dangerously-permanent. Deleting an area moves its to-dos and " +
          "projects to the Trash, so a non-empty area is refused unless you pass " +
          "--allow-non-empty; empty the area first to keep its contents.",
      )
      .option("--dangerously-permanent", "accept permanent, unrecoverable deletion")
      .option(
        "--allow-non-empty",
        "delete the area together with its contents (its to-dos and projects move to the Trash)",
      ),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.deleteArea(
        target,
        writeOptionsFrom(opts, {
          ...(opts["dangerouslyPermanent"] !== undefined && {
            dangerouslyPermanent: opts["dangerouslyPermanent"] as boolean,
          }),
          ...(opts["allowNonEmpty"] !== undefined && {
            allowNonEmptyArea: opts["allowNonEmpty"] as boolean,
          }),
        }),
      ),
    );
  });

  const tag = group(program, "tag", "Tag-scoped operations");
  addWriteFlags(
    tag
      .command("add <name>")
      .description("Create a tag; --parent nests it under an existing tag.")
      .option("--parent <name>", "existing parent tag"),
  ).action(async (name: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.addTag(
        { title: name, ...(opts["parent"] !== undefined && { parent: opts["parent"] as string }) },
        writeOptionsFrom(opts),
      ),
    );
  });
  addWriteFlags(
    tag
      .command("update <ref>")
      .description(
        "Rename a tag (existing assignments follow the rename), nest it under an existing " +
          "tag, UN-NEST it to the root (--unnest; exclusive with --parent), and set or clear " +
          "its keyboard shortcut (--shortcut / --clear-shortcut, exclusive).",
      )
      .option("--title <text>", "new name")
      .option("--parent <name>", "existing tag to nest under")
      .option("--unnest", "move the tag to the root of the hierarchy")
      .option("--shortcut <char>", "keyboard shortcut character")
      .option("--clear-shortcut", "remove the keyboard shortcut"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    if (
      opts["title"] === undefined &&
      opts["parent"] === undefined &&
      opts["unnest"] === undefined &&
      opts["shortcut"] === undefined &&
      opts["clearShortcut"] === undefined
    ) {
      usageError(opts, "pass --title, --parent, --unnest, --shortcut, and/or --clear-shortcut");
      return;
    }
    if (opts["parent"] !== undefined && opts["unnest"] === true) {
      usageError(opts, "--parent and --unnest are exclusive");
      return;
    }
    if (opts["shortcut"] !== undefined && opts["clearShortcut"] === true) {
      usageError(opts, "--shortcut and --clear-shortcut are exclusive");
      return;
    }
    await runWrite(opts, (c) =>
      c.write.updateTag(
        target,
        {
          ...(opts["title"] !== undefined && { title: opts["title"] as string }),
          ...(opts["parent"] !== undefined && { parent: opts["parent"] as string }),
          ...(opts["unnest"] === true && { unnest: true }),
          ...(opts["shortcut"] !== undefined && { shortcut: opts["shortcut"] as string }),
          ...(opts["clearShortcut"] === true && { clearShortcut: true }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    tag
      .command("delete <ref>")
      .description(
        "Delete a tag PERMANENTLY — tags do not go to the Trash, so this cannot be " +
          "undone; requires --dangerously-permanent. The tag is removed from every item, " +
          "and ALL of its nested child tags are deleted with it — requires " +
          "--acknowledge-subtree when children exist.",
      )
      .option("--dangerously-permanent", "accept permanent, unrecoverable deletion")
      .option("--acknowledge-subtree", "accept cascade-deletion of ALL descendant tags"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.deleteTag(
        target,
        writeOptionsFrom(opts, {
          ...(opts["dangerouslyPermanent"] !== undefined && {
            dangerouslyPermanent: opts["dangerouslyPermanent"] as boolean,
          }),
          ...(opts["acknowledgeSubtree"] === true && { acknowledgeTagSubtree: true }),
        }),
      ),
    );
  });

  const trash = group(program, "trash", "Trash-scoped operations");
  addWriteFlags(
    trash
      .command("empty")
      .description(
        "Empty the Trash: PERMANENTLY deletes every trashed item — this cannot be undone. " +
          "Requires --dangerously-permanent.",
      )
      .option("--dangerously-permanent", "accept permanent, unrecoverable deletion"),
  ).action(async (rawOpts: WriteFlagOpts & Record<string, unknown>, cmd: Command) => {
    // The parent `trash` READ command declares --json/--db too and consumes
    // flags along the dispatch chain — merge parent-captured globals back in.
    const opts = { ...cmd.optsWithGlobals(), ...rawOpts } as WriteFlagOpts &
      Record<string, unknown>;
    await runWrite(opts, (c) =>
      c.write.emptyTrash(
        writeOptionsFrom(opts, {
          ...(opts["dangerouslyPermanent"] !== undefined && {
            dangerouslyPermanent: opts["dangerouslyPermanent"] as boolean,
          }),
        }),
      ),
    );
  });

  program
    .command("batch [file]")
    .description(
      "Run MANY mutations from JSONL (file, or stdin when omitted/'-'): one op per line, " +
        '{"op": "<kind>", "params": {...}, "options": {...}} — see `things capabilities` for ' +
        "op kinds and params. Ops run sequentially and independently — NO transactions; a " +
        "failure does not roll back earlier ops. Per-op results stream as JSONL. Per-op " +
        "options carry the confirmation flags (acknowledgeChecklistReset, " +
        "acknowledgeProjectReopen, dangerouslyPermanent, acknowledgeTagSubtree). " +
        "CHAINING: an op that creates something may carry a `tempId` (a handle like " +
        '"proj1"); a LATER op references that new uuid as "$proj1" in any id/container ' +
        'param (dotted "$proj1.instance"/"$proj1.replaced" reach a repeating op\'s spawned ' +
        "instance / replaced source). A tempId is valid only on a creating op (not tag.add — " +
        "reference a tag by title) and unique per batch; an unresolved/forward $ref fails just " +
        "that line. IDEMPOTENCY: a line's `opId` makes resubmission safe — a matching earlier " +
        "success is reported already-applied, not re-created. The trailing summary line adds " +
        "`tempIdMapping` (handle → uuid) and `undoToken` — undo the WHOLE batch with " +
        "`things undo --txn <undoToken>`. " +
        "--dry-run plans everything without executing; --fail-fast skips the rest after " +
        "the first failure. Exit (worst failure wins): 0 all ok · 3 any verify-failed/invalid " +
        "· 4 any blocked · 5 any drift-blocked · 6 any unsupported.",
    )
    .option("--dry-run", "plan every op; execute nothing")
    .option("--fail-fast", "skip remaining ops after the first failure")
    .option("--json", "JSONL results + summary on stdout (also the default)")
    .option("--db <path>", "explicit database path")
    .option("--actor <name>", "author name recorded for the whole batch")
    .action(async (file: string | undefined, opts: WriteFlagOpts & Record<string, unknown>) => {
      let raw: string;
      if (file !== undefined && file !== "-") {
        raw = readFileSync(file, "utf8");
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        raw = Buffer.concat(chunks).toString("utf8");
      }
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      const ops: BatchOp[] = [];
      const preInvalid: BatchItemResult[] = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          ops.push(JSON.parse(lines[i] as string) as BatchOp);
        } catch (err) {
          // keep index alignment: a placeholder op that runBatch flags invalid
          ops.push({ op: "?" as never, params: {} });
          preInvalid.push({
            index: i,
            op: "?",
            outcome: {
              kind: "invalid",
              op: "?",
              detail: `line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
      }
      let client: ThingsClient | null = null;
      try {
        client = openThings(opts.db ? { dbPath: opts.db } : {});
        const batchResult = await client.write.batch(
          ops,
          {
            ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
            ...(opts["failFast"] === true && { failFast: true }),
            ...(opts.actor !== undefined && { actor: opts.actor }),
          },
          (r) => {
            const pre = preInvalid.find((p) => p.index === r.index);
            emit(pre ?? r);
          },
        );
        const merged = batchResult.results.map(
          (r) => preInvalid.find((p) => p.index === r.index) ?? r,
        );
        const failed = merged.filter((r) => outcomeFailed(r.outcome));
        const hasMapping = Object.keys(batchResult.tempIdMapping).length > 0;
        const summary = {
          summary: {
            total: merged.length,
            ok: merged.length - failed.length,
            failed: failed.filter((r) => r.outcome.kind !== "skipped").length,
            skipped: merged.filter((r) => r.outcome.kind === "skipped").length,
            // ADDITIVE: the temp-id → uuid mapping and the batch undo token
            // (undo the whole submission with `things undo --txn <token>`).
            ...(hasMapping && { tempIdMapping: batchResult.tempIdMapping }),
            ...(batchResult.undoToken !== undefined && { undoToken: batchResult.undoToken }),
          },
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        // Worst failure decides the exit code, by the stable precedence
        // drift > blocked > unsupported > verify-failed (see aggregateExitCode).
        process.exitCode = aggregateExitCode(failed.map((r) => r.outcome));
      } finally {
        client?.close();
      }
    });

  program
    .command("undo")
    .description(
      "Undo the last N changes made through things-api, newest first — each undo applies " +
        "the INVERSE change (recorded as actor `undo:<actor>`, never itself an undo " +
        "target). By default undo is GLOBAL — the owner's Cmd+Z — reversing the latest " +
        "changes whoever made them; narrow it with --by <actor> to undo only a given " +
        "author's changes (e.g. `--by mcp` to clean up after an agent), or --txn <token> " +
        "to undo one exact change by the `undoToken` its result returned (immune to any " +
        "changes made in between). Changes made directly in the Things app cannot be " +
        "undone here. IRREVERSIBLE changes are reported, not guessed: permanent deletes " +
        "and changes whose prior state is unknown. Partial restores carry notes (e.g. a " +
        "delete-undo lands in the Inbox de-scheduled). --dry-run shows every inverse plan " +
        "without executing. Undoing a CREATED area/tag deletes it permanently — requires " +
        "--dangerously-permanent. An undo is refused when the item changed outside things-api " +
        "since (its list/project, status, schedule, trashed state, or a field like the title " +
        "moved) — pass --acknowledge-out-of-band-changes to overwrite it anyway. Unwinding " +
        "stops at the first failed inverse. " +
        "Exit: 0 all ok · 3 any failed/partial · 2 nothing matched or bad flags.",
    )
    .option("--last <n>", "how many trailing mutations to undo (default 1)")
    .option(
      "--by <actor>",
      "undo only changes recorded under this author — an exact actor name (`mike`, `mcp`) " +
        "or `*` for all; matches exactly, so `--by mcp` never touches an `undo:mcp` " +
        "record. This SELECTS which changes to undo; --actor names who the undo is " +
        "recorded as. Not combinable with --txn.",
    )
    .option(
      "--txn <token>",
      "undo exactly the one change with this undo token (the `undoToken` field from its " +
        "result); immune to interleaving. Not combinable with --last/--by.",
    )
    .option("--dry-run", "show the inverse plans; execute nothing")
    .option("--dangerously-permanent", "allow inverses that delete areas/tags permanently")
    .option(
      "--acknowledge-out-of-band-changes",
      "proceed even when the item changed outside things-api since (in the Things app or by " +
        "another tool) — overwrites whatever the out-of-band change left",
    )
    .option("--json", "JSONL per-item results + summary on stdout (also the default)")
    .option("--db <path>", "explicit database path")
    .option("--verify-timeout <ms>", "how long to wait for each inverse change to take effect")
    .option("--actor <name>", "author name RECORDED for the undo (as undo:<name>); see --by")
    .action(async (opts: WriteFlagOpts & Record<string, unknown>) => {
      // --txn selects one exact record; --last/--by select a set. Mixing them
      // is a usage error (house style).
      if (opts["txn"] !== undefined && (opts["last"] !== undefined || opts["by"] !== undefined)) {
        usageError(opts, "--txn cannot be combined with --last or --by");
        return;
      }
      let client: ThingsClient | null = null;
      try {
        client = openThings(opts.db ? { dbPath: opts.db } : {});
        const items = await client.write.undo(
          {
            ...(opts["last"] !== undefined && { last: Number(opts["last"]) }),
            ...(opts["by"] !== undefined && { by: String(opts["by"]) }),
            ...(opts["txn"] !== undefined && { txn: String(opts["txn"]) }),
            ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
            ...(opts["dangerouslyPermanent"] === true && { dangerouslyPermanent: true }),
            ...(opts["acknowledgeOutOfBandChanges"] === true && {
              acknowledgeOutOfBandChanges: true,
            }),
            ...(opts.verifyTimeout !== undefined && {
              verifyTimeoutMs: Number(opts.verifyTimeout),
            }),
            ...(opts.actor !== undefined && { actor: opts.actor }),
          },
          (item: UndoItemResult) => {
            process.stdout.write(`${JSON.stringify(item)}\n`);
          },
        );
        const summary = {
          summary: {
            targets: items.length,
            ok: items.filter((i) => i.outcome === "ok").length,
            irreversible: items.filter((i) => i.outcome === "irreversible").length,
            failed: items.filter((i) => i.outcome === "failed" || i.outcome === "partial").length,
            dryRun: items.filter((i) => i.outcome === "dry-run").length,
          },
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        process.exitCode =
          summary.summary.failed > 0
            ? ExitCode.VerifyFailed
            : items.length === 0
              ? ExitCode.Usage
              : ExitCode.Ok;
        if (items.length === 0) {
          // The JSONL summary line (targets: 0) already conveys this as data on
          // stdout; the prose note is a human-only affordance on stderr.
          if (opts.json !== true) {
            const scope = opts["by"] !== undefined ? ` for actor ${String(opts["by"])}` : "";
            process.stderr.write(`error: no undoable mutations found in the audit trail${scope}\n`);
          }
        }
      } catch (err) {
        // runUndo throws RangeError for a --txn token that names no undoable
        // mutation or one already undone — a usage error (exit 2).
        if (err instanceof RangeError) {
          usageError(opts, err.message);
        } else {
          throw err;
        }
      } finally {
        client?.close();
      }
    });

  addReorderPositionFlags(
    addDriveGuiFlag(
      addWriteFlags(
        program
          .command("reorder <refs...>")
          .description(
            "The ONE reorder verb — rearrange to-dos, projects, headings, OR sidebar areas IN " +
              "PLACE (REARRANGES, never changes membership; to change what an item belongs to use " +
              "`things todo move` / `things project move`). All operands must be ONE kind (only " +
              "to-dos and projects intermix, and only on the shared Today/Evening/day axes); a " +
              "mixed-kind set, a cross-container set, and a non-member anchor each fail closed with " +
              "one precise message. Argument order is the resulting order; unmentioned siblings " +
              "keep theirs. Bare (no position) assembles the named items as a block at the " +
              "EARLIEST one's current slot; --start/--end/--before/--after position the block. A " +
              "Today/Evening member also has an index slot in its container, so a set sharing BOTH " +
              "axes is ambiguous — pass --in to say which. HEADINGS: same-project heading " +
              "re-ranking runs the native heading-block wire; an archived heading is reorderable " +
              "but repositioning it brings it back to open (disclosed). AREAS: this drives the " +
              "local Things app (sidebar drag). `things area reorder` and `things project " +
              "move-heading` remain as kind-specific spellings.",
          )
          .option(
            "--in <target>",
            "to-dos/projects only — name the axis to reorder on: today | evening | anytime | " +
              "someday | inbox, a project/area/heading ref (uuid or unique title), upcoming (the " +
              "one future day the set shares), or a YYYY-MM-DD day-block. A stage-list or container " +
              "axis sorts one KIND at a time; only today | evening | upcoming | a day-block " +
              "intermix both kinds.",
          ),
      ),
    ),
  ).action(async (refs: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
    const position = reorderPosition(opts);
    if (position === "conflict") {
      usageError(opts, "pass at most one of --start / --end / --before / --after");
      return;
    }
    const request: ReorderRequest = {
      uuids: refs,
      ...(position !== undefined && { position }),
      ...(opts["in"] !== undefined && { in: opts["in"] as string }),
    };
    await runMoveCmd(opts, (c) => c.write.reorderAny(request, writeOptionsFrom(opts)));
  });

  program
    .command("capabilities")
    .description(
      "Reference for every operation kind (used by `things batch` and the MCP " +
        "run_operation tool): whether it is supported, its caveats, and the confirmation " +
        "flags it needs — with the underlying support evidence",
    )
    .option("--op <operation>", "limit to one operation kind")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { op?: string; json?: boolean }) => {
      const data = capabilitiesTable(opts.op as OperationKind | undefined);
      if (opts.json) {
        const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
        process.stdout.write(
          `${JSON.stringify(okEnvelope("capabilities", { items: data }, meta))}\n`,
        );
        return;
      }
      for (const entry of data) {
        process.stdout.write(`${entry.op}\n`);
        process.stdout.write(
          `  undo: ${entry.undo.class}${entry.undo.ack !== undefined ? ` (ack: ${entry.undo.ack})` : ""} — ${entry.undo.note}\n`,
        );
        if (entry.certification !== undefined) {
          process.stdout.write(
            `  certification: ${entry.certification.status}` +
              `${entry.certification.evidence.length > 0 ? ` (${entry.certification.evidence.join(", ")})` : ""}\n`,
          );
        }
        for (const v of entry.vectors) {
          const s = v as {
            support: string;
            disruption?: number;
            validation?: string;
            notes?: string;
          };
          process.stdout.write(
            `  ${v.vector}: ${s.support}${s.disruption !== undefined ? ` (tier ${s.disruption}, ${s.validation})` : ""}${s.notes !== undefined ? ` — ${s.notes}` : ""}\n`,
          );
        }
      }
    });

  const config = group(program, "config", "things-api configuration");
  config
    .command("get [key]")
    .description(
      "Show one config key's effective value, or every effective value when no key is given " +
        "(including read-only derived values like host). Precedence is env > stored > default; " +
        "each value is marked with the layer that supplied it. Unknown key is a usage error. " +
        "--json emits a versioned envelope.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((key: string | undefined, opts: { json?: boolean }) => {
      const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
      if (key !== undefined) {
        const entry = getConfigKey(key);
        if (entry === undefined) {
          process.stderr.write(`error: unknown config key "${key}"\n`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(okEnvelope("config", entry, meta))}\n`);
        } else {
          process.stdout.write(`${configKeyLine(entry)}\n`);
        }
        return;
      }
      const all = describeConfig();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(okEnvelope("config", { items: all }, meta))}\n`);
      } else {
        for (const entry of all) {
          process.stdout.write(`${configKeyLine(entry)}\n`);
        }
      }
    });
  config
    .command("set <key> <value>")
    .description(
      "Persist a config key: profile | maxDisruption | actor | auditEnabled | " +
        "accepted-fingerprint | certified-app-version | allow-experimental | bounce-enabled | " +
        "bounce-max-items | ui-enabled | scope",
    )
    .action((key: string, value: string, opts: { dryRun?: boolean }) => {
      const map: Record<string, string> = {
        profile: "profile",
        maxDisruption: "maxDisruption",
        actor: "actor",
        auditEnabled: "auditEnabled",
        "accepted-fingerprint": "acceptedFingerprint",
        "certified-app-version": "certifiedAppVersion",
        "allow-experimental": "allowExperimental",
        "bounce-enabled": "bounceEnabled",
        "bounce-max-items": "bounceMaxItems",
        "ui-enabled": "uiEnabled",
        scope: "scope",
      };
      const target = map[key];
      if (target === undefined) {
        process.stderr.write(`error: unknown config key "${key}"\n`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      const parsed: string | number | boolean =
        target === "maxDisruption" || target === "bounceMaxItems"
          ? Number(value)
          : target === "auditEnabled" ||
              target === "allowExperimental" ||
              target === "bounceEnabled" ||
              target === "uiEnabled"
            ? value === "true"
            : value;
      // Universal `--dry-run` (../dry-run.ts): `config set` writes local config
      // state (not the Things DB), so it honors the flag with an honest preview —
      // the key is still validated above, but nothing is persisted. Exit 0.
      if (opts.dryRun === true) {
        process.stdout.write(`DRY RUN would set ${key} = ${String(parsed)} (nothing written)\n`);
        process.exitCode = ExitCode.Ok;
        return;
      }
      saveConfigKey(target as never, parsed);
      process.stdout.write(`set ${key} = ${String(parsed)}\n`);
      // A stored scope jails EVERY process on this host — including this
      // terminal — until removed. Per-process scoping belongs on the
      // THINGS_API_SCOPE env var or the `things mcp --scope` flag instead.
      if (target === "scope") {
        process.stderr.write(
          "warning: a stored scope limits EVERY things-api process on this machine to " +
            `"${value}" — including your own terminal — until you clear it with ` +
            '`things config set scope ""`. For per-process limits (e.g. one MCP server), ' +
            "prefer `things mcp --scope <ref>` or the THINGS_API_SCOPE environment variable.\n",
        );
      }
    });
}
