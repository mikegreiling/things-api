/**
 * Read-only list commands. Each renders a compact human table (UUIDs always
 * shown — agents and humans both need stable references) or a --json envelope.
 */
import { Option, type Command } from "commander";
import { execFileSync } from "node:child_process";

import { openThings, type ThingsClient } from "../../client.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import { isTodayMember, type ListItem, type SidebarSection } from "../../read/views.ts";
import { localToday } from "../../model/dates.ts";
import { templateStatus } from "../../model/recurrence.ts";
import { blue, bold, dim, strike, underline } from "../style.ts";
import { getInvocation } from "../resolve-invocation.ts";
import {
  areaMark,
  CHECKLIST_MARK,
  countChip,
  dateChip,
  deadlineToken,
  eveningMoon,
  LEGEND,
  LEGEND_GROUPS,
  loggedDate,
  NOTES_MARK,
  projectCircle,
  REMINDER_MARK,
  shortDate,
  todayStar,
  todoBox,
} from "../glyphs.ts";

import {
  errorEnvelope,
  ExitCode,
  okEnvelope,
  type EnvelopeMeta,
  type GroupedPagination,
  type Pagination,
} from "../../contracts.ts";
import {
  AREA_PREVIEW_LIMIT,
  DEFAULT_LIST_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  paginateList,
  paginateToday,
  partitionSomedaySection,
  previewSections,
  previewSomedaySections,
  splitSectionBlocks,
  type GroupedLimits,
} from "../../read/pagination.ts";
import {
  ALL_DESC,
  AREA_LIMIT_DESC,
  GROUPED_ALL_DESC,
  LIMIT_DESC,
  PERIOD_SINCE,
  PERIOD_UNTIL,
  PROJECT_LIMIT_DESC,
} from "../../surface-copy.ts";

interface GlobalReadOpts {
  json?: boolean;
  db?: string;
}

export interface PagedResult<T> {
  data: T;
  /** Flat-view truncation — carried into meta and the appended hint. */
  pagination?: Pagination;
  /** Grouped-view (anytime/someday) per-block truncation — carried into meta. */
  grouped?: GroupedPagination;
  /**
   * Precomputed human lines. Grouped views render inside `fn` (where the full
   * per-block totals live) and hand the finished lines back here; when absent,
   * `render(data)` produces them.
   */
  lines?: string[];
}

/**
 * A view's TTY-only title preamble: bold view name + its dim Things deep link,
 * then a blank line — e.g. `Anytime (things:///show?id=anytime)`. The id is the
 * app's documented show id (identical to the command name for these views).
 * Suppressed off a TTY so `things inbox | grep …` stays clean, and never part
 * of `--json`; the caller gates on both.
 */
