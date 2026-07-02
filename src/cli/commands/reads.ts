/**
 * Read-only list commands. Each renders a compact human table (UUIDs always
 * shown — agents and humans both need stable references) or a --json envelope.
 */
import type { Command } from "commander";

import { openThings, type ThingsClient } from "../../client.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import type { ListItem } from "../../read/views.ts";
import { ExitCode } from "../exit-codes.ts";
import { errorEnvelope, okEnvelope, type EnvelopeMeta } from "../output.ts";

interface GlobalReadOpts {
  json?: boolean;
  db?: string;
}

export function withClient(
  opts: GlobalReadOpts,
  kind: string,
  fn: (client: ThingsClient) => unknown,
  render: (data: never) => string[],
): void {
  const started = Date.now();
  let client: ThingsClient | null = null;
  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const fp = client.fingerprint();
    const data = fn(client);
    const meta: EnvelopeMeta = {
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown",
      elapsedMs: Date.now() - started,
    };
    if (fp.kind !== "ok") {
      process.stderr.write(
        `warning: schema fingerprint ${meta.fingerprint} — reads best-effort, writes disabled (run \`things doctor\`)\n`,
      );
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(okEnvelope(kind, data, meta))}\n`);
    } else {
      process.stdout.write(`${render(data as never).join("\n")}\n`);
    }
    process.exitCode = ExitCode.Ok;
  } catch (err) {
    const meta: EnvelopeMeta = {
      dbVersion: null,
      fingerprint: "unknown",
      elapsedMs: Date.now() - started,
    };
    const isEnv = err instanceof ThingsDbNotFoundError || err instanceof ThingsDbOpenError;
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(errorEnvelope({ code: isEnv ? "environment" : "unexpected", message }, meta))}\n`,
      );
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = isEnv ? ExitCode.Environment : ExitCode.Unexpected;
  } finally {
    client?.close();
  }
}

export function formatItem(item: ListItem): string {
  const marks = [
    item.type === "project" ? "P" : "-",
    item.deadline ? `!${item.deadline}` : null,
    item.startDate ? `@${item.startDate}` : null,
    item.tags.length > 0 ? `#${item.tags.map((t) => t.title).join(",#")}` : null,
    item.status !== "open" ? `[${item.status}]` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const context =
    item.type === "to-do" && item.project
      ? ` (${item.project.title})`
      : item.area
        ? ` (${item.area.title})`
        : "";
  return `${item.uuid}  ${marks.padEnd(2)} ${item.title}${context}`;
}

function renderList(items: ListItem[]): string[] {
  return items.length === 0 ? ["(empty)"] : items.map(formatItem);
}

export function registerReadCommands(program: Command): void {
  const listCommands: Array<{
    name: string;
    description: string;
    fetch: (client: ThingsClient) => unknown;
    render?: (data: never) => string[];
  }> = [
    {
      name: "today",
      description: "The Today list, split into Today and This Evening, in UI order",
      fetch: (c) => c.read.today(),
      render: (data: { today: ListItem[]; evening: ListItem[] }) => [
        "── Today ──",
        ...renderList(data.today),
        "── This Evening ──",
        ...renderList(data.evening),
      ],
    },
    { name: "inbox", description: "Unprocessed captures (Inbox)", fetch: (c) => c.read.inbox() },
    {
      name: "anytime",
      description: "Active, unscheduled items (Anytime, strictly unscheduled)",
      fetch: (c) => c.read.anytime(),
    },
    {
      name: "upcoming",
      description:
        "Future-scheduled items grouped chronologically (repeating occurrences not yet included)",
      fetch: (c) => c.read.upcoming(),
    },
    {
      name: "someday",
      description: "Someday items (incubated, undated)",
      fetch: (c) => c.read.someday(),
    },
    {
      name: "logbook",
      description: "Completed and canceled items, most recent first (--limit)",
      fetch: (c) => c.read.logbook(),
    },
    {
      name: "trash",
      description: "Trashed items (trashed=1 flag, any status)",
      fetch: (c) => c.read.trash(),
    },
  ];

  for (const cmd of listCommands) {
    program
      .command(cmd.name)
      .description(cmd.description)
      .option("--json", "emit versioned JSON envelope on stdout")
      .option("--db <path>", "explicit database path")
      .action((opts: GlobalReadOpts) => {
        withClient(opts, cmd.name, cmd.fetch, (cmd.render ?? renderList) as (d: never) => string[]);
      });
  }

  program
    .command("projects")
    .description("Active projects (optionally scoped to --area <uuid>)")
    .option("--area <uuid>", "filter by area uuid")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { area?: string }) => {
      withClient(
        opts,
        "projects",
        (c) => c.read.projects(opts.area ? { areaUuid: opts.area } : {}),
        renderList as (d: never) => string[],
      );
    });

  program
    .command("areas")
    .description("All areas with their direct tags")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts) => {
      withClient(opts, "areas", (c) => c.read.areas(), ((
        data: Array<{ uuid: string; title: string; tags: Array<{ title: string }> }>,
      ) =>
        data.map(
          (a) =>
            `${a.uuid}  ${a.title}${a.tags.length ? ` #${a.tags.map((t) => t.title).join(" #")}` : ""}`,
        )) as (d: never) => string[]);
    });

  program
    .command("tags")
    .description("Tag taxonomy (parent → child hierarchy flattened with refs)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts) => {
      withClient(opts, "tags", (c) => c.read.tags(), ((
        data: Array<{ uuid: string; title: string; parent: { title: string } | null }>,
      ) => data.map((t) => `${t.uuid}  ${t.parent ? `${t.parent.title}/` : ""}${t.title}`)) as (
        d: never,
      ) => string[]);
    });

  program
    .command("search <query>")
    .description("Title/notes substring search across all items (most recently modified first)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((query: string, opts: GlobalReadOpts) => {
      withClient(opts, "search", (c) => c.read.search(query), renderList as (d: never) => string[]);
    });
}
