/**
 * Write commands. Every command's --help states its disruption tier, default
 * vector, and the hazards that may block it — help text is the agent API.
 * No interactive prompts: risky semantics require explicit flags.
 */
import type { Command } from "commander";

import { openThings, type ThingsClient } from "../../client.ts";
import { saveConfigKey, type DisruptionTier } from "../../config.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import {
  OPERATION_KINDS,
  type OperationKind,
  type ReorderScope,
  type ReorderStrategy,
} from "../../write/operations.ts";
import type { WriteOptions } from "../../write/pipeline.ts";
import { BOUNCE_MAX_ITEMS, type ReorderResult } from "../../write/reorder.ts";
import { defaultVectors } from "../../write/vectors/registry.ts";
import type { VectorId } from "../../write/vectors/types.ts";
import { ExitCode } from "../exit-codes.ts";
import { errorEnvelope, okEnvelope, type EnvelopeMeta } from "../output.ts";

interface WriteFlagOpts {
  json?: boolean;
  db?: string;
  dryRun?: boolean;
  vector?: string;
  allowDisruptive?: boolean;
  allowVeryDisruptive?: boolean;
  verifyTimeout?: string;
  actor?: string;
}

function addWriteFlags(cmd: Command): Command {
  return cmd
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .option(
      "--dry-run",
      "plan only: compiled invocation (token-redacted), tier, hazards, expected delta — nothing executes",
    )
    .option("--vector <id>", "force a write vector: url-scheme | applescript")
    .option("--allow-disruptive", "permit disruption tier 2 (focus steal)")
    .option("--allow-very-disruptive", "permit disruption tier 3 (UI navigation/modals)")
    .option("--verify-timeout <ms>", "read-after-write verification deadline")
    .option("--actor <name>", "audit attribution (default: config/profile actor)");
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
    ...extra,
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
                detail: { expected: result.expected, observed: result.observed },
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`VERIFY FAILED (${result.reason}): ${result.detail}\n`);
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

  addWriteFlags(
    todo
      .command("add <title>")
      .description(
        "Create a to-do (vector: url-scheme, tier 0 with Things running). " +
          "Hazards: H-UNKNOWN-TAG, H-UNKNOWN-DESTINATION, H-AMBIGUOUS-HEADING, " +
          "H-REOPEN-RESOLVED-PROJECT (--acknowledge-project-reopen).",
      )
      .option("--notes <text>", "notes body")
      .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
      .option(
        "--reminder <HH:mm>",
        "time-of-day reminder (24h); requires --when today|evening (R-suite scope)",
      )
      .option("--deadline <date>", "YYYY-MM-DD")
      .option("--tags <list>", "comma-separated EXISTING tag names")
      .option("--checklist-item <text>", "checklist item (repeatable)", collect, [])
      .option("--project <ref>", "destination project (uuid or unique name)")
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--heading <name>", "existing heading in the destination project")
      .option("--acknowledge-project-reopen", "allow adding into a completed/canceled project"),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const checklist = opts["checklistItem"] as string[];
    const tags = splitCsv(opts["tags"] as string | undefined);
    const project = containerRef(opts["project"] as string | undefined);
    const area = containerRef(opts["area"] as string | undefined);
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
        }),
      ),
    );
  });

  addWriteFlags(
    todo
      .command("update <uuid>")
      .description(
        "Update title/notes/when/reminder/deadline (vector: url-scheme, tier 0). " +
          "Hazard: H-REPEAT-SCHEDULE — when/deadline on a repeating template is hard-blocked " +
          "(the URL write crashes Things); title/notes stay allowed. " +
          "Reminders (H-REMINDER-SCOPE): --reminder needs --when today|evening; when " +
          "re-scheduling WITHOUT --reminder an existing reminder is auto-preserved " +
          "(a bare when= would silently clear it — R07); --clear-reminder clears explicitly. " +
          "--append-notes/--prepend-notes join with a newline (exclusive with --notes).",
      )
      .option("--title <text>", "new title")
      .option("--notes <text>", "replace notes")
      .option("--append-notes <text>", "append to existing notes (newline-joined)")
      .option("--prepend-notes <text>", "prepend to existing notes (newline-joined)")
      .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
      .option("--reminder <HH:mm>", "set a reminder (24h); requires --when today|evening")
      .option("--clear-reminder", "clear the reminder (requires --when today|evening)")
      .option("--deadline <date>", "YYYY-MM-DD")
      .option("--clear-deadline", "remove the deadline"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const notesModes = ["notes", "appendNotes", "prependNotes"].filter(
      (k) => opts[k] !== undefined,
    );
    if (notesModes.length > 1) {
      process.stderr.write("error: --notes, --append-notes, --prepend-notes are exclusive\n");
      process.exitCode = ExitCode.Usage;
      return;
    }
    if (opts["reminder"] !== undefined && opts["clearReminder"] === true) {
      process.stderr.write("error: pass at most one of --reminder / --clear-reminder\n");
      process.exitCode = ExitCode.Usage;
      return;
    }
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
          `${verb[0]?.toUpperCase()}${verb.slice(1)} a to-do (tier 0; verified read-after-write). ` +
            "Hazard: H-REPEAT-SCHEDULE — blocked on repeating templates.",
        ),
    ).action(async (uuid: string, opts: WriteFlagOpts) => {
      await runWrite(opts, (c) => c.write[method](uuid, writeOptionsFrom(opts)));
    });
  }

  addWriteFlags(
    todo
      .command("move <uuid>")
      .description(
        "Move to a project/area (vector: url-scheme; applescript for project/area). " +
          "Hazards: H-UNKNOWN-DESTINATION (silent no-op otherwise), H-AMBIGUOUS-HEADING, " +
          "H-REOPEN-RESOLVED-PROJECT, H-REPEAT-SCHEDULE.",
      )
      .option("--project <ref>", "destination project (uuid or unique name)")
      .option("--area <ref>", "destination area (uuid or unique name)")
      .option("--heading <name>", "existing heading in the destination project")
      .option("--inbox", "move back to the Inbox — de-schedules (vector: applescript, E06)")
      .option("--acknowledge-project-reopen", "allow moving into a completed/canceled project"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const project = containerRef(opts["project"] as string | undefined);
    const area = containerRef(opts["area"] as string | undefined);
    const inbox = opts["inbox"] === true;
    if (inbox && (project !== undefined || area !== undefined || opts["heading"] !== undefined)) {
      process.stderr.write("error: --inbox is exclusive with --project/--area/--heading\n");
      process.exitCode = ExitCode.Usage;
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
        "Duplicate a to-do (vector: url-scheme, tier 0; validated E07 — exact copy of " +
          "title/notes, new uuid discovered by verification). AppleScript refuses duplication " +
          "(E08). Hazard: H-REPEAT-SCHEDULE — blocked on repeating templates (unvalidated).",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.duplicateTodo(uuid, writeOptionsFrom(opts)));
  });

  addWriteFlags(
    todo
      .command("tags <uuid>")
      .description(
        "Set or extend tags (tier 0). --set REPLACES the full tag set (validated semantics); " +
          "--add merges with current tags. Hazard: H-UNKNOWN-TAG (unknown tags are otherwise " +
          "silently ignored by the app).",
      )
      .option("--set <list>", "comma-separated tag names: full replacement")
      .option("--add <list>", "comma-separated tag names: merge with existing"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const set = splitCsv(opts["set"] as string | undefined);
    const add = splitCsv(opts["add"] as string | undefined);
    if ((set === undefined) === (add === undefined)) {
      process.stderr.write("error: pass exactly one of --set or --add\n");
      process.exitCode = ExitCode.Usage;
      return;
    }
    await runWrite(opts, (c) =>
      set !== undefined
        ? c.write.setTags(uuid, set, writeOptionsFrom(opts))
        : c.write.addTags(uuid, add ?? [], writeOptionsFrom(opts)),
    );
  });

  addWriteFlags(
    todo
      .command("checklist <uuid>")
      .description(
        "REPLACE the checklist wholesale (tier 0). Destroys per-item completion state — " +
          "hazard H-CHECKLIST-REPLACE requires --acknowledge-checklist-reset when items exist.",
      )
      .option("--item <text>", "checklist item in order (repeatable)", collect, [])
      .option("--acknowledge-checklist-reset", "accept wholesale replacement of existing items"),
  ).action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
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
        "Move a to-do to the Trash (vector: applescript, tier 0; restorable in the app). " +
          "Hazard: H-REPEAT-SCHEDULE — blocked on repeating templates.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.deleteTodo(uuid, writeOptionsFrom(opts)));
  });

  const project = group(program, "project", "Project-scoped operations");

  addWriteFlags(
    project
      .command("add <title>")
      .description("Create a project (vector: url-scheme, tier 0).")
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
      .command("update <uuid>")
      .description("Update project title/notes/when/deadline (vector: url-scheme, tier 0)."),
  )
    .option("--title <text>", "new title")
    .option("--notes <text>", "replace notes")
    .option("--when <value>", "today | evening | anytime | someday | YYYY-MM-DD")
    .option("--deadline <date>", "YYYY-MM-DD")
    .option("--clear-deadline", "remove the deadline")
    .action(async (uuid: string, opts: WriteFlagOpts & Record<string, unknown>) => {
      await runWrite(opts, (c) =>
        c.write.updateProject(
          uuid,
          {
            ...(opts["title"] !== undefined && { title: opts["title"] as string }),
            ...(opts["notes"] !== undefined && { notes: opts["notes"] as string }),
            ...(opts["when"] !== undefined && { when: opts["when"] as never }),
            ...(opts["deadline"] !== undefined && { deadline: opts["deadline"] as string }),
            ...(opts["clearDeadline"] === true && { deadline: null }),
          },
          writeOptionsFrom(opts),
        ),
      );
    });

  addWriteFlags(
    project
      .command("complete <uuid>")
      .description(
        "Complete a project (vector: url-scheme, tier 0). The URL write auto-completes open " +
          "children with NO prompt (validated) — hazard H-PROJECT-COMPLETE-CHILDREN therefore " +
          "requires an explicit --children policy; the cascade is verified, not assumed.",
      )
      .requiredOption(
        "--children <policy>",
        "require-resolved (block if open children) | auto-complete (verified cascade)",
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
      .command("delete <uuid>")
      .description(
        "Move a project to the Trash (vector: applescript, tier 0). DB semantics are shallow " +
          "(validated A24B): children keep their links; Trash membership is derived.",
      ),
  ).action(async (uuid: string, opts: WriteFlagOpts) => {
    await runWrite(opts, (c) => c.write.deleteProject(uuid, writeOptionsFrom(opts)));
  });

  const area = group(program, "area", "Area-scoped operations");
  addWriteFlags(
    area
      .command("add <title>")
      .description(
        "Create an area (vector: applescript — the URL scheme cannot; tier 0). " +
          "Optionally tag it with EXISTING tags.",
      )
      .option("--tags <list>", "comma-separated existing tag names"),
  ).action(async (title: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const tags = splitCsv(opts["tags"] as string | undefined);
    await runWrite(opts, (c) =>
      c.write.addArea({ title, ...(tags !== undefined && { tags }) }, writeOptionsFrom(opts)),
    );
  });
  addWriteFlags(
    area
      .command("update <target>")
      .description(
        "Rename an area and/or replace its tags (vector: applescript, tier 0; E01). " +
          "Target by uuid or unique name. Hazard: H-UNKNOWN-TAG for --tags.",
      )
      .option("--title <text>", "new name")
      .option("--tags <list>", "comma-separated EXISTING tag names (full replacement)"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    const tags = splitCsv(opts["tags"] as string | undefined);
    if (opts["title"] === undefined && tags === undefined) {
      process.stderr.write("error: pass --title and/or --tags\n");
      process.exitCode = ExitCode.Usage;
      return;
    }
    await runWrite(opts, (c) =>
      c.write.updateArea(
        target,
        {
          ...(opts["title"] !== undefined && { title: opts["title"] as string }),
          ...(tags !== undefined && { tags }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    area
      .command("delete <target>")
      .description(
        "Delete an area PERMANENTLY (vector: applescript, tier 0). Areas skip the Trash " +
          "(validated A25); contained to-dos are trashed. Requires --dangerously-permanent.",
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
      .description(
        "Create a tag (vector: applescript — the URL scheme cannot; tier 0). " +
          "--parent nests it under an existing tag.",
      )
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
      .command("update <target>")
      .description(
        "Rename a tag (assignments survive — E02), nest it under an existing tag (E03), " +
          "and/or set its keyboard shortcut (E10). Vector: applescript, tier 0. " +
          "Un-nesting to root and clearing a shortcut are unprobed — not offered.",
      )
      .option("--title <text>", "new name")
      .option("--parent <name>", "existing tag to nest under")
      .option("--shortcut <char>", "keyboard shortcut character"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    if (
      opts["title"] === undefined &&
      opts["parent"] === undefined &&
      opts["shortcut"] === undefined
    ) {
      process.stderr.write("error: pass --title, --parent, and/or --shortcut\n");
      process.exitCode = ExitCode.Usage;
      return;
    }
    await runWrite(opts, (c) =>
      c.write.updateTag(
        target,
        {
          ...(opts["title"] !== undefined && { title: opts["title"] as string }),
          ...(opts["parent"] !== undefined && { parent: opts["parent"] as string }),
          ...(opts["shortcut"] !== undefined && { shortcut: opts["shortcut"] as string }),
        },
        writeOptionsFrom(opts),
      ),
    );
  });

  addWriteFlags(
    tag
      .command("delete <target>")
      .description(
        "Delete a tag PERMANENTLY (vector: applescript, tier 0). Assignments cascade " +
          "(validated A26). Requires --dangerously-permanent.",
      )
      .option("--dangerously-permanent", "accept permanent, unrecoverable deletion"),
  ).action(async (target: string, opts: WriteFlagOpts & Record<string, unknown>) => {
    await runWrite(opts, (c) =>
      c.write.deleteTag(
        target,
        writeOptionsFrom(opts, {
          ...(opts["dangerouslyPermanent"] !== undefined && {
            dangerouslyPermanent: opts["dangerouslyPermanent"] as boolean,
          }),
        }),
      ),
    );
  });

  const trash = group(program, "trash", "Trash-scoped operations");
  addWriteFlags(
    trash
      .command("empty")
      .description(
        "Empty the Trash: PERMANENTLY deletes every trashed row (vector: applescript, tier 0; " +
          "validated A27 — no tombstones with sync off). Requires --dangerously-permanent.",
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

  addWriteFlags(
    program
      .command("reorder <uuids...>")
      .description(
        "Reorder items within Today, This Evening, a project, or an area — uuids are placed " +
          "at the TOP in the given order; unlisted members keep their relative order below. " +
          "Strategies: native (private sdef command — EXPERIMENTAL, requires `things config " +
          "set allow-experimental true`; today/project/area) and bounce (verified when= " +
          `round-trips; today/evening, max ${BOUNCE_MAX_ITEMS} items). Evening is bounce-only: ` +
          "the native command silently de-evenings items (O03). Headed project children are " +
          "rejected (O06). Hazard: H-REORDER-SCOPE.",
      )
      .requiredOption("--scope <scope>", "today | evening | project | area")
      .option("--project <ref>", "project (uuid or unique name) — scope=project")
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
      "Dump the operation × vector support matrix (lab-validated data) — what is possible, " +
        "at which disruption tier, with which caveats",
    )
    .option("--op <operation>", "limit to one operation kind")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { op?: string; json?: boolean }) => {
      const vectors = defaultVectors();
      const ops = opts.op !== undefined ? [opts.op as OperationKind] : [...OPERATION_KINDS];
      const data = ops.map((op) => ({
        op,
        vectors: vectors.map((v) => ({ vector: v.id, ...(v.matrix[op] ?? { support: "no" }) })),
      }));
      if (opts.json) {
        const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
        process.stdout.write(`${JSON.stringify(okEnvelope("capabilities", data, meta))}\n`);
        return;
      }
      for (const entry of data) {
        process.stdout.write(`${entry.op}\n`);
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
    .description("Show the effective configuration (profile, disruption policy, audit)")
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
        "accepted-fingerprint | allow-experimental",
    )
    .action((key: string, value: string) => {
      const map: Record<string, string> = {
        profile: "profile",
        maxDisruption: "maxDisruption",
        actor: "actor",
        auditEnabled: "auditEnabled",
        "accepted-fingerprint": "acceptedFingerprint",
        "allow-experimental": "allowExperimental",
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
          : target === "auditEnabled" || target === "allowExperimental"
            ? value === "true"
            : value;
      saveConfigKey(target as never, parsed);
      process.stdout.write(`set ${key} = ${String(parsed)}\n`);
    });
}
