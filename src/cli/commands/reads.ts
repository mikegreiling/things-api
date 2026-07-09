/**
 * Read-only list commands. Each renders a compact human table (UUIDs always
 * shown — agents and humans both need stable references) or a --json envelope.
 */
import type { Command } from "commander";

import { openThings, type ThingsClient } from "../../client.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import { isTodayMember, type ListItem, type SidebarSection } from "../../read/views.ts";
import { bold, cyan, dim, magenta, red, yellow } from "../style.ts";

import { errorEnvelope, ExitCode, okEnvelope, type EnvelopeMeta } from "../../contracts.ts";

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

/**
 * One item line: `<uuid>  <marker> [meta …] <title> (container)`. The uuid
 * column pads to `uuidWidth` (uuids vary 21–22 chars) so the marker column
 * aligns; exactly one space separates every following token. Meta tokens are
 * colorized on a TTY only (see ../style.ts) — piped output stays plain.
 */
export function formatItem(item: ListItem, uuidWidth = 0): string {
  const marker = (item.type === "project" ? "P" : "-") + (item.repeating.isTemplate ? "↻" : "");
  const meta = [
    item.deadline ? red(`!${item.deadline}`) : null,
    item.startDate ? yellow(`@${item.startDate}`) : null,
    item.tags.length > 0 ? cyan(`#${item.tags.map((t) => t.title).join(",#")}`) : null,
    item.status !== "open" ? magenta(`[${item.status}]`) : null,
  ].filter((s): s is string => s !== null);
  const context =
    item.type === "to-do" && item.project
      ? ` (${item.project.title})`
      : item.area
        ? ` (${item.area.title})`
        : "";
  return [
    `${dim(item.uuid.padEnd(uuidWidth))} `,
    marker,
    ...meta,
    context === "" ? item.title : `${item.title}${dim(context)}`,
  ].join(" ");
}

function uuidWidth(items: ListItem[]): number {
  return items.reduce((w, i) => Math.max(w, i.uuid.length), 0);
}

function renderList(items: ListItem[]): string[] {
  const w = uuidWidth(items);
  return items.length === 0 ? ["(empty)"] : items.map((i) => formatItem(i, w));
}

/**
 * Sidebar-grouped views (anytime/someday): the area-less block renders
 * headerless first, then one `── <area> ──` header per area, mirroring the
 * app's layout. `star` prefixes each line with the Today-membership star.
 */
function renderSections(sections: SidebarSection[], star = false): string[] {
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return ["(empty)"];
  const w = uuidWidth(all);
  const lines: string[] = [];
  for (const section of sections) {
    if (section.area !== null) lines.push(bold(`── ${section.area.title} ──`));
    for (const item of section.items) {
      const prefix = star ? `${isTodayMember(item) ? yellow("★") : " "} ` : "";
      lines.push(`${prefix}${formatItem(item, w)}`);
    }
  }
  return lines;
}