export function viewHeaderLines(view: string): string[] {
  const title = view.charAt(0).toUpperCase() + view.slice(1);
  return [`${bold(title)} ${dim(`(things:///show?id=${view})`)}`, ""];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");
const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

/** Left-column width for the legend's glyph samples (short marks align; long textual samples overflow). */
const LEGEND_GUTTER = 10;

/**
 * The `things legend` layout: the visual language grouped into sections
 * (`── To-dos ──`, …), each row the glyph as it actually renders (color on a
 * TTY) followed by its meaning. Content comes straight from glyphs.ts's LEGEND
 * table, so it can never drift from what the list renderers emit.
 */
export function renderLegend(): string[] {
  const lines: string[] = [];
  for (const group of LEGEND_GROUPS) {
    const entries = LEGEND.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(bold(`── ${group} ──`));
    for (const e of entries) {
      const pad = " ".repeat(Math.max(0, LEGEND_GUTTER - visibleWidth(e.glyph)));
      lines.push(`${e.glyph}${pad}  ${e.meaning}`);
    }
  }
  return lines;
}

/**
 * The shared read driver: open the client, stamp the envelope meta (including
 * fingerprint + optional pagination), and either emit the `--json` envelope or
 * render human lines. When `hintBase` is given and the result was truncated,
 * the muted "N more items" hint (reconstructing the user's own invocation) is
 * appended to the human output — never to `--json`. When `header` names a view,
 * its title preamble leads the human output on a TTY only (viewHeaderLines).
 */
export function runRead<T>(
  opts: GlobalReadOpts,
  kind: string,
  fn: (client: ThingsClient) => PagedResult<T>,
  render: (data: T) => string[],
  hintBase?: string,
  header?: string,
): void {
  const started = Date.now();
  // An empty --db would silently fall through to the default database path —
  // reject it loudly instead of reading somewhere the caller did not name.
  if (opts.db !== undefined && opts.db.trim() === "") {
    process.stderr.write("error: --db requires a non-empty path\n");
    process.exitCode = ExitCode.Usage;
    return;
  }
  let client: ThingsClient | null = null;
  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const fp = client.fingerprint();
    const { data, pagination, grouped, lines: precomputed } = fn(client);
    // The canonical command a sugar invocation normalized to — known now that
    // `fn` has resolved any reference. Present only for the routing sugars
    // (bare noun, keyword-in-show, uuid/share-link routing); null otherwise.
    const resolvedCommand = getInvocation()?.canonical ?? null;
    const meta: EnvelopeMeta = {
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown",
      elapsedMs: Date.now() - started,
      ...(pagination !== undefined && { pagination }),
      ...(grouped !== undefined && { grouped }),
      ...(resolvedCommand !== null && { resolvedCommand }),
    };
    if (fp.kind !== "ok") {
      process.stderr.write(
        `warning: schema fingerprint ${meta.fingerprint} — reads best-effort, writes disabled (run \`things doctor\`)\n`,
      );
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(okEnvelope(kind, data, meta))}\n`);
    } else {
      const lines = precomputed ?? render(data);
      if (pagination !== undefined && hintBase !== undefined) {
        const hint = truncationHint(hintBase, pagination);
        if (hint !== null) lines.push("", hint);
      }
      // The view title preamble is a TTY-only affordance (`things inbox | grep`
      // must stay clean) and never rides --json — both gates already hold here.
      const withHeader =
        header !== undefined && process.stdout.isTTY === true
          ? [...viewHeaderLines(header), ...lines]
          : lines;
      // The normalized-form echo: one dim line naming the canonical command a
      // sugar invocation resolved to, adjacent to the header. Same gates as the
      // preamble (TTY-only, never in --json) — canonical invocations echo
      // nothing because `resolvedCommand` is null for them.
      const out =
        resolvedCommand !== null && process.stdout.isTTY === true
          ? [dim(`≡ ${resolvedCommand}`), ...withHeader]
          : withHeader;
      process.stdout.write(`${out.join("\n")}\n`);
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

export function withClient(
  opts: GlobalReadOpts,
  kind: string,
  fn: (client: ThingsClient) => unknown,
  render: (data: never) => string[],
): void {
  runRead(opts, kind, (client) => ({ data: fn(client) }), render as (data: unknown) => string[]);
}

/** Result of resolving `--limit`/`--all`; `limit: null` means every row. */
type LimitResolution = { ok: true; limit: number | null } | { ok: false };

/**
 * Resolve the shared `--limit`/`--all` pair (flat views) into a row cap
 * (null = no cap), writing a loud usage error and setting the exit code on
 * bad input: `--limit` must be a positive integer, and it may not combine
 * with `--all`.
 */
export function parseLimit(opts: { limit?: string; all?: boolean }): LimitResolution {
  return parseCap("--limit", opts.limit, DEFAULT_LIST_LIMIT, opts.all === true);
}

/**
 * Resolve one cap flag (`--limit`, `--area-limit`, `--project-limit`) against
 * `--all`: positive integer required, `--all` conflicts with an explicit
 * value and otherwise lifts the cap (null).
 */
export function parseCap(
  flag: string,
  value: string | undefined,
  defaultLimit: number,
  all: boolean,
): LimitResolution {
  if (all && value !== undefined) {
    process.stderr.write(`error: ${flag} and --all are mutually exclusive\n`);
    process.exitCode = ExitCode.Usage;
    return { ok: false };
  }
  if (all) return { ok: true, limit: null };
  if (value === undefined) return { ok: true, limit: defaultLimit };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`error: ${flag} must be a positive integer\n`);
    process.exitCode = ExitCode.Usage;
    return { ok: false };
  }
  return { ok: true, limit: n };
}

/** Shell-safe rendering of a flag value for the reconstructed hint command. */
export function shellQuote(v: string): string {
  return /^[\w./@:+-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Reconstruct `things <name> <flags…>`, dropping falsy/empty parts. */
export function invocation(name: string, parts: Array<string | false | undefined>): string {
  return [
    "things",
    name,
    ...parts.filter((p): p is string => typeof p === "string" && p !== ""),
  ].join(" ");
}

/**
 * The unified truncation hint: a muted `── N more items — see more: … · all:
 * … ──` line whose commands echo the user's actual invocation, so a bigger
 * `--limit` or `--all` is one copy-paste away. Returns null when nothing was
 * dropped or the caller already asked for every row.
 */
export function truncationHint(base: string, pagination: Pagination): string | null {
  if (!pagination.truncated || pagination.limit === null) return null;
  const more = pagination.total - pagination.shown;
  const bigger = pagination.limit * 2;
  return dim(
    `── ${more} more item${more === 1 ? "" : "s"} — see more: \`${base} --limit ${bigger}\` · all: \`${base} --all\` ──`,
  );
}

export interface FormatOpts {
  /**
   * Render a grouped project TITLE row: bold+underlined title (the GUI's
   * project-header look) — the circle glyph and count chip still apply.
   */
  projectTitle?: boolean;
  /** Container uuids already implied by surrounding output — their context suffix is dropped. */
  suppressProject?: string | null;
  suppressArea?: string | null;
  /** Reference instant for date-relative tokens (tests pin this; defaults to now). */
  now?: Date;
  /** Pre-styled Today/Evening mark (★/⏾), rendered right after the box — GUI position. */
  mark?: string | null;
  /** Dim status word after the box (the GUI's waiting/paused/ended chips on repeating templates). */
  statusWord?: string;
  /** Suppress the ‹date› chip (rows under a day header already carry the date). */
  hideDateChip?: boolean;
}

/**
 * One item line:
 * `<uuid-prefix>  <box> [★|⏾] [logged-date] [‹chip›] <title> [‹n›] [⍾] [≡] [≔] (container) #tags [⚑ deadline]`.
 * Repeating templates seat ↻ INSIDE the box (`[↻]`/`(↻)`) rather than as a
 * separate mark; open project rows render their circle and title blue.
 * The box is the glyph-language state carrier (../glyphs.ts): `[ ]`-family
 * for to-dos, `( )`-family for projects — state survives with color
 * stripped. Completed titles dim; canceled titles dim+strike (the `[×]`
 * mark keeps the state when strike/ANSI is unavailable). Human output shows
 * a SHORTENED uuid prefix (every command accepts unique prefixes >= 6
 * chars); `uuidWidth` is the display length from uuidDisplayWidth — never
 * below 8 so a copied prefix stays unique across the whole database, not
 * just the rendered list. Tags follow the title (`#`-prefixed, green — GUI
 * color), after the count chip (projects), notes marker, and container.
 * Heading-nested to-dos label their parent PROJECT (via headingProject),
 * never the heading — GUI behavior. Colors engage on a TTY only
 * (../style.ts); `--json` always carries full uuids.
 */
export function formatItem(item: ListItem, uuidWidth = 0, opts: FormatOpts = {}): string {
  const todayIso = localToday(opts.now);
  const asTitle = opts.projectTitle === true && item.type === "project";
  const box = item.type === "project" ? projectCircle(item) : todoBox(item);
  const meta: string[] = [];
  if (opts.mark != null) meta.push(opts.mark);
  // ↻ now lives INSIDE the box for templates (glyphs.ts) — no separate mark.
  if (opts.statusWord !== undefined) meta.push(dim(opts.statusWord));
  if (item.status !== "open" && item.stopped !== null)
    meta.push(loggedDate(item.stopped, todayIso));
  if (opts.hideDateChip === true) {
    // rows under a day header — the header carries the date
  } else if (item.status === "open" && item.startDate !== null && item.startDate > todayIso)
    meta.push(dateChip(item.startDate, todayIso));
  // Repeating templates chip their app-materialized next occurrence.
  else if (item.repeating.isTemplate && item.repeating.nextOccurrence != null)
    meta.push(dateChip(item.repeating.nextOccurrence, todayIso));
  // List rows mute their tags (the GUI's gray pills); tags go green only on
  // the opened resource (todo show / the project|area header row).
  const tags =
    item.tags.length > 0 ? ` ${dim(`#${item.tags.map((t) => t.title).join(" #")}`)}` : "";
  // Closed rows drop the deadline flag — a months-old red "n days ago" on a
  // logged item is noise (the GUI doesn't flag logbook rows either). Raw
  // template rows drop it via the sentinel guard: their deadline column
  // carries app-internal 4001-01-01 sentinels (upcoming's synthesized
  // occurrences carry REAL rule-derived deadlines and must keep the flag).
  const rule = item.repeating.rule;
  const deadline =
    item.status === "open" && item.deadline !== null && item.deadline < "4000"
      ? ` ${deadlineToken(item.deadline, todayIso)}`
      : // The GUI's bare flag on no-date repeating templates: the rule WILL
        // assign each occurrence a deadline (fixed rules always do; after-
        // completion only with a start offset), date unknown until spawned.
        item.repeating.isTemplate &&
          rule !== undefined &&
          (rule.type === "fixed" || rule.startOffsetDays < 0)
        ? ` ${bold(dim("⚑"))}`
        : "";
  const container = item.type === "to-do" ? (item.project ?? item.headingProject ?? null) : null;
  const context =
    container !== null
      ? container.uuid === opts.suppressProject
        ? ""
        : ` (${container.title})`
      : item.area
        ? item.area.uuid === opts.suppressArea
          ? ""
          : ` (${item.area.title})`
        : "";
  // width 0 (the default) means "no column" — show the full uuid untouched.
  const shownUuid = uuidWidth > 0 ? uuidCol(item.uuid, uuidWidth) : item.uuid;
  let title = item.title;
  if (asTitle) title = bold(underline(title));
  else if (item.status === "canceled") title = dim(strike(title));
  else if (item.status === "completed") title = dim(title);
  // Open project rows render their title blue — GUI parity (list accent) and
  // a color cue reinforcing the round bracket. To-dos stay default-colored.
  else if (item.type === "project") title = blue(title);
  // GUI indicator order after the title: bell, document, checklist.
  const tail = [
    ...(item.type === "project" ? [countChip(item)] : []),
    ...(item.reminder !== null ? [dim(REMINDER_MARK)] : []),
    ...(item.notes !== "" ? [dim(NOTES_MARK)] : []),
    ...(item.type === "to-do" && item.checklistItemsCount > 0 ? [dim(CHECKLIST_MARK)] : []),
  ];
  return [
    `${dim(shownUuid)} `,
    box,
    ...meta,
    `${title}${tail.length > 0 ? ` ${tail.join(" ")}` : ""}${tags}${context === "" ? "" : dim(context)}${deadline}`,
  ].join(" ");
}

/**
 * Row prefix in today-aware views: yellow ★ for Today members, cyan ⏾ for
 * effective This-Evening members (raw evening assignment counts only while
 * startDate is exactly today — the UI's daily expiry), null otherwise.
 */
export function todayMark(item: ListItem, now?: Date): string | null {
  if (!isTodayMember(item, now)) return null;
  const evening = item.todaySection === "evening" && item.startDate === localToday(now);
  return evening ? eveningMoon() : todayStar();
}

/**
 * Foreground the Things app on a resource via its share URI. A GUI action
 * on this Mac — NOT headless; the shared implementation behind every
 * `open` command. Returns the URI it launched.
 */
export function openInThings(uuid: string): string {
  const uri = `things:///show?id=${uuid}`;
  execFileSync("/usr/bin/open", [uri]);
  return uri;
}

/** Minimum displayed-prefix length: shorter prefixes collide across the DB. */
const UUID_DISPLAY_MIN = 8;

/**
 * Display width for a list's uuid column: the shortest prefix that is
 * unique WITHIN the list, floored at UUID_DISPLAY_MIN (list-local
 * uniqueness at 2–3 chars would still collide database-wide).
 */
export function uuidDisplayWidth(items: Array<{ uuid: string }>): number {
  if (items.length === 0) return UUID_DISPLAY_MIN;
  const sorted = items.map((i) => i.uuid).toSorted();
  let needed = 1;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] ?? "";
    const b = sorted[i] ?? "";
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    needed = Math.max(needed, common + 1);
  }
  return Math.max(UUID_DISPLAY_MIN, needed);
}

