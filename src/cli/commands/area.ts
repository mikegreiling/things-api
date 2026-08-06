/**
 * `things area show <ref>` — the composite area view (the write subcommands
 * under `things area` are registered by writes.ts on the same group).
 */
import type { Command } from "commander";

import { bold, dim, green } from "../style.ts";
import { areaMark, thingsLink } from "../glyphs.ts";
import { Option } from "commander";

import { openInThings, revealLine } from "./reads.ts";
import { renderNow, renderZone } from "../clock.ts";
import { invocation, parseCap, runRead, usageError, withClient } from "../read-driver.ts";
import { disclosureHint, formatItem, quoteTitle, uuidDisplayWidth } from "../render.ts";
import { DidYouMeanError } from "../did-you-mean.ts";
import { canonicalRef } from "../canonical-ref.ts";
import { getInvocation, setInvocationCanonical } from "../resolve-invocation.ts";
import { showToggleFlags } from "./project.ts";
import {
  AREA_PREVIEW_LIMIT,
  FULL_DESC,
  GROUPED_ALL_DESC,
  isLooseRef,
  LOOSE_OPEN_REFUSAL,
  isActiveProjectRow,
  isScheduledProjectRow,
  isSomedayProjectRow,
  localToday,
  ReferenceResolutionError,
  type AreaView,
  type BoundedAreaView,
  type GroupBlock,
  type GroupedLimits,
  type Project,
  type Todo,
} from "../../index.ts";
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
  /**
   * Per-section caps: `project` bounds the project-ROWS section, `area` the
   * direct-to-dos section (null = uncapped). The toggled later
   * section keeps its own existing bounds.
   */
  limits?: GroupedLimits;
  /** The user's invocation, echoed by the per-section truncation footers. */
  hintBase?: string;
  /**
   * The live count of the area's logged rows (subtree-inclusive, past the
   * log-move boundary — the same population `things logbook --area <ref>`
   * returns). Drives the TTY logbook footer's count; omitted / 0 hides the line.
   * TTY-only — the JSON area-view shape never carries it.
   */
  loggedCount?: number | undefined;
}

/**
 * GUI layout: active projects first (sidebar order), then the area's direct
 * to-dos. `--show-later` reveals the GUI's toggled sections — Upcoming
 * (future-scheduled projects, to-dos, and repeating templates intermixed in
 * date order) and Someday (someday projects as a leading block, then
 * someday to-dos). The area logbook is NOT a view section — it is the bounded
 * query `things logbook --area <ref>`; trashed rows live in `things trash`.
 *
 * `view` is the already-bounded card (its ACTIVE project rows and direct to-dos
 * capped; scheduled/someday project rows and the later section intact) and
 * `blocks` the per-block detail carrying each capped section's pre-cap total
 * (internal render plumbing, never the wire) — so the "… N more" footers derive
 * from it, never a pre-cap copy of the view.
 */
