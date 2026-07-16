/**
 * Write commands. Help text is the agent API: every command's --help states
 * its behavior, side effects, and required confirmation flags in consumer
 * voice (docs/design/surface-copy.md) — internals stay in docs/ and the
 * capabilities/dry-run OUTPUT. No interactive prompts: risky semantics
 * require explicit flags.
 */
import type { Command } from "commander";

import { readFileSync } from "node:fs";

import { openThings, type ThingsClient } from "../../client.ts";
import { saveConfigKey, type DisruptionTier } from "../../config.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import type {
  OperationKind,
  RepeatFrequency,
  ReorderScope,
  ReorderStrategy,
} from "../../write/operations.ts";
import { addRepeatRuleFlags, repeatRuleFlagsFromOpts } from "./repeat-flags.ts";
import type { WriteOptions } from "../../write/pipeline.ts";
import { capabilitiesTable } from "../../write/capabilities.ts";
import { outcomeFailed, type BatchItemResult, type BatchOp } from "../../write/batch.ts";
import { BOUNCE_MAX_ITEMS, type ReorderResult } from "../../write/reorder.ts";
import type { UndoItemResult } from "../../write/undo.ts";
import type { VectorId } from "../../write/vectors/types.ts";

import { errorEnvelope, ExitCode, okEnvelope, type EnvelopeMeta } from "../../contracts.ts";
import { ReferenceResolutionError } from "../../read/queries.ts";
import { usageError } from "../read-driver.ts";

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
    .option("--actor <name>", "author name recorded for this change (default: from config)");
}

/** A commander flag value when present-with-value (bare presence yields `true`). */
const flagVal = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Writes one batch result as an NDJSON line to stdout. */
const emit = (r: BatchItemResult): void => {
  process.stdout.write(`${JSON.stringify(r)}\n`);
};

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
    "create any named tag that does not exist yet (nesting parent/child) before applying, " +
      "instead of stopping on an unknown tag",
  );
}

/** WriteOptions extra carrying createTags when the flag is set. */
function createTagsExtra(opts: Record<string, unknown>): Partial<WriteOptions> {
  return opts["createTags"] === true ? { createTags: true } : {};
}