/**
 * Fit a uuid into the shared id column: truncate to `width` when longer, pad
 * to it when shorter, so ids line up under one another regardless of prefix
 * length. `width` is the value from uuidDisplayWidth.
 */
export function uuidCol(uuid: string, width: number): string {
  return uuid.length > width ? uuid.slice(0, width) : uuid.padEnd(width);
}

function renderList(items: ListItem[]): string[] {
  const w = uuidDisplayWidth(items);
  return items.length === 0 ? ["(empty)"] : items.map((i) => formatItem(i, w));
}

/** Hidden-later counts per sidebar group (null area = the loose block). */
export interface LaterHints {
  /** Sidebar-ordered, INCLUDING groups whose every project is later. */
  groups: Array<{ area: { uuid: string; title: string } | null; hidden: number }>;
}

/**
 * The sidebar mirror for `things projects`: loose projects first (the GUI
 * lists them above the areas), then a `── ⬡ Area ──` header per area with
 * its projects beneath (the redundant `(Area)` suffix suppressed). Items
 * arrive from projectsView already in sidebar order — this only inserts the
 * headers. Denser than renderSections on purpose: no title styling and no
 * blank line per project (every row here IS a project). With `hints`,
 * default-hidden later projects are never silent: each group trails a muted
 * `…n later projects` count (a later-only area still gets its header), and
 * the output ends with the flag that reveals them.
 */
export function renderProjectsSidebar(items: ListItem[], hints?: LaterHints): string[] {
  const total = hints?.groups.reduce((n, g) => n + g.hidden, 0) ?? 0;
  if (items.length === 0 && total === 0 && (hints === undefined || hints.groups.length === 0))
    return ["(empty)"];
  const w = uuidDisplayWidth(items);
  const byGroup = new Map<string | null, ListItem[]>();
  for (const item of items) {
    const key = item.area?.uuid ?? null;
    byGroup.set(key, [...(byGroup.get(key) ?? []), item]);
  }
  // hints (when present) carry the full sidebar group order, including
  // later-only groups the visible items can't reveal.
  const groups =
    hints?.groups ??
    [...byGroup.keys()].map((key) => ({
      area: key === null ? null : (items.find((i) => i.area?.uuid === key)?.area ?? null),
      hidden: 0,
    }));
  const lines: string[] = [];
  for (const group of groups) {
    const rows = byGroup.get(group.area?.uuid ?? null) ?? [];
    // The loose block only exists when it has content; areas mirror the
    // sidebar and render even when empty.
    if (group.area === null && rows.length === 0 && group.hidden === 0) continue;
    if (group.area !== null) {
      if (lines.length > 0) lines.push("");
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${group.area.title} ──`)}`);
    }
    lines.push(
      ...rows.map((item) => formatItem(item, w, { suppressArea: group.area?.uuid ?? null })),
    );
    if (group.hidden > 0)
      lines.push(dim(`…${group.hidden} later project${group.hidden === 1 ? "" : "s"}`));
    else if (group.area !== null && rows.length === 0) lines.push(dim("(no projects)"));
  }
  if (total > 0)
    lines.push(
      "",
      dim(
        `(${total} later project${total === 1 ? "" : "s"} — visible with \`things projects --show-later\`)`,
      ),
    );
  return lines;
}

const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Relative period: `3d`/`2w`/`1m`/`1y` (days/weeks/calendar months/years),
 * counted from `now` — FORWARD for an until-bound, BACKWARD for a since-
 * bound (each command's natural direction; the flag name carries it).
 */
const RELATIVE_PERIOD = /^(\d+)([dwmy])$/i;

function relativePeriodDate(m: RegExpExecArray, now: Date, sign: 1 | -1): Date {
  const n = sign * Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const d = new Date(now);
  if (unit === "d") d.setDate(d.getDate() + n);
  else if (unit === "w") d.setDate(d.getDate() + 7 * n);
  else if (unit === "m") d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d;
}

/**
 * `--until` accepting whole periods: `2024` means through Dec 31 2024,
 * `2024-03` through Mar 31, `2024-03-05` through end of that day; relative
 * periods (`2w`, `1m`, `1y`) count FORWARD from now through the end of the
 * landing day; anything else parses as an instant.
 */
export function parsePeriodEnd(s: string, now: Date = new Date()): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    const d = relativePeriodDate(rel, now, 1);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  const year = Number(m[1]);
  // Day 0 of month n+1 = the last day of month n.
  if (m[2] === undefined) return new Date(year, 11, 31, 23, 59, 59, 999);
  const month = Number(m[2]) - 1;
  if (m[3] === undefined) return new Date(year, month + 1, 0, 23, 59, 59, 999);
  return new Date(year, month, Number(m[3]), 23, 59, 59, 999);
}

