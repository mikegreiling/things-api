/**
 * Read-only list commands. Each renders a compact human table (UUIDs always
 * shown — agents and humans both need stable references) or a --json envelope.
 */
import type { Command } from "commander";
import { execFileSync } from "node:child_process";

import { openThings, type ThingsClient } from "../../client.ts";
import { ThingsDbNotFoundError } from "../../db/locate.ts";
import { ThingsDbOpenError } from "../../db/connection.ts";
import { isTodayMember, type ListItem, type SidebarSection } from "../../read/views.ts";
import { localToday } from "../../model/dates.ts";
import { templateStatus } from "../../model/recurrence.ts";
import { blue, bold, dim, strike, underline } from "../style.ts";
import {
  areaMark,
  CHECKLIST_MARK,
  countChip,
  dateChip,
  deadlineToken,
  eveningMoon,
  loggedDate,
  NOTES_MARK,
  projectCircle,
  REMINDER_MARK,
  shortDate,
  todayStar,
  todoBox,
} from "../glyphs.ts";

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
  const shownUuid =
    uuidWidth > 0 && item.uuid.length > uuidWidth
      ? item.uuid.slice(0, uuidWidth)
      : item.uuid.padEnd(uuidWidth);
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
 * than the GUI's bare per-year buckets, deliberately). When the row count
 * hits the limit, a trailing note says the range is NOT exhaustive.
 */
export function renderLogbook(items: ListItem[], limit: number, now?: Date): string[] {
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
  if (items.length >= limit)
    lines.push(
      "",
      dim(`(${items.length} shown — --limit reached; raise --limit or narrow --since/--until)`),
    );
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
        "occurrence (↻ marker; deadline derived from the repeat rule). Shows the next " +
        "month by default — widen with --until (relative `2w`/`3m`/`1y` or absolute " +
        "`2026-09`/`2026`) or --all for the full horizon. --horizon <n> also " +
        "PROJECTS the following n-1 occurrences per repeating item from its decoded rule " +
        "(fixed rules only, max 10) — projections are host math the app has not " +
        "materialized yet.",
    )
    .option(
      "--until <period>",
      "only items scheduled through this bound: `2w`/`3m`/`1y` from today, or `2026-09`, " +
        "`2026-09-15`, `2026` (whole periods)",
      "1m",
    )
    .option("--all", "no date bound — every future-scheduled item (the app's full Upcoming)")
    .option("--limit <n>", "maximum rows (applied after the date bound)")
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
          all?: boolean;
          limit?: string;
          tag?: string;
          exactTag?: boolean;
          horizon?: string;
        },
        command: Command,
      ) => {
        const untilGiven = command.getOptionValueSource("until") !== "default";
        if (opts.all === true && untilGiven) {
          process.stderr.write("error: --all and --until are mutually exclusive\n");
          process.exitCode = ExitCode.Usage;
          return;
        }
        const untilDate = opts.all === true ? undefined : parsePeriodEnd(opts.until);
        if (untilDate !== undefined && Number.isNaN(untilDate.getTime())) {
          process.stderr.write(`error: --until is not a parseable period: ${opts.until}\n`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        const until = untilDate === undefined ? undefined : localToday(untilDate);
        const limit = opts.limit === undefined ? undefined : Number(opts.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          process.stderr.write(`error: --limit must be a positive integer\n`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        let clipped = false;
        withClient(
          opts,
          "upcoming",
          (c) => {
            const items = c.read.upcoming({
              ...(until !== undefined && { until }),
              ...(opts.tag !== undefined && { tag: opts.tag }),
              ...(opts.exactTag === true && { exactTag: true }),
              ...(opts.horizon !== undefined && { horizon: Number(opts.horizon) }),
            });
            if (limit !== undefined && items.length > limit) {
              clipped = true;
              return items.slice(0, limit);
            }
            return items;
          },
          ((items: ListItem[]) => {
            const lines = renderUpcoming(items);
            if (clipped && limit !== undefined) {
              lines.push(
                "",
                dim(`(${limit} shown — --limit reached; raise --limit or widen --until)`),
              );
            }
            if (until !== undefined) {
              lines.push(
                "",
                dim(`(through ${shortDate(until, localToday())} — --all for the full horizon)`),
              );
            }
            return lines;
          }) as (d: never) => string[],
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
    .option("--limit <n>", "maximum items to return", "100")
    .option("--area <ref>", "restrict to an area: direct items plus its projects' children")
    .option("--project <ref>", "restrict to one project's children (uuid or unique name)")
    .option(
      "--since <when>",
      "only entries logged on/after this bound: `2w`/`3m`/`1y` back from today, or " +
        "`2024`, `2024-03`, `2024-03-05` (whole periods)",
    )
    .option(
      "--until <when>",
      "only entries logged on/before this date (2024 or 2024-03 cover the whole period)",
    )
    .option("--tag <ref>", "filter by tag (uuid or unique name), direct OR inherited")
    .option("--exact-tag", "match the named tag only — exclude hierarchy descendants")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          limit: string;
          area?: string;
          project?: string;
          since?: string;
          until?: string;
          tag?: string;
          exactTag?: boolean;
        },
      ) => {
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
        const limit = Number(opts.limit);
        withClient(
          opts,
          "logbook",
          (c) =>
            c.read.logbook({
              limit,
              ...(opts.area !== undefined && { area: opts.area }),
              ...(opts.project !== undefined && { project: opts.project }),
              ...(since !== undefined && { since }),
              ...(until !== undefined && { until }),
              ...(opts.tag !== undefined && { tag: opts.tag }),
              ...(opts.exactTag === true && { exactTag: true }),
            }),
          ((items: ListItem[]) => renderLogbook(items, limit)) as (d: never) => string[],
        );
      },
    );

  program
    .command("trash")
    .description("Trashed items (trashed=1 flag, any status), most recently modified first")
    .option("--limit <n>", "maximum items to return", "200")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts & { limit: string }) => {
      const limit = Number(opts.limit);
      let clipped = false;
      withClient(
        opts,
        "trash",
        (c) => {
          // Fetch one past the limit so truncation is loud, never silent.
          const items = c.read.trash({ limit: limit + 1 });
          if (items.length > limit) {
            clipped = true;
            return items.slice(0, limit);
          }
          return items;
        },
        ((items: ListItem[]) => {
          const lines = renderList(items);
          if (clipped) lines.push("", dim(`(${limit} shown — --limit reached; raise --limit)`));
          return lines;
        }) as (d: never) => string[],
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
            `${dim(a.uuid.length > w ? a.uuid.slice(0, w) : a.uuid.padEnd(w))}  ${areaMark()} ${a.title}${a.tags.length ? ` ${dim(`#${a.tags.map((t) => t.title).join(" #")}`)}` : ""}`,
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