export function registerReadCommands(program: Command): void {
  const listCommands: Array<{
    name: string;
    description: string;
    fetch: (client: ThingsClient, tag?: string, exactTag?: boolean, extra?: boolean) => unknown;
    render?: (data: never) => string[];
    /** One extra boolean option: [flags, description, opts-key]. */
    extraOption?: [string, string, string];
  }> = [
    {
      name: "today",
      description:
        "The Today list, split into Today and This Evening (evening expires daily), with the sidebar badge split (red = deadline due/overdue)",
      fetch: (c, tag, exactTag) =>
        c.read.today(
          tag === undefined ? undefined : { tag, ...(exactTag === true && { exactTag }) },
        ),
      render: (data: {
        today: ListItem[];
        evening: ListItem[];
        badge: { dueOrOverdue: number; other: number };
      }) => [
        `── Today (badge: ${data.badge.dueOrOverdue} due/overdue · ${data.badge.other} other) ──`,
        ...renderList(data.today),
        "── This Evening ──",
        ...renderList(data.evening),
      ],
    },
    {
      name: "inbox",
      description: "Unprocessed captures (Inbox)",
      fetch: (c, tag, exactTag) =>
        c.read.inbox(
          tag === undefined ? undefined : { tag, ...(exactTag === true && { exactTag }) },
        ),
    },
    {
      name: "anytime",
      description:
        "All active items in the UI's sidebar-mirroring order (area-less first, then per " +
        "area: direct to-dos, then each project with its members). Today members are " +
        "starred (★). Children of someday/future-scheduled projects are excluded — the " +
        "project row represents them",
      fetch: (c, tag, exactTag) =>
        c.read.anytime(
          tag === undefined ? undefined : { tag, ...(exactTag === true && { exactTag }) },
        ),
      render: (sections: SidebarSection[]) => renderSections(sections, true),
    },
    {
      name: "someday",
      description:
        "Someday items (incubated, undated) in sidebar order. Project children are " +
        "represented by their project row; --active-project-items also lists someday " +
        "to-dos inside active projects (the UI's 'Show items from active projects' toggle)",
      fetch: (c, tag, exactTag, activeProjectItems) =>
        c.read.someday({
          ...(tag !== undefined && { tag }),
          ...(exactTag === true && { exactTag }),
          ...(activeProjectItems === true && { activeProjectItems }),
        }),
      render: (sections: SidebarSection[]) => renderSections(sections),
      extraOption: [
        "--active-project-items",
        "also list someday to-dos inside active projects",
        "activeProjectItems",
      ],
    },
  ];

  for (const cmd of listCommands) {
    const command = program
      .command(cmd.name)
      .description(cmd.description)
      .option(
        "--tag <ref>",
        "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
      )
      .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
      .option("--json", "emit versioned JSON envelope on stdout")
      .option("--db <path>", "explicit database path");
    if (cmd.extraOption) command.option(cmd.extraOption[0], cmd.extraOption[1]);
    command.action(
      (opts: GlobalReadOpts & { tag?: string; exactTag?: boolean } & Record<string, unknown>) => {
        const extra = cmd.extraOption ? opts[cmd.extraOption[2]] === true : undefined;
        withClient(
          opts,
          cmd.name,
          (c) => cmd.fetch(c, opts.tag, opts.exactTag, extra),
          (cmd.render ?? renderList) as (d: never) => string[],
        );
      },
    );
  }

  program
    .command("upcoming")
    .description(
      "Future-scheduled items in date order, INCLUDING each repeating item's next " +
        "occurrence (↻ marker; deadline derived from the repeat rule). --horizon <n> also " +
        "PROJECTS the following n-1 occurrences per repeating item from its decoded rule " +
        "(fixed rules only, max 10) — projections are host math the app has not " +
        "materialized yet.",
    )
    .option(
      "--tag <ref>",
      "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
    )
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--horizon <n>", "occurrences per repeating item (default 1 = UI parity)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { tag?: string; exactTag?: boolean; horizon?: string }) => {
      withClient(
        opts,
        "upcoming",
        (c) =>
          c.read.upcoming({
            ...(opts.tag !== undefined && { tag: opts.tag }),
            ...(opts.exactTag === true && { exactTag: true }),
            ...(opts.horizon !== undefined && { horizon: Number(opts.horizon) }),
          }),
        renderList as (d: never) => string[],
      );
    });

  for (const cmd of [
    {
      name: "logbook",
      description: "Completed and canceled items, most recent first",
      fetch: (c: ThingsClient, limit: number, tag?: string, exactTag?: boolean) =>
        c.read.logbook({
          limit,
          ...(tag !== undefined && { tag }),
          ...(exactTag === true && { exactTag }),
        }),
      defaultLimit: 100,
    },
    {
      name: "trash",
      description: "Trashed items (trashed=1 flag, any status), most recently modified first",
      fetch: (c: ThingsClient, limit: number, _tag?: string, _exactTag?: boolean) =>
        c.read.trash({ limit }),
      defaultLimit: 200,
    },
  ]) {
    program
      .command(cmd.name)
      .description(cmd.description)
      .option("--limit <n>", "maximum items to return", String(cmd.defaultLimit))
      .option(
        "--tag <ref>",
        "filter by tag (uuid or unique name), direct OR inherited — logbook only",
      )
      .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
      .option("--json", "emit versioned JSON envelope on stdout")
      .option("--db <path>", "explicit database path")
      .action((opts: GlobalReadOpts & { limit: string; tag?: string; exactTag?: boolean }) => {
        withClient(
          opts,
          cmd.name,
          (c) => cmd.fetch(c, Number(opts.limit), opts.tag, opts.exactTag),
          renderList as (d: never) => string[],
        );
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
    .command("changes")
    .description(
      "Everything created or modified since a moment (--since), newest first — INCLUDES " +
        "trashed, logged, and repeating-template rows so agents can sync state; check " +
        "trashed/status/repeating on each item. Caveats: tag/area edits and checklist-item " +
        "edits don't bump tasks and are invisible here.",
    )
    .requiredOption("--since <when>", "ISO date/datetime (e.g. 2026-07-05T14:30:00)")
    .option("--limit <n>", "maximum items", "200")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { since: string; limit: string }) => {
      const since = new Date(opts.since);
      if (Number.isNaN(since.getTime())) {
        process.stderr.write(`error: --since is not a parseable date: ${opts.since}\n`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      withClient(opts, "changes", (c) => c.read.changes({ since, limit: Number(opts.limit) }), ((
        items: Array<ListItem & { changeKind: string }>,
      ) =>
        items.length === 0
          ? ["(no changes)"]
          : items.map(
              (i) =>
                `${i.changeKind === "created" ? "+" : "~"} ${formatItem(i)}${i.trashed ? " [trashed]" : ""}`,
            )) as (d: never) => string[]);
    });

  program
    .command("search <query>")
    .description(
      "Title/notes substring search, most recently modified first. Default scope: OPEN + " +
        "untrashed items only — widen with --logged / --trashed / --all. Scope with " +
        "--project / --area / --tag (tag matches include hierarchy descendants) / --type.",
    )
    .option("--project <ref>", "restrict to one project's children (uuid or unique name)")
    .option("--area <ref>", "restrict to one area's direct members (uuid or unique name)")
    .option("--tag <ref>", "restrict by tag: direct, inherited, or descendant-tagged")
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--type <kind>", "todo | project")
    .option("--logged", "include completed/canceled items")
    .option("--trashed", "include trashed items")
    .option("--all", "legacy behavior: everything (open + logged + trashed)")
    .option("--limit <n>", "maximum results", "50")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((query: string, opts: GlobalReadOpts & Record<string, unknown>) => {
      const type = opts["type"] as string | undefined;
      if (type !== undefined && type !== "todo" && type !== "project") {
        process.stderr.write("error: --type must be todo or project\n");
        process.exitCode = 2;
        return;
      }
      withClient(
        opts,
        "search",
        (c) =>
          c.read.search(query, {
            limit: Number(opts["limit"] ?? 50),
            ...(opts["project"] !== undefined && { project: opts["project"] as string }),
            ...(opts["area"] !== undefined && { area: opts["area"] as string }),
            ...(opts["tag"] !== undefined && { tag: opts["tag"] as string }),
            ...(opts["exactTag"] === true && { exactTag: true }),
            ...(type !== undefined && { type: type === "todo" ? "to-do" : "project" }),
            ...(opts["logged"] === true && { logged: true }),
            ...(opts["trashed"] === true && { trashed: true }),
            ...(opts["all"] === true && { all: true }),
          }),
        renderList as (d: never) => string[],
      );
    });
}