/**
 * `--since` accepting the same vocabulary at the period's START: `2024` =
 * Jan 1 2024 00:00, `2024-03` = Mar 1, `2024-03-05` = that midnight;
 * relative periods (`2w`, `1m`) count BACKWARD from now to the landing
 * day's midnight; anything else parses as an instant.
 */
export function parsePeriodStart(s: string, now: Date = new Date()): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    const d = relativePeriodDate(rel, now, -1);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  const year = Number(m[1]);
  if (m[2] === undefined) return new Date(year, 0, 1);
  const month = Number(m[2]) - 1;
  if (m[3] === undefined) return new Date(year, month, 1);
  return new Date(year, month, Number(m[3]));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * GUI-style Upcoming bucket for a date, granularity decaying with distance:
 * individual days for the next week ("Wed Jul 15"), the remainder of the
 * current month ("Jul 19–31"), months through the end of NEXT year
 * ("August", "January 2027"), then bare years ("2028").
 */
function upcomingBucket(iso: string, todayIso: string): { label: string; isDay: boolean } {
  const [y, m, d] = iso.split("-").map(Number);
  const [y0, m0, d0] = todayIso.split("-").map(Number);
  const diff = Math.round(
    (Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - Date.UTC(y0 ?? 0, (m0 ?? 1) - 1, d0 ?? 1)) /
      86_400_000,
  );
  if (diff <= 7) {
    const weekday = WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()];
    return { label: `${weekday} ${SHORT_MONTHS[(m ?? 1) - 1]} ${d}`, isDay: true };
  }
  if (y === y0 && m === m0) {
    const lastDay = new Date(y ?? 0, m ?? 1, 0).getDate();
    return { label: `${SHORT_MONTHS[(m ?? 1) - 1]} ${(d0 ?? 1) + 8}–${lastDay}`, isDay: false };
  }
  if ((y ?? 0) <= (y0 ?? 0) + 1) {
    const month = FULL_MONTHS[(m ?? 1) - 1];
    return { label: y === y0 ? `${month}` : `${month} ${y}`, isDay: false };
  }
  return { label: `${y}`, isDay: false };
}

/**
 * Upcoming rows under GUI-style date headers (empty periods are simply
 * absent), with the trailing Repeating To-Dos section: templates with no
 * set next occurrence, carrying their waiting/paused/ended status word and
 * the bare ⚑ when the rule will assign a deadline per occurrence.
 */
export function renderUpcoming(items: ListItem[], now?: Date): string[] {
  if (items.length === 0) return ["(empty)"];
  const todayIso = localToday(now);
  const w = uuidDisplayWidth(items);
  const fmtOpts = now === undefined ? {} : { now };
  const dated = items.filter((i) => i.startDate !== null);
  const resting = items.filter((i) => i.startDate === null && i.repeating.isTemplate);
  const lines: string[] = [];
  let openHeader: string | null = null;
  for (const item of dated) {
    const bucket = upcomingBucket(item.startDate ?? "", todayIso);
    if (bucket.label !== openHeader) {
      if (lines.length > 0) lines.push("");
      lines.push(bold(`── ${bucket.label} ──`));
      openHeader = bucket.label;
    }
    lines.push(formatItem(item, w, { ...fmtOpts, hideDateChip: bucket.isDay }));
  }
  if (resting.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(bold("── Repeating To-Dos ──"));
    for (const item of resting) {
      lines.push(
        formatItem(item, w, { ...fmtOpts, statusWord: templateStatus(item.repeating, todayIso) }),
      );
    }
  }
  return lines;
}

/**
 * Logbook rows under GUI-style date headings, month granularity throughout
 * — `── July ──` within the current year, `── March 2025 ──` beyond (finer
 * than the GUI's bare per-year buckets, deliberately). Truncation past the
 * row limit is reported by the shared hint the command appends, not here.
 */
export function renderLogbook(items: ListItem[], now?: Date): string[] {
  if (items.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(items);
  const currentYear = localToday(now).slice(0, 4);
  const lines: string[] = [];
  let openHeading: string | null = null;
  for (const item of items) {
    const s = item.stopped;
    const heading =
      s === null
        ? "no logged date"
        : `${FULL_MONTHS[s.getMonth()]}${String(s.getFullYear()) === currentYear ? "" : ` ${s.getFullYear()}`}`;
    if (heading !== openHeading) {
      if (lines.length > 0) lines.push("");
      lines.push(bold(`── ${heading} ──`));
      openHeading = heading;
    }
    lines.push(formatItem(item, w, now === undefined ? {} : { now }));
  }
  return lines;
}

/**
 * Sidebar-grouped views (anytime/someday), rendered the way the GUI reads:
 * the area-less block headerless first, then one `── <area> ──` header per
 * area; inside a section, loose to-dos first, then each project GROUP — a
 * blank line, the project's bold+underlined title row, then its members.
 * Container names implied by the grouping are not repeated on member rows
 * (an area header covers its rows; a project title row covers the to-dos
 * beneath it — a clustered child whose project row is absent, e.g. under a
 * tag filter, keeps its `(project)` suffix). `star` prefixes each item line
 * with the Today-membership mark (★, or ⏾ for This-Evening members).
 */
export function renderSections(sections: SidebarSection[], star = false): string[] {
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(all);
  const lines: string[] = [];
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  for (const section of sections) {
    if (section.area !== null) {
      blank();
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
    }
    // The uuid of the project whose title row is directly above (its member
    // rows drop their redundant `(project)` suffix).
    let openProject: string | null = null;
    for (const item of section.items) {
      const mark = star ? todayMark(item) : null;
      if (item.type === "project") {
        openProject = item.uuid;
        blank();
        lines.push(
          formatItem(item, w, {
            projectTitle: true,
            suppressArea: section.area?.uuid ?? null,
            mark,
          }),
        );
      } else {
        lines.push(
          formatItem(item, w, {
            suppressProject: openProject,
            suppressArea: section.area?.uuid ?? null,
            mark,
          }),
        );
      }
    }
  }
  return lines;
}

/** Single-quote a title for a copy-pasteable drill-down command. */
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "'\\''")}'`;
}

const takeUpTo = <T>(items: T[], limit: number | null): T[] =>
  limit === null ? items : items.slice(0, limit);

