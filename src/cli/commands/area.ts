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
import { Option } from "commander";

import { capAreaSections, type GroupedLimits } from "../../read/truncation.ts";
import { openInThings } from "./reads.ts";
import {
  invocation,
  parseCap,
  runRead,
  shellQuote,
  usageError,
  withClient,
} from "../read-driver.ts";
import { disclosureHint, formatItem, quoteTitle, uuidDisplayWidth } from "../render.ts";
import { DidYouMeanError } from "../did-you-mean.ts";
import { showToggleFlags } from "./project.ts";
import { AREA_PREVIEW_LIMIT, GROUPED_ALL_DESC } from "../../surface-copy.ts";
import {
  addTagFilterOptions,
  CONTAINER_TAG_HINT,
  tagFilterFields,
  tagFlagConflict,
  tagInvocationParts,
  type TagFlags,
} from "../tag-filters.ts";

export interface AreaShowOpts {
  showLater?: boolean;
  /** Commander optional-value flag: true when bare, the raw string when given a count. */
  showLogged?: boolean | string;
  /**
   * Per-section caps: `project` bounds the project-ROWS section, `area` the
   * direct-to-dos section (null = uncapped). The toggled later/logged
   * sections keep their own existing bounds.
   */
  limits?: GroupedLimits;
  /** The user's invocation, echoed by the per-section truncation footers. */
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

// Closed-but-unswept projects always sit in the active block (checked),
// never in Upcoming/Someday — start/startDate only classify OPEN rows.
const isSomedayProject = (p: Project) =>
  p.status === "open" && p.start === "someday" && p.startDate === null;

/**
 * GUI layout: active projects first (sidebar order), then the area's direct
 * to-dos. `--show-later` reveals the GUI's toggled sections — Upcoming
 * (future-scheduled projects, to-dos, and repeating templates intermixed in
 * date order) and Someday (someday projects as a leading block, then
 * someday to-dos). `--show-logged` reveals the full logbook.
 */
export function renderAreaView(view: AreaView, opts: AreaShowOpts): string[] {
  const todayIso = localToday();
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
  ].toSorted((a, b) => a.date.localeCompare(b.date));

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
  // Per-section caps (this view's sections are containers, so there is no
  // strict total limit): the project-ROWS block and the direct-to-dos block
  // truncate independently, each with its own exact-count footer. The card
  // preamble and the toggled later/logged sections are never capped here.
  const limits = opts.limits ?? { area: null, project: null };
  const shownProjects =
    limits.project === null ? activeProjects : activeProjects.slice(0, limits.project);
  const shownActive = limits.area === null ? view.active : view.active.slice(0, limits.area);
  // The user's invocation, echoed by every disclosure hint (falls back to a
  // canonical typed command when a caller omits it, e.g. a direct unit test).
  const base = opts.hintBase ?? `things area show ${quoteTitle(view.area.title)}`;
  // A per-block TRUNCATION FOOTER (indented two spaces under its partially-
  // shown block): `  … N more <noun>s — `<base> <flag> <bigger>``.
  const sectionMore = (hidden: number, noun: string, flag: string, cap: number | null): void => {
    if (hidden <= 0 || opts.hintBase === undefined || cap === null) return;
    lines.push(
      disclosureHint(hidden, `more ${noun}`, [{ command: `${opts.hintBase} ${flag} ${cap * 2}` }], {
        indent: true,
      }),
    );
  };
  // Rows inside this view never repeat the area's own name. The area's top
  // projects are plain ROWS here (not group headings — they don't head a to-do
  // group in this view), so they get the bold project title from delta 1 but NO
  // underline; only ANYTIME treats projects as headings. So a project renders
  // exactly like any other row here — no projectTitle opt.
  const fmt = (i: Todo | Project) => formatItem(i, w, { suppressArea: view.area.uuid });
  const fmtProject = fmt;

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
  block(shownProjects.map(fmtProject));
  sectionMore(
    activeProjects.length - shownProjects.length,
    "project",
    "--project-limit",
    limits.project,
  );
  block(shownActive.map(fmt));
  sectionMore(view.active.length - shownActive.length, "to-do", "--area-limit", limits.area);
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
  // Default-hidden rows are never silent — a HIDDEN-SECTION placeholder (flush,
  // full command) stands where the Upcoming/Someday sections would render.
  if (opts.showLater !== true) {
    const hiddenLater = upcoming.length + somedayProjects.length + view.later.someday.length;
    if (hiddenLater > 0)
      lines.push(
        "",
        disclosureHint(hiddenLater, "later item", [{ command: `${base} --show-later` }]),
      );
  }
  // The full archive belongs to `things logbook --area <ref>` — echoed
  // ready-to-paste with the real area name, like every other drill hint.
  const logbookCmd = `things logbook --area ${quoteTitle(view.area.title)}`;
  if (logged.length > 0) {
    // Truncation is loud: areas accumulate years of history. The header keeps
    // the shown-of-total count for orientation; the actionable drill rides a
    // section footer (matching the other truncated sections), never the header.
    const more = view.logged.length - logged.length;
    const header =
      more > 0
        ? `── Logged (${logged.length} of ${view.logged.length}) ──`
        : `── Logged (${view.logged.length}) ──`;
    lines.push("", bold(header), ...logged.map(fmt));
    if (more > 0) lines.push(dim(`… ${more} more — \`${logbookCmd}\``));
  } else if (view.logged.length > 0) {
    // Hidden-section placeholder: `--show-logged` reveals only the RECENT 15
    // (areas accumulate years), so it is labeled; the logbook drill reads its
    // own effect and needs none.
    lines.push(
      "",
      disclosureHint(view.logged.length, "logged item", [
        { label: "recent", command: `${base} --show-logged` },
        { command: logbookCmd },
      ]),
    );
  }
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
  return lines;
}