export function renderAreaView(view: AreaView, blocks: GroupBlock[], opts: AreaShowOpts): string[] {
  const todayIso = localToday(renderNow(), renderZone());
  // The card's ACTIVE project rows are already capped in `view`; scheduled and
  // someday rows always survive and route to the Upcoming/Someday sections.
  const activeProjects = view.projects.filter((p) => isActiveProjectRow(p, todayIso));
  const somedayProjects = view.projects.filter(isSomedayProjectRow);
  // Upcoming intermixes scheduled projects, scheduled to-dos, and repeating
  // templates in date order (templates sort by their next occurrence).
  const upcoming: Array<{ date: string; item: Todo | Project }> = [
    ...view.projects
      .filter((p) => isScheduledProjectRow(p, todayIso))
      .map((p) => ({ date: p.startDate ?? "", item: p })),
    ...view.scheduled.flatMap((d) => d.items.map((t) => ({ date: d.when, item: t }))),
    ...view.repeating.map((t) => ({ date: t.repeating.nextOccurrence ?? "9999", item: t })),
  ].toSorted((a, b) => a.date.localeCompare(b.date));

  const shown: Array<Todo | Project> = [
    ...activeProjects,
    ...view.active,
    ...(opts.showLater === true
      ? [...upcoming.map((u) => u.item), ...somedayProjects, ...view.someday]
      : []),
  ];
  const w = uuidDisplayWidth(shown);
  // Per-section caps (this view's sections are containers, so there is no
  // strict total limit): the project-ROWS block and the direct-to-dos block
  // truncate independently, each with its own exact-count footer. The card
  // preamble and the toggled later section are never capped. The pre-cap
  // totals come from the metadata; `limits` supplies the footer's doubling.
  const limits = opts.limits ?? { area: null, project: null };
  const projectsBlock = blocks.find((b) => b.kind === "projects");
  const activeBlock = blocks.find((b) => b.kind === "area");
  const hiddenProjects = projectsBlock ? projectsBlock.total - projectsBlock.shown : 0;
  const hiddenActive = activeBlock ? activeBlock.total - activeBlock.shown : 0;
  // The `loose` pseudo-area renders like an area card but has no uuid/uri/tags
  // (the NULL area is a derived view).
  const isLoose = view.area === null;
  const areaTitle = view.area?.title ?? "Loose";
  // The user's invocation, echoed by every disclosure hint (falls back to a
  // canonical typed command when a caller omits it, e.g. a direct unit test).
  const base = opts.hintBase ?? `things area show ${isLoose ? "loose" : quoteTitle(areaTitle)}`;
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
  const fmt = (i: Todo | Project) => formatItem(i, w, { suppressArea: view.area?.uuid ?? null });
  const fmtProject = fmt;

  // Card header: glyph + name, the GUI's share link (carries the uuid — it
  // pastes back into any ref argument), then labeled meta lines. The opened
  // resource shows its tags green (GUI: list pills are gray).
  const lines: string[] = [`${bold("Area:")} ${areaMark()} ${bold(areaTitle)}`];
  if (view.area !== null) {
    lines.push(`  ${dim("uri:")} ${thingsLink(view.area.uuid)}`);
    if (view.area.tags.length > 0)
      lines.push(`  ${dim("tags:")} ${green(`#${view.area.tags.map((t) => t.title).join(" #")}`)}`);
  }
  const block = (rows: string[]) => {
    if (rows.length > 0) lines.push("", ...rows);
  };
  block(activeProjects.map(fmtProject));
  sectionMore(hiddenProjects, "project", "--project-limit", limits.project);
  block(view.active.map(fmt));
  sectionMore(hiddenActive, "to-do", "--area-limit", limits.area);
  if (activeProjects.length === 0 && view.active.length === 0) lines.push("", "(no active items)");
  if (opts.showLater === true) {
    if (upcoming.length > 0) {
      lines.push("", bold("── Upcoming ──"), ...upcoming.map((u) => fmt(u.item)));
    }
    if (somedayProjects.length > 0 || view.someday.length > 0) {
      lines.push("", bold("── Someday ──"), ...somedayProjects.map(fmtProject));
      if (view.someday.length > 0) {
        if (somedayProjects.length > 0) lines.push("");
        lines.push(...view.someday.map(fmt));
      }
    }
  }
  // Default-hidden rows are never silent — a HIDDEN-SECTION placeholder (flush,
  // full command) stands where the Upcoming/Someday sections would render.
  if (opts.showLater !== true) {
    const hiddenLater = upcoming.length + somedayProjects.length + view.someday.length;
    if (hiddenLater > 0)
      lines.push(
        "",
        disclosureHint(hiddenLater, "later item", [{ command: `${base} --show-later` }]),
      );
  }
  // The area logbook is not a card section — it is the bounded query
  // `things logbook --area <ref>` (a real area only; the loose pseudo-area
  // accumulates no `logbook --area` archive). Trashed rows live in
  // `things trash`. The footer carries a LIVE count of that archive; it is
  // omitted entirely when the area has logged nothing (count 0 → no pointer).
  const loggedCount = opts.loggedCount ?? 0;
  if (!isLoose && loggedCount > 0) {
    lines.push(
      "",
      dim(
        `${loggedCount.toLocaleString("en-US")} logged item${loggedCount === 1 ? "" : "s"} — \`things logbook --area ${quoteTitle(areaTitle)}\``,
      ),
    );
  }
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
    full?: boolean;
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
  runRead<AreaView>(
    opts,
    "area-view",
    (c) => {
      let bounded: BoundedAreaView;
      try {
        bounded = c.read.areaView(ref, {
          overdue,
          ...tagFilter,
          areaLimit: areaCap.limit,
          projectLimit: projectCap.limit,
        });
      } catch (err) {
        // An ambiguity is surfaced verbatim (its candidates ARE the list); a
        // not-found gets a type-scoped did-you-mean.
        if (err instanceof ReferenceResolutionError && err.code === "ambiguous") throw err;
        if (err instanceof RangeError) {
          throw new DidYouMeanError(
            err.message,
            ref,
            c.read.liteTitleSearch(ref, { type: "area" }),
          );
        }
        throw err;
      }
      // The disclosure footers (and, for the plural/namespace sugar, the `≡`
      // echo) speak the area's CANONICAL ref — a bare round-tripping title, else
      // the fused `Title [prefix]`; the `loose` pseudo-area (null area) keeps the
      // reserved word. The typed `area show` carries no echo (classify canonical
      // stays null); the `areas <ref>` / `area <ref>` sugars refine their
      // classify-time canonical to this ref here.
      const area = bounded.view.area;
      const cref = area === null ? "loose" : canonicalRef(c.refPromoter(), "area", area);
      const hintBase = invocation("area show", [
        cref,
        ...showToggleFlags(opts),
        overdue && "--overdue",
        ...tagInvocationParts(opts),
      ]);
      if (getInvocation()?.canonical !== null) {
        setInvocationCanonical(invocation("area show", [cref]));
      }
      // Each capped scope's completeness rides its inline `total` (via
      // `areaTotals`, R1); the whole-view rollup rides `truncation`. The RENDER
      // reads the per-block detail directly (`bounded.blocks`, never the wire)
      // for its hidden-row footers — TTY behavior unchanged (doctrine v2 PR 5).
      return {
        data: bounded.view,
        truncation: bounded.truncation,
        areaTotals: bounded.totals,
        ...(bounded.notice !== undefined && { warnings: [bounded.notice] }),
        lines: renderAreaView(bounded.view, bounded.blocks, {
          ...opts,
          limits,
          hintBase,
          loggedCount: bounded.loggedCount,
        }),
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
        "Someday sections. The area logbook is not a section here — read it with " +
        "`things logbook --area <ref>`. Tag filters match rows directly and never " +
        "descend into project contents. Target by uuid or unique name, or the reserved " +
        "word `loose` for the area-less items (the null-area composite).",
    )
    .option("--show-later", "include Upcoming and Someday sections")
    .option("--project-limit <n>", `maximum project rows to show (default ${AREA_PREVIEW_LIMIT})`)
    .option("--area-limit <n>", `maximum direct to-dos to show (default ${AREA_PREVIEW_LIMIT})`)
    .option("--overdue", "only rows whose own deadline is past (due today is not overdue)")
    .option("--all", GROUPED_ALL_DESC)
    .option("--full", FULL_DESC)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path");
  addTagFilterOptions(areaShow)
    .addHelpText("after", CONTAINER_TAG_HINT)
    .action((ref: string, opts: AreaShowActionOpts) => runAreaShow(ref, opts));
  area
    .command("open <ref>")
    .description(
      "Open the area in the Things app on this Mac (brings the window forward). Errors if the reference is not an area.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string; dryRun?: boolean }) => {
      withClient(
        opts,
        "open",
        (c) => {
          // The loose pseudo-area is a derived view — refuse by name, not a
          // generic no-such-area error.
          if (isLooseRef(ref)) throw new RangeError(LOOSE_OPEN_REFUSAL);
          const t = c.read.showTarget(ref);
          if (t.kind !== "area")
            throw new RangeError(
              `"${ref}" is a ${t.viaHeading === true ? "heading" : t.kind}, not an area (try \`things open\`)`,
            );
          return openInThings(t.uuid, opts.db, opts.dryRun);
        },
        (d) => [revealLine(d)],
      );
    });
}