/** Muted per-block truncation line: `… N more — \`drill-down\``. */
function blockMoreLine(total: number, shown: number, drill: string | null): string {
  return dim(`  … ${total - shown} more${drill === null ? "" : ` — \`${drill}\``}`);
}

/**
 * Type-aware variant for blocks that mix project rows and to-dos (someday's
 * loose/area blocks): the hidden remainder is split by type — `… 5 more
 * projects, 14 more to-dos` — omitting a type with nothing hidden and
 * pluralizing per count.
 */
function mixedMoreLine(hidden: ListItem[], drill: string | null): string {
  const projects = hidden.filter((i) => i.type === "project").length;
  const todos = hidden.length - projects;
  const parts = [
    ...(projects > 0 ? [`${projects} more project${projects === 1 ? "" : "s"}`] : []),
    ...(todos > 0 ? [`${todos} more to-do${todos === 1 ? "" : "s"}`] : []),
  ];
  return dim(`  … ${parts.join(", ")}${drill === null ? "" : ` — \`${drill}\``}`);
}

/**
 * Muted bottom line for a truncated grouped view: `── more per group — see
 * more: \`<base> <bigger flags>\` · all: \`<base> --all\` ──`, where the
 * bigger-flags command doubles exactly the caps that actually truncated.
 */
function groupedBottomLine(base: string, escalations: string[], allBase = base): string {
  const seeMore = escalations.length > 0 ? `see more: \`${base} ${escalations.join(" ")}\` · ` : "";
  return dim(`── more per group — ${seeMore}all: \`${allBase} --all\` ──`);
}

/**
 * The anytime preview: the FULL block skeleton — every area header and every
 * project row — always renders; `limits.area` caps the loose block and each
 * area's direct to-dos, `limits.project` each project's to-dos. A truncated
 * block trails a muted `… N more — \`things (project|area) show '…'\``
 * drill-down (the loose block has no container, so it shows only the count),
 * and the view ends with one line escalating the caps that hit. Today members
 * are starred. Mirrors renderSections' layout exactly.
 */
function renderAnytimePreview(
  sections: SidebarSection[],
  limits: GroupedLimits,
  base: string,
): string[] {
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(all);
  const lines: string[] = [];
  let areaHit = false;
  let projectHit = false;
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  for (const section of sections) {
    if (section.area !== null) {
      blank();
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
    }
    const { direct, projects } = splitSectionBlocks(section);
    const suppressArea = section.area?.uuid ?? null;
    const shownDirect = takeUpTo(direct, limits.area);
    for (const item of shownDirect) {
      lines.push(formatItem(item, w, { suppressArea, mark: todayMark(item) }));
    }
    if (direct.length > shownDirect.length) {
      areaHit = true;
      const drill =
        section.area === null ? null : `things area show ${quoteTitle(section.area.title)}`;
      lines.push(blockMoreLine(direct.length, shownDirect.length, drill));
    }
    for (const { project, items: children } of projects) {
      blank();
      lines.push(
        formatItem(project, w, { projectTitle: true, suppressArea, mark: todayMark(project) }),
      );
      const shownChildren = takeUpTo(children, limits.project);
      for (const item of shownChildren) {
        lines.push(
          formatItem(item, w, {
            suppressProject: project.uuid,
            suppressArea,
            mark: todayMark(item),
          }),
        );
      }
      if (children.length > shownChildren.length) {
        projectHit = true;
        lines.push(
          blockMoreLine(
            children.length,
            shownChildren.length,
            `things project show ${quoteTitle(project.title)}`,
          ),
        );
      }
    }
  }
  if (areaHit || projectHit) {
    const escalations = [
      ...(areaHit && limits.area !== null ? [`--area-limit ${limits.area * 2}`] : []),
      ...(projectHit && limits.project !== null ? [`--project-limit ${limits.project * 2}`] : []),
    ];
    lines.push("", groupedBottomLine(base, escalations));
  }
  return lines;
}

/**
 * The someday preview, mirroring the GUI (side-by-side, 2026-07-12): inside
 * each group the project rows render as PLAIN items — `(~)` circle, count
 * chip, no header styling, no surrounding blank lines — listed before the
 * direct to-dos; `limits.area` caps each group's combined list. With
 * `showActive` (the --show-active-project-items toggle) the someday to-dos
 * living inside active projects append as a separate trailing
 * `── From active projects ──` section — a flat run of project-header blocks
 * (no area grouping), each capped at `limits.project` (null = every item).
 * When the toggle is off and such items exist, a muted bottom hint counts
 * them and names the flag.
 */
function renderSomedayPreview(
  sections: SidebarSection[],
  limits: GroupedLimits,
  base: string,
  showActive: boolean,
  hiddenActiveItems: number,
): string[] {
  const all = sections.flatMap((s) => s.items);
  const lines: string[] = [];
  let areaHit = false;
  let projectHit = false;
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  if (all.length === 0) {
    lines.push("(empty)");
  } else {
    const w = uuidDisplayWidth(all);
    const trailing: Array<{ project: { uuid: string; title: string }; items: ListItem[] }> = [];
    for (const section of sections) {
      const { own, children } = partitionSomedaySection(section);
      trailing.push(...children);
      if (section.area !== null) {
        blank();
        lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
      }
      const suppressArea = section.area?.uuid ?? null;
      const shownOwn = takeUpTo(own, limits.area);
      for (const item of shownOwn) lines.push(formatItem(item, w, { suppressArea }));
      if (own.length > shownOwn.length) {
        areaHit = true;
        const drill =
          section.area === null ? null : `things area show ${quoteTitle(section.area.title)}`;
        lines.push(mixedMoreLine(own.slice(shownOwn.length), drill));
      }
    }
    if (trailing.length > 0) {
      blank();
      lines.push(bold("── From active projects ──"));
      for (const group of trailing) {
        blank();
        lines.push(
          `${dim(uuidCol(group.project.uuid, w))}  ${bold(underline(group.project.title))}`,
        );
        const shown = takeUpTo(group.items, limits.project);
        for (const item of shown) {
          lines.push(formatItem(item, w, { suppressProject: group.project.uuid }));
        }
        if (group.items.length > shown.length) {
          projectHit = true;
          lines.push(
            blockMoreLine(
              group.items.length,
              shown.length,
              `things project show ${quoteTitle(group.project.title)}`,
            ),
          );
        }
      }
    }
  }
  if (areaHit || projectHit) {
    const escalations = [
      ...(areaHit && limits.area !== null ? [`--area-limit ${limits.area * 2}`] : []),
      ...(projectHit && limits.project !== null
        ? [`--show-active-project-items ${limits.project * 2}`]
        : []),
    ];
    // The bare flag keeps the active-projects section visible under --all.
    const allBase = showActive ? `${base} --show-active-project-items` : base;
    lines.push("", groupedBottomLine(base, escalations, allBase));
  }
  if (!showActive && hiddenActiveItems > 0) {
    blank();
    lines.push(
      dim(
        `(${hiddenActiveItems} someday to-do${hiddenActiveItems === 1 ? "" : "s"} inside active projects — visible with \`things someday --show-active-project-items\`)`,
      ),
    );
  }
  return lines;
}

export function registerReadCommands(program: Command): void {
  program
    .command("legend")
    .description(
      "The symbols and colors the list views use, grouped and explained: to-do boxes and " +
        "project circles, markers and chips, colors and styles, section dividers and hints. " +
        "Human-readable by default; --json emits {glyph, meaning, group} rows.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { json?: boolean }) => {
      const started = Date.now();
      if (opts.json) {
        const entries = LEGEND.map((e) => ({
          glyph: stripAnsi(e.glyph),
          meaning: e.meaning,
          group: e.group,
        }));
        const meta: EnvelopeMeta = {
          dbVersion: null,
          fingerprint: "unknown",
          elapsedMs: Date.now() - started,
        };
        process.stdout.write(`${JSON.stringify(okEnvelope("legend", entries, meta))}\n`);
      } else {
        process.stdout.write(`${renderLegend().join("\n")}\n`);
      }
      process.exitCode = ExitCode.Ok;
    });

  const listCommands: Array<{
    name: string;
    description: string;
    fetch: (client: ThingsClient, tag?: string, exactTag?: boolean) => unknown;
    render?: (data: never) => string[];
    /** Truncate to the row limit + compute pagination (default: flat list). */
    paginate?: (data: never, limit: number | null) => { data: unknown; pagination: Pagination };
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
      }) => {
        // GUI parity: every Today row carries the star, every This-Evening
        // row the crescent, right after the box (one shared uuid column).
        const w = uuidDisplayWidth([...data.today, ...data.evening]);
        return [
          `── Today (badge: ${data.badge.dueOrOverdue} due/overdue · ${data.badge.other} other) ──`,
          ...(data.today.length === 0
            ? ["(empty)"]
            : data.today.map((i) => formatItem(i, w, { mark: todayStar() }))),
          "── This Evening ──",
          ...(data.evening.length === 0
            ? ["(empty)"]
            : data.evening.map((i) => formatItem(i, w, { mark: eveningMoon() }))),
        ];
      },
      paginate: paginateToday as (
        data: never,
        limit: number | null,
      ) => { data: unknown; pagination: Pagination },
    },
    {
      name: "inbox",
      description: "Unprocessed captures (Inbox)",
      fetch: (c, tag, exactTag) =>
        c.read.inbox(
          tag === undefined ? undefined : { tag, ...(exactTag === true && { exactTag }) },
        ),
    },
  ];

  for (const cmd of listCommands) {
    program
      .command(cmd.name)
      .description(cmd.description)
      .option(
        "--tag <ref>",
        "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
      )
      .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
      .option("--limit <n>", LIMIT_DESC)
      .option("--all", ALL_DESC)
      .option("--json", "emit versioned JSON envelope on stdout")
      .option("--db <path>", "explicit database path")
      .action(
        (
          opts: GlobalReadOpts & {
            tag?: string;
            exactTag?: boolean;
            limit?: string;
            all?: boolean;
          },
        ) => {
          const lim = parseLimit(opts);
          if (!lim.ok) return;
          const base = invocation(cmd.name, [
            opts.tag !== undefined && `--tag ${shellQuote(opts.tag)}`,
            opts.exactTag === true && "--exact-tag",
          ]);
          const paginate = cmd.paginate ?? paginateList;
          runRead(
            opts,
            cmd.name,
            (c) => paginate(cmd.fetch(c, opts.tag, opts.exactTag) as never, lim.limit),
            (cmd.render ?? renderList) as (d: unknown) => string[],
            base,
            cmd.name,
          );
        },
      );
  }

  program
    .command("anytime")
    .description(
      "All active items in the UI's sidebar-mirroring order (area-less first, then per " +
        "area: direct to-dos, then each project with its members). Today members are " +
        "starred (★). Children of someday/future-scheduled projects are excluded — the " +
        "project row represents them. Every group and project row is always shown; " +
        "--area-limit caps each area's direct list, --project-limit each project's list, " +
        "--all shows everything",
    )
    .option(
      "--tag <ref>",
      "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
    )
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--area-limit <n>", AREA_LIMIT_DESC)
    .option("--project-limit <n>", PROJECT_LIMIT_DESC)
    .option("--all", GROUPED_ALL_DESC)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          tag?: string;
          exactTag?: boolean;
          areaLimit?: string;
          projectLimit?: string;
          all?: boolean;
          limit?: string;
        },
      ) => {
        if (opts.limit !== undefined) {
          process.stderr.write(
            "error: --limit is not available on anytime — cap blocks with --area-limit / --project-limit, or pass --all\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
        const area = parseCap(
          "--area-limit",
          opts.areaLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
        );
        if (!area.ok) return;
        const project = parseCap(
          "--project-limit",
          opts.projectLimit,
          PROJECT_PREVIEW_LIMIT,
          opts.all === true,
        );
        if (!project.ok) return;
        const limits: GroupedLimits = { area: area.limit, project: project.limit };
        const base = invocation("anytime", [
          opts.tag !== undefined && `--tag ${shellQuote(opts.tag)}`,
          opts.exactTag === true && "--exact-tag",
        ]);
        runRead(
          opts,
          "anytime",
          (c) => {
            const full = c.read.anytime(
              opts.tag === undefined
                ? undefined
                : { tag: opts.tag, ...(opts.exactTag === true && { exactTag: true }) },
            );
            const { data, grouped } = previewSections(full, limits);
            return { data, grouped, lines: renderAnytimePreview(full, limits, base) };
          },
          renderList as (d: unknown) => string[],
          undefined,
          "anytime",
        );
      },
    );

  program
    .command("someday")
    .description(
      "Someday items (incubated, undated) in sidebar order — inside each group the " +
        "someday projects list first, then the to-dos; project children are represented " +
        "by their project row. --show-active-project-items [n] appends a trailing section " +
        "of someday to-dos inside active projects, grouped under their project (the UI's " +
        "'Show items from active projects' toggle; n caps each project's list). " +
        "--area-limit caps each group, --all shows everything",
    )
    .option(
      "--tag <ref>",
      "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
    )
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--area-limit <n>", AREA_LIMIT_DESC)
    .option(
      "--show-active-project-items [n]",
      "append someday to-dos inside active projects, grouped under their project; " +
        "n caps each project's list (bare flag: every item)",
    )
    .option("--all", GROUPED_ALL_DESC)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          tag?: string;
          exactTag?: boolean;
          areaLimit?: string;
          showActiveProjectItems?: boolean | string;
          all?: boolean;
          limit?: string;
        },
      ) => {
        if (opts.limit !== undefined) {
          process.stderr.write(
            "error: --limit is not available on someday — cap groups with --area-limit, or pass --all\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
        const showActive = opts.showActiveProjectItems !== undefined;
        let projectCap: number | null = null;
        if (typeof opts.showActiveProjectItems === "string") {
          const capped = parseCap(
            "--show-active-project-items",
            opts.showActiveProjectItems,
            0,
            opts.all === true,
          );
          if (!capped.ok) return;
          projectCap = capped.limit;
        }
        const area = parseCap(
          "--area-limit",
          opts.areaLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
        );
        if (!area.ok) return;
        const limits: GroupedLimits = { area: area.limit, project: projectCap };
        const filter = {
          ...(opts.tag !== undefined && { tag: opts.tag }),
          ...(opts.exactTag === true && { exactTag: true }),
        };
        const base = invocation("someday", [
          opts.tag !== undefined && `--tag ${shellQuote(opts.tag)}`,
          opts.exactTag === true && "--exact-tag",
        ]);
        runRead(
          opts,
          "someday",
          (c) => {
            const full = c.read.someday({
              ...filter,
              ...(showActive && { activeProjectItems: true }),
            });
            // Hidden-items-never-silent: when the toggle is off, one extra
            // query counts what it would reveal so the hint can say so.
            const hiddenActiveItems = showActive
              ? 0
              : c.read
                  .someday({ ...filter, activeProjectItems: true })
                  .reduce(
                    (n, s) =>
                      n +
                      partitionSomedaySection(s).children.reduce((m, g) => m + g.items.length, 0),
                    0,
                  );
            const { data, grouped } = previewSomedaySections(full, limits);
            return {
              data,
              grouped,
              lines: renderSomedayPreview(full, limits, base, showActive, hiddenActiveItems),
            };
          },
          renderList as (d: unknown) => string[],
          undefined,
          "someday",
        );
      },
    );

  program
    .command("upcoming")
    .description(
      "Future-scheduled items in date order, INCLUDING each repeating item's next " +
        "occurrence (↻ marker; deadline derived from the repeat rule). Shows the next " +
        "month by default — widen with --until (relative `2w`/`3m`/`1y` or absolute " +
        "`2026-09`/`2026`) or --all for the full horizon. --horizon <n> also " +
        "PROJECTS the following n-1 occurrences per repeating item from its decoded rule " +
        "(fixed rules only, max 10) — projections are host math the app has not " +
        "materialized yet.",
    )
    .option(
      "--until <period>",
      `only items scheduled through this bound: ${PERIOD_UNTIL} (whole periods)`,
      "1m",
    )
    .option("--since <period>", `skip items scheduled before this bound: ${PERIOD_SINCE}`)
    .option("--all", "no date bound and no row limit — the app's full Upcoming")
    .option("--limit <n>", LIMIT_DESC)
    .option(
      "--tag <ref>",
      "filter by tag (uuid or unique name): direct, inherited, or descendant-tagged",
    )
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--horizon <n>", "occurrences per repeating item (default 1 = UI parity)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          until: string;
          since?: string;
          all?: boolean;
          limit?: string;
          tag?: string;
          exactTag?: boolean;
          horizon?: string;
        },
        command: Command,
      ) => {
        const untilGiven = command.getOptionValueSource("until") !== "default";
        const sinceGiven = opts.since !== undefined;
        if (opts.all === true && (untilGiven || sinceGiven)) {
          process.stderr.write("error: --all does not combine with --until/--since\n");
          process.exitCode = ExitCode.Usage;
          return;
        }
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        const untilDate = opts.all === true ? undefined : parsePeriodEnd(opts.until);
        if (untilDate !== undefined && Number.isNaN(untilDate.getTime())) {
          process.stderr.write(`error: --until is not a parseable period: ${opts.until}\n`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        const sinceDate = sinceGiven ? parsePeriodStart(opts.since as string) : undefined;
        if (sinceDate !== undefined && Number.isNaN(sinceDate.getTime())) {
          process.stderr.write(`error: --since is not a parseable period: ${opts.since}\n`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        const until = untilDate === undefined ? undefined : localToday(untilDate);
        const since = sinceDate === undefined ? undefined : localToday(sinceDate);
        const base = invocation("upcoming", [
          untilGiven && `--until ${shellQuote(opts.until)}`,
          sinceGiven && `--since ${shellQuote(opts.since as string)}`,
          opts.tag !== undefined && `--tag ${shellQuote(opts.tag)}`,
          opts.exactTag === true && "--exact-tag",
          opts.horizon !== undefined && `--horizon ${shellQuote(opts.horizon)}`,
        ]);
        runRead(
          opts,
          "upcoming",
          (c) =>
            paginateList(
              c.read.upcoming({
                ...(until !== undefined && { until }),
                ...(since !== undefined && { since }),
                ...(opts.tag !== undefined && { tag: opts.tag }),
                ...(opts.exactTag === true && { exactTag: true }),
                ...(opts.horizon !== undefined && { horizon: Number(opts.horizon) }),
              }),
              lim.limit,
            ),
          ((items: ListItem[]) => {
            const lines = renderUpcoming(items);
            if (until !== undefined) {
              lines.push(
                "",
                dim(`(through ${shortDate(until, localToday())} — --all for the full horizon)`),
              );
            }
            return lines;
          }) as (d: unknown) => string[],
          base,
          "upcoming",
        );
      },
    );

  program
    .command("logbook")
    .description(
      "Completed and canceled items, most recent first, grouped under month headings " +
        "(year appended beyond the current year). Scope with --area (direct items + its " +
        "projects' children, heading-nested included) / --project (all children, " +
        "heading-nested included) / --tag; bound the logged date with --since/--until.",
    )
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--area <ref>", "restrict to an area: direct items plus its projects' children")
    .option("--project <ref>", "restrict to one project's children (uuid or unique name)")
    .option("--since <when>", `only entries logged on/after this bound: ${PERIOD_SINCE}`)
    .option("--until <when>", `only entries logged on/before this bound: ${PERIOD_UNTIL}`)
    .option("--tag <ref>", "filter by tag (uuid or unique name), direct OR inherited")
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          limit?: string;
          all?: boolean;
          area?: string;
          project?: string;
          since?: string;
          until?: string;
          tag?: string;
          exactTag?: boolean;
        },
      ) => {
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        const since = opts.since !== undefined ? parsePeriodStart(opts.since) : undefined;
        const until = opts.until !== undefined ? parsePeriodEnd(opts.until) : undefined;
        for (const [flag, value] of [
          ["--since", since],
          ["--until", until],
        ] as const) {
          if (value !== undefined && Number.isNaN(value.getTime())) {
            process.stderr.write(`error: ${flag} is not a parseable date\n`);
            process.exitCode = ExitCode.Usage;
            return;
          }
        }
        const base = invocation("logbook", [
          opts.area !== undefined && `--area ${shellQuote(opts.area)}`,
          opts.project !== undefined && `--project ${shellQuote(opts.project)}`,
          opts.since !== undefined && `--since ${shellQuote(opts.since)}`,
          opts.until !== undefined && `--until ${shellQuote(opts.until)}`,
          opts.tag !== undefined && `--tag ${shellQuote(opts.tag)}`,
          opts.exactTag === true && "--exact-tag",
        ]);
        runRead(
          opts,
          "logbook",
          (c) =>
            paginateList(
              c.read.logbook({
                limit: null,
                ...(opts.area !== undefined && { area: opts.area }),
                ...(opts.project !== undefined && { project: opts.project }),
                ...(since !== undefined && { since }),
                ...(until !== undefined && { until }),
                ...(opts.tag !== undefined && { tag: opts.tag }),
                ...(opts.exactTag === true && { exactTag: true }),
              }),
              lim.limit,
            ),
          ((items: ListItem[]) => renderLogbook(items)) as (d: unknown) => string[],
          base,
          "logbook",
        );
      },
    );

  program
    .command("trash")
    .description("Trashed items (trashed=1 flag, any status), most recently modified first")
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { limit?: string; all?: boolean }) => {
      const lim = parseLimit(opts);
      if (!lim.ok) return;
      runRead(
        opts,
        "trash",
        (c) => paginateList(c.read.trash({ limit: null }), lim.limit),
        renderList as (d: unknown) => string[],
        invocation("trash", []),
        "trash",
      );
    });

  program
    .command("projects")
    .description(
      "Active projects in sidebar order: loose projects first, then grouped under " +
        "their area (optionally scoped to --area <ref>). Someday and future-scheduled " +
        "projects are hidden — --show-later appends them after each group's active " +
        "block (state carried by the (~) mark and ‹date› chip)",
    )
    .option("--area <ref>", "filter by area (uuid or unique name)")
    .option("--show-later", "include someday/future-scheduled projects after each active block")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { area?: string; showLater?: boolean }) => {
      let hints: LaterHints | undefined;
      withClient(
        opts,
        "projects",
        (c) => {
          const scope = opts.area !== undefined ? { areaUuid: opts.area } : {};
          const visible = c.read.projects({
            ...scope,
            ...(opts.showLater === true && { later: true }),
          });
          if (opts.area === undefined) {
            // Sidebar scaffold: every VISIBLE area renders (project-less
            // ones say so), in sidebar order; the loose block leads. One
            // extra projects query buys the hidden-later counts.
            const full = opts.showLater === true ? visible : c.read.projects({ later: true });
            const shown = new Set(visible.map((i) => i.uuid));
            const groups: LaterHints["groups"] = [
              { area: null, hidden: 0 },
              ...c.read
                .areas()
                .filter((a) => a.visible)
                .map((a) => ({ area: { uuid: a.uuid, title: a.title }, hidden: 0 })),
            ];
            const at = new Map<string | null, number>(
              groups.map((g, i) => [g.area?.uuid ?? null, i]),
            );
            for (const item of full) {
              if (shown.has(item.uuid)) continue;
              const g = groups[at.get(item.area?.uuid ?? null) ?? 0];
              if (g !== undefined) g.hidden += 1;
            }
            hints = { groups };
          } else if (opts.showLater !== true) {
            // --area scoped: only the bottom hint needs a count.
            const full = c.read.projects({ ...scope, later: true });
            hints = { groups: [{ area: null, hidden: full.length - visible.length }] };
          }
          return visible;
        },
        // Scoped to one area the list is flat (the scope names the group);
        // unscoped it mirrors the sidebar with ⬡ area headers.
        ((items: ListItem[]) => {
          if (opts.area === undefined) return renderProjectsSidebar(items, hints);
          const lines = renderList(items);
          const hidden = hints?.groups.reduce((n, g) => n + g.hidden, 0) ?? 0;
          if (hidden > 0)
            lines.push(
              "",
              dim(
                `(${hidden} later project${hidden === 1 ? "" : "s"} — visible with \`--show-later\`)`,
              ),
            );
          return lines;
        }) as (d: never) => string[],
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
      ) => {
        const w = uuidDisplayWidth(data);
        return data.map(
          (a) =>
            `${dim(uuidCol(a.uuid, w))}  ${areaMark()} ${a.title}${a.tags.length ? ` ${dim(`#${a.tags.map((t) => t.title).join(" #")}`)}` : ""}`,
        );
      }) as (d: never) => string[]);
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
    .requiredOption(
      "--since <when>",
      `ISO date/datetime (e.g. 2026-07-05T14:30:00), or ${PERIOD_SINCE}`,
    )
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { since: string; limit?: string; all?: boolean }) => {
      const lim = parseLimit(opts);
      if (!lim.ok) return;
      const since = parsePeriodStart(opts.since);
      if (Number.isNaN(since.getTime())) {
        process.stderr.write(`error: --since is not a parseable date: ${opts.since}\n`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      const base = invocation("changes", [`--since ${shellQuote(opts.since)}`]);
      runRead(
        opts,
        "changes",
        (c) => paginateList(c.read.changes({ since, limit: null }), lim.limit),
        ((items: Array<ListItem & { changeKind: string }>) =>
          items.length === 0
            ? ["(no changes)"]
            : items.map(
                (i) =>
                  `${i.changeKind === "created" ? "+" : "~"} ${formatItem(i)}${i.trashed ? " [trashed]" : ""}`,
              )) as (d: unknown) => string[],
        base,
      );
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
    .option(
      "--all",
      "everything, unbounded: open + logged + trashed, with no row limit (excludes --limit)",
    )
    .option("--limit <n>", LIMIT_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((query: string, opts: GlobalReadOpts & Record<string, unknown>) => {
      const type = opts["type"] as string | undefined;
      if (type !== undefined && type !== "todo" && type !== "project") {
        process.stderr.write("error: --type must be todo or project\n");
        process.exitCode = ExitCode.Usage;
        return;
      }
      const all = opts["all"] === true;
      const limitOpt = opts["limit"] as string | undefined;
      // --all widens the scope AND lifts the row limit — combining it with an
      // explicit --limit is contradictory (like every other view).
      const lim = parseLimit({ all, ...(limitOpt !== undefined && { limit: limitOpt }) });
      if (!lim.ok) return;
      const base = invocation("search", [
        shellQuote(query),
        opts["project"] !== undefined && `--project ${shellQuote(opts["project"] as string)}`,
        opts["area"] !== undefined && `--area ${shellQuote(opts["area"] as string)}`,
        opts["tag"] !== undefined && `--tag ${shellQuote(opts["tag"] as string)}`,
        opts["exactTag"] === true && "--exact-tag",
        type !== undefined && `--type ${type}`,
        opts["logged"] === true && "--logged",
        opts["trashed"] === true && "--trashed",
      ]);
      runRead(
        opts,
        "search",
        (c) =>
          paginateList(
            c.read.search(query, {
              limit: null,
              ...(opts["project"] !== undefined && { project: opts["project"] as string }),
              ...(opts["area"] !== undefined && { area: opts["area"] as string }),
              ...(opts["tag"] !== undefined && { tag: opts["tag"] as string }),
              ...(opts["exactTag"] === true && { exactTag: true }),
              ...(type !== undefined && { type: type === "todo" ? "to-do" : "project" }),
              ...(opts["logged"] === true && { logged: true }),
              ...(opts["trashed"] === true && { trashed: true }),
              ...(all && { all: true }),
            }),
            lim.limit,
          ),
        renderList as (d: unknown) => string[],
        base,
      );
    });

  // Every row-rendering view points at `things legend` for its glyph language.
  const GLYPH_VIEWS = new Set([
    "today",
    "inbox",
    "anytime",
    "someday",
    "upcoming",
    "logbook",
    "trash",
    "projects",
    "areas",
    "changes",
    "search",
  ]);
  for (const c of program.commands) {
    if (GLYPH_VIEWS.has(c.name())) {
      c.addHelpText("after", "\nsymbols & colors: run `things legend`");
    }
  }
}