/** Options accepted by the area-show code path (shared by `area show` and `areas <ref>`). */
export type AreaShowActionOpts = AreaShowOpts &
  TagFlags & {
    json?: boolean;
    db?: string;
    limit?: string;
    areaLimit?: string;
    projectLimit?: string;
    all?: boolean;
    /** Content scope: keep only rows (loose to-dos + child projects) with an overdue own deadline. */
    overdue?: boolean;
  };

/**
 * The `area show <ref>` action body, factored out so the pluralized
 * `things areas <ref>` can delegate to the identical code path (a true synonym,
 * not a reimplementation). Both echo the canonical `things area show …` hint.
 */
export function runAreaShow(ref: string, opts: AreaShowActionOpts): void {
  if (tagFlagConflict(opts)) return;
  if (opts.limit !== undefined) {
    usageError(
      opts,
      "--limit is not available on area show — cap sections with --area-limit / --project-limit, or pass --all",
    );
    return;
  }
  const areaCap = parseCap(
    "--area-limit",
    opts.areaLimit,
    AREA_PREVIEW_LIMIT,
    opts.all === true,
    opts.json === true,
  );
  if (!areaCap.ok) return;
  const projectCap = parseCap(
    "--project-limit",
    opts.projectLimit,
    AREA_PREVIEW_LIMIT,
    opts.all === true,
    opts.json === true,
  );
  if (!projectCap.ok) return;
  const overdue = opts.overdue === true;
  const tagFilter = tagFilterFields(opts);
  const limits: GroupedLimits = { area: areaCap.limit, project: projectCap.limit };
  const hintBase = invocation("area show", [
    shellQuote(ref),
    ...showToggleFlags(opts),
    overdue && "--overdue",
    ...tagInvocationParts(opts),
  ]);
  runRead<AreaView>(
    opts,
    "area-view",
    (c) => {
      let view: AreaView;
      try {
        view = c.read.areaView(ref, { overdue, ...tagFilter });
      } catch (err) {
        // Not-found gets a type-scoped did-you-mean; ambiguity is verbatim.
        if (err instanceof RangeError && !err.message.includes("ambiguous")) {
          throw new DidYouMeanError(
            err.message,
            ref,
            c.read.liteTitleSearch(ref, { type: "area" }),
          );
        }
        throw err;
      }
      const { data, grouped } = capAreaSections(view, limits);
      return {
        data,
        grouped,
        lines: renderAreaView(view, { ...opts, limits, hintBase }),
      };
    },
    () => [],
  );
}

export function registerAreaCommands(program: Command): void {
  const area = program.command("area").description("Area-scoped operations");
  const areaShow = area
    .command("show <ref>")
    .description(
      "Composite area view mirroring the native UI: active projects first, then the " +
        "area's direct to-dos. --show-later adds the Upcoming (date-ordered) and " +
        "Someday sections; --show-logged adds the full logbook. --tag / --untagged filter " +
        "the rows by a tag carried directly on the row — tags inherited from this area are " +
        "ignored (every row inherits them); no descent into project contents. Target by " +
        "uuid or unique name.",
    )
    .option("--show-later", "include Upcoming and Someday sections")
    .option(
      "--show-logged [n]",
      "include the n most recently logged items (bare flag = 15; full history via `things logbook --area`)",
    )
    .option("--project-limit <n>", `maximum project rows to show (default ${AREA_PREVIEW_LIMIT})`)
    .option("--area-limit <n>", `maximum direct to-dos to show (default ${AREA_PREVIEW_LIMIT})`)
    .option("--overdue", "only rows whose own deadline is past (due today is not overdue)")
    .option("--all", GROUPED_ALL_DESC)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path");
  addTagFilterOptions(areaShow)
    .addHelpText("after", CONTAINER_TAG_HINT)
    .action((ref: string, opts: AreaShowActionOpts) => runAreaShow(ref, opts));
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
        (d) => [`opened ${d.uri}`],
      );
    });
}
