/**
 * `things area show <ref>` — the composite area view (the write subcommands
 * under `things area` are registered by writes.ts on the same group).
 */
import type { Command } from "commander";

import type { Project, Todo } from "../../model/entities.ts";
import type { AreaView } from "../../read/area-view.ts";
import { localToday } from "../../model/dates.ts";
import { bold, dim, green } from "../style.ts";
import { areaMark, thingsLink } from "../glyphs.ts";
import { capAreaView } from "../../read/pagination.ts";
import {
  formatItem,
  invocation,
  openInThings,
  parseLimit,
  runRead,
  shellQuote,
  truncationHint,
  uuidDisplayWidth,
  withClient,
} from "./reads.ts";
import { showToggleFlags } from "./project.ts";
import { ALL_DESC, LIMIT_DESC } from "../../surface-copy.ts";

export interface AreaShowOpts {
  showLater?: boolean;
  /** Commander optional-value flag: true when bare, the raw string when given a count. */
  showLogged?: boolean | string;
  /** Total item-row cap (null/undefined = uncapped); rows past it are summarized by the footer. */
  limit?: number | null;
  /** The user's invocation, echoed by the truncation footer. */
  hintBase?: string;
}

/** Bare `--show-logged` shows this many recent entries (areas accumulate thousands). */
const RECENT_LOGGED_DEFAULT = 15;

function loggedCount(showLogged: boolean | string | undefined): number {
  if (showLogged === undefined) return 0;
  if (showLogged === true) return RECENT_LOGGED_DEFAULT;
  const n = Number(showLogged);
  return Number.isInteger(n) && n > 0 ? n : RECENT_LOGGED_DEFAULT;
}

/**
 * GUI layout: active projects first (sidebar order), then the area's direct
 * to-dos. `--show-later` reveals the GUI's toggled sections — Upcoming
 * (future-scheduled projects, to-dos, and repeating templates intermixed in
 * date order) and Someday (someday projects as a leading block, then
 * someday to-dos). `--show-logged` reveals the full logbook.
 */
