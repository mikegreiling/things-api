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
import { formatItem, openInThings, uuidDisplayWidth, withClient } from "./reads.ts";

export interface AreaShowOpts {
  showLater?: boolean;
  /** Commander optional-value flag: true when bare, the raw string when given a count. */
  showLogged?: boolean | string;
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
  block(activeProjects.map(fmtProject));
  block(view.active.map(fmt));
  if (activeProjects.length === 0 && view.active.length === 0) lines.push("", "(no active items)");
  if (opts.showLater === true) {
    if (upcoming.length > 0) {
      lines.push("", bold("── Upcoming ──"), ...upcoming.map((u) => fmt(u.item)));
    }
    if (somedayProjects.length > 0 || view.later.someday.length > 0) {
      lines.push("", bold("── Someday ──"), ...somedayProjects.map(fmtProject));
      if (view.later.someday.length > 0) {
        if (somedayProjects.length > 0) lines.push("");
        lines.push(...view.later.someday.map(fmt));
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
  if (logged.length > 0) {
    // Truncation is loud: areas accumulate years of history — the full
    // archive belongs to `things logbook --area`.
    const header =
      logged.length < view.logged.length
        ? `── Logged (${logged.length} of ${view.logged.length} — see things logbook --area) ──`
        : `── Logged (${view.logged.length}) ──`;
    lines.push("", bold(header), ...logged.map(fmt));
  } else if (view.logged.length > 0) {
    lines.push(
      "",
      dim(`…${view.logged.length} logged (--show-logged; full history: things logbook --area)`),
    );
  }
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
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
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: AreaShowOpts & { json?: boolean; db?: string }) => {
      withClient(opts, "area-view", (c) => c.read.areaView(ref), ((d: AreaView) =>
        renderAreaView(d, opts)) as (d: never) => string[]);
    });
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