/** Add the mandatory GUI-drive acknowledgement to a ui-vector command. */
function addDriveGuiFlag(cmd: Command): Command {
  return cmd.option(
    "--dangerously-drive-gui",
    "required: this drives the local Things app through its accessibility interface to make a " +
      "change the app offers nowhere else; also needs `things config set ui-enabled true`. " +
      "Intended for a dedicated always-on Mac.",
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * URL-style `--when DATE@TIME` sugar: splits into when + reminder for the
 * ops that take both (an explicit --reminder alongside the suffix errors).
 */
function applyWhenSugar(opts: Record<string, unknown>): string | null {
  const when = opts["when"];
  if (typeof when !== "string" || !when.includes("@")) return null;
  const at = when.indexOf("@");
  const date = when.slice(0, at);
  const time = when.slice(at + 1);
  if (date === "" || time === "" || time.includes("@")) {
    return `invalid --when "${when}" — expected today | evening | anytime | someday | YYYY-MM-DD (set a reminder with --reminder HH:mm)`;
  }
  if (opts["reminder"] !== undefined) {
    return `--when "${when}" carries an @time suffix and --reminder was also given — use one`;
  }
  opts["when"] = date;
  opts["reminder"] = time;
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
): Promise<void> {
  const started = Date.now();
  let client: ThingsClient | null = null;
  const meta = (client_: ThingsClient | null): EnvelopeMeta => {
    let dbVersion: number | null = null;
    let fingerprint: EnvelopeMeta["fingerprint"] = "unknown";
    if (client_ !== null) {
      const fp = client_.fingerprint();
      dbVersion = fp.observation.databaseVersion;
      fingerprint = fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown";
    }
    return { dbVersion, fingerprint, elapsedMs: Date.now() - started };
  };

  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const result = await fn(client);
    emitResult(result, opts, meta(client));
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
                details: { candidates: err.candidates },
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
        process.stdout.write(`${JSON.stringify(okEnvelope("mutation-result", result, meta))}\n`);
      } else {
        const uuid = result.uuid === null ? "" : ` uuid=${result.uuid}`;
        process.stdout.write(
          `ok ${result.op}${uuid} (vector=${result.vector}, tier=${result.tier}, verified)\n`,
        );
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
                code: `verify-failed:${result.reason}`,
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
                code: `blocked:${result.hazard ?? result.reason}`,
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
                detail: result.considered,
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
        .command("add <title>")
        .description(
          "Create a to-do; its uuid is printed on success. Projects, areas, and headings " +
            "must name existing items — unknown or ambiguous references are rejected. A tag " +
            "may be a name or a parent/child path, and must exist unless " +
            "--create-tags. Adding into a completed/canceled project reopens that project — " +
            "requires --acknowledge-project-reopen.",
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
        .option("--acknowledge-project-reopen", "allow adding into a completed/canceled project"),
    ),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const checklist = opts["checklistItem"] as string[];
    const tags = splitCsv(opts["tags"] as string | undefined);
    const project = containerRef(opts["project"] as string | undefined);
    const area = containerRef(opts["area"] as string | undefined);
    if (!whenSugarOk(opts)) return;
    await runWrite(opts, (c) =>
      c.write.addTodo(
        {
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
        },
        writeOptionsFrom(opts, {
          ...(opts["acknowledgeProjectReopen"] !== undefined && {
            acknowledgeProjectReopen: opts["acknowledgeProjectReopen"] as boolean,
          }),
          ...createTagsExtra(opts),
        }),
      ),
    );
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
      .option("--clear-deadline", "remove the deadline"),
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
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  for (const [verb, method] of [
    ["complete", "completeTodo"],
    ["cancel", "cancelTodo"],
    ["reopen", "reopenTodo"],
  ] as const) {
    addWriteFlags(
      todo
        .command(`${verb} <uuid>`)
        .description(
          `${verb[0]?.toUpperCase()}${verb.slice(1)} a to-do. Not available for repeating to-dos.`,
        ),
    ).action(async (uuid: string, opts: WriteFlagOpts) => {
      await runWrite(opts, (c) => c.write[method](uuid, writeOptionsFrom(opts)));
    });
  }

  addWriteFlags(
    todo
      .command("move <uuid>")
      .description(
        "Move a to-do into a project or area (optionally under an existing heading), back " +
          "to the Inbox, or out of every container. Unknown or ambiguous destinations are " +
          "rejected. Moving into a completed/canceled project reopens that project — " +
          "requires --acknowledge-project-reopen.",
      )
      .option("--project <ref>", "destination project (uuid or unique name)")
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--heading <name>", "existing heading in the destination project")
      .option("--inbox", "move back to the Inbox — removes any schedule")
      .option("--detach", "remove ALL container links (project/area/heading) keeping the schedule")
      .option("--acknowledge-project-reopen", "allow moving into a completed/canceled project"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const project = containerRef(opts["project"] as string | undefined);
    const area = containerRef(opts["area"] as string | undefined);
    const inbox = opts["inbox"] === true;
    const detach = opts["detach"] === true;
    const dest = project !== undefined || area !== undefined || opts["heading"] !== undefined;
    if ((inbox && (dest || detach)) || (detach && dest)) {
      usageError(
        opts,
        "--inbox/--detach are exclusive with each other and with --project/--area/--heading",
      );
      return;
    }
    await runWrite(opts, (c) =>
      c.write.moveTodo(
        uuid,
        {
          ...(project !== undefined && { project }),
          ...(area !== undefined && { area }),
          ...(opts["heading"] !== undefined && { heading: opts["heading"] as string }),
          ...(inbox && { inbox: true }),
          ...(detach && { detach: true }),
        },
        writeOptionsFrom(opts, {
          ...(inbox && { vector: "applescript" as const }),
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
          "--acknowledge-checklist-reset when items exist. GRANULAR (one per call): " +
          "--add/--remove/--check/--uncheck/--rename+--to/--move-item+--to-position change " +
          "a single item with every other item's checked state PRESERVED (no reset flag " +
          "needed). Target an item by title or by --index (1-based); duplicate titles are " +
          "resolved best-effort (check → first unchecked, etc.). Checklist item uuids are " +
          "internal and never exposed.",
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
        "Clear a to-do's time-of-day reminder while keeping its scheduled date. When the " +
          "Things proxy shortcuts are installed (`things setup shortcuts`) this happens in " +
          "place, and it is the only way for a repeating to-do; otherwise a non-repeating " +
          "date-scheduled to-do falls back to a URL re-schedule that briefly moves it to Today " +
          "and back. Reversible with `things undo`. Force a delivery path with --vector " +
          "shortcuts|url-scheme.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.clearReminder(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    todo
      .command("backdate <uuid>")
      .description(
        "Rewrite a to-do's completion and/or creation timestamp to noon (local) on the " +
          "given date. --completed-on requires the to-do to already be completed or " +
          "canceled. The Logbook re-sorts to the new date.",
      )
      .option("--completed-on <date>", "YYYY-MM-DD — new completion date")
      .option("--created-on <date>", "YYYY-MM-DD — new creation date"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.backdateTodo(
        uuid,
        {
          ...(opts["completedOn"] !== undefined && {
            completionDate: opts["completedOn"] as string,
          }),
          ...(opts["createdOn"] !== undefined && { creationDate: opts["createdOn"] as string }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    todo
      .command("add-logged <title>")
      .description(
        "Create a to-do directly in the Logbook: completed, with the given past " +
          "completion date (and optionally a past creation date). For importing history " +
          "from another system.",
      )
      .requiredOption("--completed-on <date>", "YYYY-MM-DD — completion date (required)")
      .option("--created-on <date>", "YYYY-MM-DD — creation date (must be <= completed-on)")
      .option("--notes <text>", "notes body"),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.addLoggedTodo(
        {
          title,
          completionDate: opts["completedOn"] as string,
          ...(opts["createdOn"] !== undefined && { creationDate: opts["createdOn"] as string }),
          ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  // --- ui vector: GUI-driven transforms (two-key gated) --------------------

  const REPEAT_FREQ_HELP = "daily | weekly | monthly | yearly";
  const REPEAT_INTERVAL_HELP = "every N units (1–99)";

  for (const [verb, op, desc] of [
    [
      "make-repeating",
      "todo.make-repeating",
      "Turn a plain to-do into a repeating one. This REPLACES the to-do with a new repeating " +
        "series — the original disappears and a fresh recurring item takes its place " +
        "(cannot be undone). Set the frequency and interval, and optionally the weekday set, " +
        "monthly/yearly day, end bound, reminders, or deadline.",
    ],
    [
      "reschedule-repeat",
      "todo.reschedule-repeat",
      "Change an existing repeating to-do's rule in place (the item keeps its identity). Set the " +
        "frequency and interval, and optionally the weekday set, monthly/yearly day, end bound, " +
        "reminders, or deadline. `things undo` restores the previous rule.",
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

  const heading = group(program, "heading", "Heading-scoped operations");

  addWriteFlags(
    heading
      .command("add <project> <title>")
      .description(
        "Create a heading inside an existing project; its uuid is printed on success. The " +
          "project must name an existing project (uuid or unique name). This uses the Things " +
          "proxy shortcuts — run `things setup shortcuts` once first.",
      ),
  ).action(async (project: string, title: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) =>
      c.write.createHeading({ uuid: project, title: project }, title, writeOptionsFrom(opts)),
    );
  });

  addWriteFlags(
    heading
      .command("rename <uuid> <title>")
      .description("Rename a heading in place (works on archived headings too)."),
  ).action(async (uuid: string, title: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.renameHeading(uuid, title, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    heading
      .command("archive <uuid>")
      .description(
        "Archive a heading — it leaves the active project view (reversible with " +
          "`things heading unarchive`). This is the preferred way to retire a heading: " +
          "row DELETION exists only in the app's UI and Shortcuts with a per-run consent " +
          "dialog, never headlessly. With open children, --children is required: " +
          "complete/cancel resolve them with the heading (one atomic cascade); reparent " +
          "moves them to the project root first, keeping them open — a compound sequence " +
          "that `things undo` reverses as one unit.",
      )
      .option(
        "--children <policy>",
        "complete | cancel | reparent (required when children are open)",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const children = opts["children"] as "complete" | "cancel" | "reparent" | undefined;
    await runWrite(opts, async (c) => {
      const outcome = await c.write.archiveHeading(
        uuid,
        children ? { children } : {},
        writeOptionsFrom(opts),
      );
      for (const leg of outcome.reparented) {
        process.stderr.write(`reparented: ${leg.title} (${leg.result.kind})\n`);
      }
      return outcome.heading;
    });
  });

  addWriteFlags(
    heading
      .command("unarchive <uuid>")
      .description(
        "Un-archive a heading. --restore-children also reopens the children the archive " +
          "cascade resolved with it (identified by matching resolution timestamps; a " +
          "someday child comes back as someday). Children resolved at other times are " +
          "never touched.",
      )
      .option("--restore-children", "reopen cascade-resolved children too"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, async (c) => {
      const outcome = await c.write.unarchiveHeading(
        uuid,
        opts["restoreChildren"] === true ? { restoreChildren: true } : {},
        writeOptionsFrom(opts),
      );
      for (const child of outcome.children) {
        process.stderr.write(`restored: ${child.title} (${child.result.kind})\n`);
      }
      return outcome.heading;
    });
  });

  addDriveGuiFlag(
    addWriteFlags(
      heading
        .command("convert-to-project <uuid>")
        .description(
          "Convert a heading into a project. This REPLACES the heading with a new project — it " +
            "is promoted alongside its parent project (into the same area) and the heading's " +
            "to-dos move under the new project. The heading's identity is gone and it cannot be " +
            "undone. The new project's uuid is printed on success.",
        ),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) =>
      c.write.run("heading.convert-to-project", { uuid }, writeOptionsFrom(opts)),
    );
  });

  const project = group(program, "project", "Project-scoped operations");

  // --- ui vector: repeating-project transforms (two-key gated) -------------
  addDriveGuiFlag(
    addRepeatRuleFlags(
      addWriteFlags(
        project
          .command("reschedule-repeat <ref>")
          .description(
            "Change an existing repeating project's rule in place (target by uuid or unique name; " +
              "the project keeps its identity). " +
              "Set the frequency and interval, and optionally the weekday set, monthly/yearly day, " +
              "end bound, reminders, or deadline. `things undo` restores the previous rule.",
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
              "first (a cleanup-free intermediate step, shown in --dry-run). Set the frequency and " +
              "interval, and optionally the weekday set, monthly/yearly day, end bound, reminders, " +
              "or deadline.",
          )
          .requiredOption("--frequency <freq>", REPEAT_FREQ_HELP)
          .requiredOption("--interval <n>", REPEAT_INTERVAL_HELP),
      ),
    ),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const frequency = opts["frequency"] as RepeatFrequency;
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
        .command("create-repeating <title>")
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
    await runWrite(opts, (c) =>
      c.write.createRepeatingProject(
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
      .description("Create a project; its uuid is printed on success.")
      .option("--notes <text>", "notes body")
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
      .option("--deadline <date>", "YYYY-MM-DD")
      .option("--todo <title>", "initial child to-do (repeatable)", collect, []),
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

  addWriteFlags(
    project
      .command("move <ref>")
      .description(
        "Move a project (target by uuid or unique name) to another area, or DETACH it from " +
          "its current area (--detach). Status and schedule are untouched. Unknown areas are " +
          "rejected.",
      )
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--detach", "remove the current area assignment (exclusive with --area)"),
  ).action(async (uuid: string, opts: WriteFlagOpts & { area?: string; detach?: boolean }) => {
    if ((opts.detach === true) === (opts.area !== undefined)) {
      usageError(opts, "pass exactly one of --area / --detach");
      return;
    }
    await runWrite(opts, (c) =>
      opts.detach === true
        ? c.write.detachProject(uuid, writeOptionsFrom(opts))
        : c.write.moveProject(
            uuid,
            { uuid: opts.area as string, title: opts.area as string },
            writeOptionsFrom(opts),
          ),
    );
  });

  addWriteFlags(
    project
      .command("cancel <ref>")
      .description(
        "Cancel a project (target by uuid or unique name). Canceling also cancels its open " +
          "to-dos, so an explicit --children policy is required; already-completed children " +
          "are never altered.",
      )
      .requiredOption(
        "--children <policy>",
        "require-resolved (error if open to-dos remain) | auto-cancel (cancel them too)",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts & { children: string }) => {
    await runWrite(opts, (c) =>
      c.write.cancelProject(
        uuid,
        { children: opts.children as "require-resolved" | "auto-cancel" },
        writeOptionsFrom(opts),
      ),
    );
  });

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
          "open to-dos, so an explicit --children policy is required.",
      )
      .requiredOption(
        "--children <policy>",
        "require-resolved (error if open to-dos remain) | auto-complete (complete them too)",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts & { children: string }) => {
    await runWrite(opts, (c) =>
      c.write.completeProject(
        uuid,
        { children: opts.children as "require-resolved" | "auto-complete" },
        writeOptionsFrom(opts),
      ),
    );
  });

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
            "This drives the Things window with the pointer — the app comes to the front and " +
            "the sidebar may scroll while the area is moved; the area's projects and to-dos " +
            "are untouched.",
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
          "undone; requires --dangerously-permanent. The area's to-dos move to the Trash; " +
          "its projects remain, no longer assigned to any area.",
      )
      .option("--dangerously-permanent", "accept permanent, unrecoverable deletion"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.deleteArea(
        target,
        writeOptionsFrom(opts, {
          ...(opts["dangerouslyPermanent"] !== undefined && {
            dangerouslyPermanent: opts["dangerouslyPermanent"] as boolean,
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
        "--dry-run plans everything without executing; --fail-fast skips the rest after " +
        "the first failure. Exit: 0 all ok · 3 any verify-failed/invalid · 4 any blocked " +
        "· 5 any drift-blocked.",
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
        const results = await client.write.batch(
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
        const merged = results.map((r) => preInvalid.find((p) => p.index === r.index) ?? r);
        const failed = merged.filter((r) => outcomeFailed(r.outcome));
        const summary = {
          summary: {
            total: merged.length,
            ok: merged.length - failed.length,
            failed: failed.filter((r) => r.outcome.kind !== "skipped").length,
            skipped: merged.filter((r) => r.outcome.kind === "skipped").length,
          },
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        const kinds = new Set(failed.map((r) => r.outcome.kind));
        const reasons = new Set(
          failed.map((r) => (r.outcome.kind === "blocked" ? r.outcome.reason : "")),
        );
        process.exitCode = reasons.has("drift")
          ? ExitCode.DriftBlocked
          : kinds.has("blocked")
            ? ExitCode.Blocked
            : failed.length > 0
              ? ExitCode.VerifyFailed
              : ExitCode.Ok;
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
        "--dangerously-permanent. Unwinding stops at the first failed inverse. " +
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

  addWriteFlags(
    program
      .command("reorder <uuids...>")
      .description(
        "Reorder items within Today, This Evening, the Inbox, Someday (loose to-dos or " +
          "area-less someday projects — one kind per call), a " +
          "project's to-dos, a project's HEADINGS, an area, or the top-level sidebar " +
          "projects — uuids are placed at the TOP in the given order; unlisted members " +
          "keep their relative order below. Strategies: native (EXPERIMENTAL — requires " +
          "`things config set allow-experimental true` and may stop working after a " +
          "Things update; today/inbox/someday/project/headings/area) and bounce " +
          `(today/evening/projects, max ${BOUNCE_MAX_ITEMS} items; an interrupted run ` +
          "reports which items were placed). Evening and projects (top-level sidebar " +
          "order — each project takes a brief someday/anytime round-trip) are " +
          "bounce-only. Project children under headings cannot be reordered; reordering " +
          "a heading carries its children with it. Area scope reorders to-dos OR " +
          "projects — never mixed in one request.",
      )
      .requiredOption(
        "--scope <scope>",
        "today | evening | inbox | someday | project | headings | area | projects",
      )
      .option("--project <ref>", "project (uuid or unique name) — scope=project|headings")
      .option("--area <ref>", "area (uuid or unique name) — scope=area")
      .option("--strategy <name>", "force native | bounce (default: per-scope)"),
  ).action(async (uuids: string[], opts: WriteFlagOpts & Record<string, unknown>) => {
    const scope = opts["scope"] as ReorderScope;
    const container = containerRef(
      (opts["project"] as string | undefined) ?? (opts["area"] as string | undefined),
    );
    await runWrite(opts, (c) =>
      c.write.reorder(
        {
          scope,
          uuids,
          ...(container !== undefined && { container }),
          ...(opts["strategy"] !== undefined && {
            strategy: opts["strategy"] as ReorderStrategy,
          }),
        },
        writeOptionsFrom(opts),
      ),
    );
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
        process.stdout.write(`${JSON.stringify(okEnvelope("capabilities", data, meta))}\n`);
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
    .command("show")
    .description("Show the effective configuration (profile, disruption policy, actor)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: { json?: boolean; db?: string }) => {
      const client = openThings(opts.db ? { dbPath: opts.db } : {});
      try {
        if (opts.json) {
          const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
          process.stdout.write(`${JSON.stringify(okEnvelope("config", client.config, meta))}\n`);
        } else {
          for (const [k, v] of Object.entries(client.config)) {
            process.stdout.write(`${k}: ${String(v)}\n`);
          }
        }
      } finally {
        client.close();
      }
    });
  config
    .command("set <key> <value>")
    .description(
      "Persist a config key: profile | maxDisruption | actor | auditEnabled | " +
        "accepted-fingerprint | allow-experimental | ui-enabled",
    )
    .action((key: string, value: string) => {
      const map: Record<string, string> = {
        profile: "profile",
        maxDisruption: "maxDisruption",
        actor: "actor",
        auditEnabled: "auditEnabled",
        "accepted-fingerprint": "acceptedFingerprint",
        "allow-experimental": "allowExperimental",
        "ui-enabled": "uiEnabled",
      };
      const target = map[key];
      if (target === undefined) {
        process.stderr.write(`error: unknown config key "${key}"\n`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      const parsed: string | number | boolean =
        target === "maxDisruption"
          ? Number(value)
          : target === "auditEnabled" || target === "allowExperimental" || target === "uiEnabled"
            ? value === "true"
            : value;
      saveConfigKey(target as never, parsed);
      process.stdout.write(`set ${key} = ${String(parsed)}\n`);
    });
}