export function renderAreaView(view: AreaView, opts: AreaShowOpts): string[] {
  const todayIso = localToday();
  // Closed-but-unswept projects always sit in the active block (checked),
  // never in Upcoming/Someday — start/startDate only classify OPEN rows.
  const isSomedayProject = (p: Project) =>
    p.status === "open" && p.start === "someday" && p.startDate === null;
  const isScheduledProject = (p: Project) =>
    p.status === "open" && p.startDate !== null && p.startDate > todayIso;
  const activeProjects = view.projects.filter(
    (p) => !isSomedayProject(p) && !isScheduledProject(p),
  );
  const somedayProjects = view.projects.filter(isSomedayProject);
  // Upcoming intermixes scheduled projects, scheduled to-dos, and repeating
  // templates in date order (templates sort by their next occurrence).
  const upcoming: Array<{ date: string; item: Todo | Project }> = [
    ...view.projects.filter(isScheduledProject).map((p) => ({ date: p.startDate ?? "", item: p })),
    ...view.later.scheduled.flatMap((d) => d.items.map((t) => ({ date: d.date, item: t }))),
    ...view.later.repeating.map((t) => ({ date: t.repeating.nextOccurrence ?? "9999", item: t })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const logged = view.logged.slice(0, loggedCount(opts.showLogged));
  const shown: Array<Todo | Project> = [
    ...activeProjects,
    ...view.active,
    ...(opts.showLater === true
      ? [...upcoming.map((u) => u.item), ...somedayProjects, ...view.later.someday]
      : []),
    ...logged,
  ];
  const w = uuidDisplayWidth(shown);
  // Total item-row cap: counts rows in render order (projects, direct to-dos,
  // Upcoming/Someday when toggled, logged) and truncates mid-section; the
  // card preamble is content, never counted, and no section header renders
  // empty past the cut.
  const cap = opts.limit ?? null;
  let budget: number | null = cap;
  const take = <T>(rows: T[]): T[] => {
    if (budget === null) return rows;
    const out = rows.slice(0, Math.max(0, budget));
    budget -= out.length;
    return out;
  };
  const totalRows = shown.length;
  let shownRows = 0;
  const count = <T>(rows: T[]): T[] => {
    shownRows += rows.length;
    return rows;
  };
  // Rows inside this view never repeat the area's own name.
  const fmt = (i: Todo | Project) => formatItem(i, w, { suppressArea: view.area.uuid });
  const fmtProject = (i: Project) =>
    formatItem(i, w, { projectTitle: true, suppressArea: view.area.uuid });

  // Card header: glyph + name, the GUI's share link (carries the uuid — it
  // pastes back into any ref argument), then labeled meta lines. The opened
  // resource shows its tags green (GUI: list pills are gray).
  const lines: string[] = [
    `${bold("Area:")} ${areaMark()} ${bold(view.area.title)}`,
    `  ${dim("uri:")} ${thingsLink(view.area.uuid)}`,
  ];
  if (view.area.tags.length > 0)
    lines.push(`  ${dim("tags:")} ${green(`#${view.area.tags.map((t) => t.title).join(" #")}`)}`);
  const block = (rows: string[]) => {
    if (rows.length > 0) lines.push("", ...rows);
  };
  block(count(take(activeProjects)).map(fmtProject));
  block(count(take(view.active)).map(fmt));
  if (activeProjects.length === 0 && view.active.length === 0) lines.push("", "(no active items)");
  if (opts.showLater === true) {
    const shownUpcoming = count(take(upcoming));
    if (shownUpcoming.length > 0) {
      lines.push("", bold("── Upcoming ──"), ...shownUpcoming.map((u) => fmt(u.item)));
    }
    const shownSomedayProjects = count(take(somedayProjects));
    const shownSomedayTodos = count(take(view.later.someday));
    if (shownSomedayProjects.length > 0 || shownSomedayTodos.length > 0) {
      lines.push("", bold("── Someday ──"), ...shownSomedayProjects.map(fmtProject));
      if (shownSomedayTodos.length > 0) {
        if (shownSomedayProjects.length > 0) lines.push("");
        lines.push(...shownSomedayTodos.map(fmt));
      }
    }
  }
  // Default-hidden rows are never silent — a muted count names the toggle.
  if (opts.showLater !== true) {
    const hiddenLater = upcoming.length + somedayProjects.length + view.later.someday.length;
    if (hiddenLater > 0)
      lines.push(
        "",
        dim(`…${hiddenLater} later item${hiddenLater === 1 ? "" : "s"} (--show-later)`),
      );
  }
  const shownLogged = count(take(logged));
  if (shownLogged.length > 0) {
    // Truncation is loud: areas accumulate years of history — the full
    // archive belongs to `things logbook --area`.
    const header =
      shownLogged.length < view.logged.length
        ? `── Logged (${shownLogged.length} of ${view.logged.length} — see things logbook --area) ──`
        : `── Logged (${view.logged.length}) ──`;
    lines.push("", bold(header), ...shownLogged.map(fmt));
  } else if (view.logged.length > 0 && logged.length === 0) {
    lines.push(
      "",
      dim(`…${view.logged.length} logged (--show-logged; full history: things logbook --area)`),
    );
  }
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
  if (cap !== null && shownRows < totalRows && opts.hintBase !== undefined) {
    const hint = truncationHint(opts.hintBase, {
      shown: shownRows,
      total: totalRows,
      limit: cap,
      truncated: true,
    });
    if (hint !== null) lines.push("", hint);
  }
  return lines;
}

export function registerAreaCommands(program: Command): void {
  const area = program.command("area").description("Area-scoped operations");
  area
    .command("show <ref>")
    .description(
      "Composite area view mirroring the native UI: active projects first, then the " +
        "area's direct to-dos. --show-later adds the Upcoming (date-ordered) and " +
        "Someday sections; --show-logged adds the full logbook. Target by uuid or " +
        "unique name.",
    )
    .option("--show-later", "include Upcoming and Someday sections")
    .option(
      "--show-logged [n]",
      "include the n most recently logged items (bare flag = 15; full history via `things logbook --area`)",
    )
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        ref: string,
        opts: AreaShowOpts & { json?: boolean; db?: string; limit?: string; all?: boolean },
      ) => {
        const lim = parseLimit(opts as { limit?: string; all?: boolean });
        if (!lim.ok) return;
        const hintBase = invocation("area show", [shellQuote(ref), ...showToggleFlags(opts)]);
        runRead<AreaView>(
          opts,
          "area-view",
          (c) => {
            const view = c.read.areaView(ref);
            const { data, pagination } = capAreaView(view, lim.limit);
            return {
              data,
              pagination,
              lines: renderAreaView(view, { ...opts, limit: lim.limit, hintBase }),
            };
          },
          () => [],
        );
      },
    );
  area
    .command("open <ref>")
    .description(
      "Open the area in the Things app — foregrounds the GUI on this Mac (NOT headless). Errors when the reference is not an area.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "open",
        (c) => {
          const t = c.read.showTarget(ref);
          if (t.kind !== "area")
            throw new RangeError(
              `"${ref}" is a ${t.viaHeading === true ? "heading" : t.kind}, not an area (try \`things open\`)`,
            );
          return { uri: openInThings(t.uuid) };
        },
        ((d: { uri: string }) => [`opened ${d.uri}`]) as (d: never) => string[],
      );
    });
}
