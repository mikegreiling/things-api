/**
 * `things project show <uuid>` — the composite project view.
 */
import type { Command } from "commander";

import {
  FULL_DESC,
  localToday,
  ReferenceResolutionError,
  type ProjectView,
  type Todo,
} from "../../index.ts";
import { bold, dim, green, underline } from "../style.ts";
import {
  countChip,
  deadlineDetail,
  inheritedChips,
  loggedDate,
  projectCircle,
  thingsLink,
  whenValue,
} from "../glyphs.ts";
import { openInThings, revealLine } from "./reads.ts";
import { renderNow, renderZone } from "../clock.ts";
import { invocation, runRead, withClient } from "../read-driver.ts";
import { disclosureHint, formatItem, quoteTitle, uuidCol, uuidDisplayWidth } from "../render.ts";
import { DidYouMeanError } from "../did-you-mean.ts";
import { canonicalRef } from "../canonical-ref.ts";
import { getInvocation, setInvocationCanonical } from "../resolve-invocation.ts";
import {
  addTagFilterOptions,
  CONTAINER_TAG_HINT,
  tagFilterFields,
  tagFlagConflict,
  tagInvocationParts,
  type TagFlags,
} from "../tag-filters.ts";

export interface ProjectShowOpts {
  showLater?: boolean;
  /** Optional-value flag: bare = the FULL project logbook (finite lifespans), a count to cap it. */
  showLogged?: boolean | string;
  /** The user's invocation, echoed by the disclosure hints. */
  hintBase?: string;
}

/** Reconstruct the show-toggle flags the user passed, for footer echoes. */
export function showToggleFlags(opts: {
  showLater?: boolean;
  showLogged?: boolean | string;
}): Array<string | false> {
  return [
    opts.showLater === true && "--show-later",
    opts.showLogged === true && "--show-logged",
    typeof opts.showLogged === "string" && `--show-logged ${opts.showLogged}`,
  ];
}

function loggedSlice(view: ProjectView, showLogged: boolean | string | undefined): Todo[] {
  if (showLogged === undefined) return [];
  if (showLogged === true) return view.logged;
  const n = Number(showLogged);
  return Number.isInteger(n) && n > 0 ? view.logged.slice(0, n) : view.logged;
}

/** The later sub-buckets a project OR heading group carries (§9 fidelity fix). */
type LaterBuckets = {
  scheduled: ProjectView["scheduled"];
  repeating: Todo[];
  someday: Todo[];
};

/** Total rows across a group's later sub-buckets (for the hidden-later count). */
function countLater(g: LaterBuckets): number {
  return (
    g.scheduled.reduce((n, d) => n + d.items.length, 0) + g.repeating.length + g.someday.length
  );
}

/**
 * GUI parity: later rows (scheduled / repeating / someday) render INLINE
 * beneath their heading — dimmed boxes and date chips carry the state — not
 * exiled to a separate section that disassociates them from their headings.
 * They are hidden by default like the GUI's toggle; `--show-later` reveals
 * them, `--show-logged` reveals the full logbook.
 */
export function renderProjectView(view: ProjectView, opts: ProjectShowOpts): string[] {
  // Later rows (scheduled/repeating/someday) now arrive already partitioned by
  // heading in the payload (§9 fidelity fix): the project-level buckets hold the
  // UNHEADED rows, each heading group its own. Flatten each into a display list.
  const laterOf = (g: {
    scheduled: ProjectView["scheduled"];
    repeating: Todo[];
    someday: Todo[];
  }): Todo[] =>
    opts.showLater === true
      ? [...g.scheduled.flatMap((d) => d.items), ...g.repeating, ...g.someday]
      : [];
  const looseLater = laterOf(view);
  const laterByHeading = new Map<string, Todo[]>(
    view.headings.map((g) => [g.heading.uuid, laterOf(g)]),
  );
  // The logged region has two parts: the flat swept rows (children of OPEN
  // headings + un-headed), and the archived-heading GROUPS (HEADARC2-A). Both
  // are revealed only by --show-logged; the flat list honors the optional count.
  const showLogged = opts.showLogged !== undefined;
  const logged = loggedSlice(view, opts.showLogged);
  const loggedGroups = showLogged ? view.loggedHeadings : [];
  const loggedGroupItems = loggedGroups.flatMap((g) => g.items);
  const everyItem = [
    ...view.active,
    ...looseLater,
    ...view.headings.flatMap((g) => [...g.items, ...(laterByHeading.get(g.heading.uuid) ?? [])]),
    ...logged,
    ...loggedGroupItems,
  ];
  const w = uuidDisplayWidth([
    ...everyItem,
    ...view.headings.map((g) => g.heading),
    ...loggedGroups.map((g) => g.heading),
  ]);
  // Rows inside this view never repeat the project's own name.
  const fmt = (i: (typeof everyItem)[number]) =>
    formatItem(i, w, { suppressProject: view.project.uuid });
  // A flat logged row hints its (open) HEADING instead of the project.
  const fmtLogged = (i: Todo) =>
    formatItem(i, w, { suppressProject: view.project.uuid, headingContext: true });
  // Card header, GUI order: title row (circle, progress chip, area context),
  // share link, then labeled when/deadline/tags lines and the full note.
  // The opened resource shows its tags green (GUI: list pills are gray).
  const p = view.project;
  const todayIso = localToday(renderNow(), renderZone());
  const areaSuffix = p.area === null ? "" : ` ${dim(`(${p.area.title})`)}`;
  // In the Trash the card says so — the only view where the project's
  // would-be-recovered (untrashed) children remain visible.
  const trashedSuffix = p.derived.trashed ? ` ${dim("(trashed)")}` : "";
  const lines: string[] = [
    `${bold("Project:")} ${projectCircle(p)} ${bold(underline(p.title))} ${countChip(p)}${areaSuffix}${trashedSuffix}`,
    `  ${dim("uri:")} ${thingsLink(p.uuid)}`,
  ];
  if (p.status === "open") {
    const when = whenValue(p, todayIso);
    if (when !== null) lines.push(`  ${dim("when:")} ${when}`);
  }
  if (p.deadline !== null && p.deadline < "4000" && p.status === "open")
    lines.push(`  ${dim("deadline:")} ${deadlineDetail(p.deadline, todayIso)}`);
  if (p.status !== "open" && p.stopped !== null)
    lines.push(
      `  ${dim("logged:")} ${loggedDate(p.stopped, todayIso, renderZone())} ${dim(`(${p.status})`)}`,
    );
  if (p.tags.length > 0)
    lines.push(`  ${dim("tags:")} ${green(`#${p.tags.map((t) => t.title).join(" #")}`)}`);
  // Inherited (from the area) renders dim as plain tag names, only when
  // present — a zero-inherited card is byte-identical to no line.
  if (p.inheritedTags !== undefined && p.inheritedTags.length > 0)
    lines.push(`  ${dim("inherited:")} ${inheritedChips(p.inheritedTags)}`);
  if (p.repeating.isTemplate)
    lines.push(`  ${dim("repeating:")} TEMPLATE (invisible in list views)`);
  if (p.repeating.isInstance)
    lines.push(`  ${dim("repeating:")} instance of ${p.repeating.templateUuid}`);
  if (p.notes !== "") lines.push("", p.notes);
  const looseRows = [...view.active, ...looseLater];
  if (looseRows.length > 0) lines.push("", ...looseRows.map(fmt));
  for (const group of view.headings) {
    // Headings are the GUI's dim in-project subheads, not structural
    // sections — rendered like item rows (their uuid IS addressable:
    // heading rename/archive), title dim+underlined.
    const members = [...group.items, ...(laterByHeading.get(group.heading.uuid) ?? [])];
    lines.push(
      "",
      `${dim(uuidCol(group.heading.uuid, w))}  ${dim(underline(group.heading.title))}`,
      ...(members.length > 0 ? members.map(fmt) : ["(none)"]),
    );
  }
  // The user's invocation, echoed by the disclosure hints (fallback for a
  // caller that omits it, e.g. a direct unit test).
  const base = opts.hintBase ?? `things project show ${quoteTitle(view.project.title)}`;
  // Default-hidden rows are never silent — a HIDDEN-SECTION placeholder (flush,
  // full command) stands where the later rows would render.
  if (opts.showLater !== true) {
    const hiddenLater = countLater(view) + view.headings.reduce((n, g) => n + countLater(g), 0);
    if (hiddenLater > 0)
      lines.push(
        "",
        disclosureHint(hiddenLater, "later item", [{ command: `${base} --show-later` }]),
      );
  }
  // The logged count the GUI's "Show N logged items" toggle reports: the flat
  // swept rows PLUS, per archived-heading group, the heading itself (a logged
  // item) and each of its children (HEADARC2-A: heading + 2 children = 3).
  const loggedGroupCount = view.loggedHeadings.reduce((n, g) => n + 1 + g.items.length, 0);
  const totalLogged = view.logged.length + loggedGroupCount;
  if (showLogged && totalLogged > 0) {
    const shownCount = logged.length + loggedGroupCount;
    const header =
      shownCount < totalLogged
        ? `── Logged (${shownCount} of ${totalLogged}) ──`
        : `── Logged (${totalLogged}) ──`;
    lines.push("", bold(header));
    if (logged.length > 0) lines.push(...logged.map(fmtLogged));
    // Archived-heading groups: an active-styled section header (HEADARC2-A) with
    // its children nested (the group header supplies the heading — no per-child
    // hint). Rendered after the flat rows (a defensible ordering, not GUI-probed).
    for (const group of view.loggedHeadings) {
      lines.push(
        "",
        `${dim(uuidCol(group.heading.uuid, w))}  ${dim(underline(group.heading.title))}`,
        ...(group.items.length > 0 ? group.items.map(fmt) : ["(none)"]),
      );
    }
  } else if (totalLogged > 0) {
    // Bare `--show-logged` is the FULL project logbook, so the command reads
    // its own effect — no label needed.
    lines.push(
      "",
      disclosureHint(totalLogged, "logged item", [{ command: `${base} --show-logged` }]),
    );
  }
  // PLOG1 discoverability advisory: a completed/canceled (incl. logged) project
  // can still hold OPEN children — the app buries them in every live view, and
  // they surface only here. A flush sibling of the disclosure-hint placeholder
  // class (docs/design/render-language.md § Disclosure hints): the rows ARE on
  // screen above, so it takes no `…` and no reveal command — it just names what
  // the app hides.
  if (view.openChildrenWhileResolved > 0) {
    const n = view.openChildrenWhileResolved;
    lines.push(
      "",
      dim(
        `contains ${n} unfinished to-do${n === 1 ? "" : "s"} — invisible in the app's live views`,
      ),
    );
  } else if (view.openChildrenUnderArchivedHeading > 0) {
    // HEADARC2-C: an OPEN project can still bury an open child under an ARCHIVED
    // heading (a GUI Put-Back strands it there without reopening the heading) —
    // invisible in every live view, reachable only via the logged region here.
    const n = view.openChildrenUnderArchivedHeading;
    lines.push(
      "",
      dim(
        `contains ${n} unfinished to-do${n === 1 ? "" : "s"} buried under an archived heading — invisible in the app's live views`,
      ),
    );
  }
  return lines;
}

/** Options accepted by the project-show code path (shared by `project show` and `projects <ref>`). */
export type ProjectShowActionOpts = ProjectShowOpts &
  TagFlags & {
    json?: boolean;
    db?: string;
    all?: boolean;
    full?: boolean;
    /** Content scope: keep only child to-dos whose own deadline is overdue. */
    overdue?: boolean;
  };

/**
 * The `project show <ref>` action body, factored out so the pluralized
 * `things projects <ref>` can delegate to the identical code path (a true
 * synonym). Both echo the canonical `things project show …` hint.
 */
export function runProjectShow(ref: string, rawOpts: ProjectShowActionOpts): void {
  if (tagFlagConflict(rawOpts)) return;
  // --all lifts the view's own default restriction (the hidden later rows).
  // Logged is a SEPARATE content class and stays behind --show-logged.
  const overdue = rawOpts.overdue === true;
  const tagFilter = tagFilterFields(rawOpts);
  const opts: ProjectShowOpts & { json?: boolean; db?: string } = {
    ...rawOpts,
    showLater: rawOpts.showLater === true || rawOpts.all === true,
  };
  runRead(
    opts,
    "project-view",
    (c) => {
      let view: ProjectView;
      try {
        view = c.read.projectView(ref, { overdue, ...tagFilter });
      } catch (err) {
        // An ambiguity is surfaced verbatim — its own candidate list IS the
        // disambiguation (count and list coherent by construction). A not-found
        // gets a type-scoped did-you-mean instead.
        if (err instanceof ReferenceResolutionError && err.code === "ambiguous") throw err;
        if (err instanceof RangeError) {
          throw new DidYouMeanError(
            err.message,
            ref,
            c.read.liteTitleSearch(ref, { type: "project" }),
          );
        }
        throw err;
      }
      // The disclosure footers (and, for the plural/namespace sugar, the `≡`
      // echo) speak the entity's CANONICAL ref — a bare round-tripping title,
      // else the fused `Title [prefix]` — never the raw string the user typed.
      // The typed `project show` carries no echo (its classify canonical stays
      // null); the `projects <ref>` / `project <ref>` sugars set one at classify
      // time, refined here to the canonical ref.
      const cref = canonicalRef(c.refPromoter(), "project", view.project);
      const hintBase = invocation("project show", [
        cref,
        ...showToggleFlags(rawOpts),
        overdue && "--overdue",
        ...tagInvocationParts(rawOpts),
      ]);
      if (getInvocation()?.canonical !== null) {
        setInvocationCanonical(invocation("project show", [cref]));
      }
      return { data: view, lines: renderProjectView(view, { ...opts, hintBase }) };
    },
    () => [],
  );
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project-scoped operations");
  const projectShow = project
    .command("show <ref>")
    .description(
      "Composite project view mirroring the native UI: active items and headings. --show-later adds scheduled/repeating/someday rows inline under their headings; --show-logged adds the full logbook. Target by uuid or unique name.",
    )
    .option("--show-later", "include scheduled, repeating, and someday rows")
    .option("--show-logged [n]", "include logged items (bare flag = all; pass a count to cap)")
    .option("--overdue", "only child to-dos past their deadline (due today is not overdue)")
    .option(
      "--all",
      "reveal the later rows (same as --show-later; logged stays behind --show-logged)",
    )
    .option("--full", FULL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path");
  addTagFilterOptions(projectShow)
    .addHelpText("after", CONTAINER_TAG_HINT)
    .action((ref: string, rawOpts: ProjectShowActionOpts) => runProjectShow(ref, rawOpts));
  project
    .command("open <ref>")
    .description(
      "Open the project in the Things app on this Mac (brings the window forward). Errors if the reference is not a project.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string; dryRun?: boolean }) => {
      withClient(
        opts,
        "open",
        (c) => {
          const t = c.read.showTarget(ref);
          if (t.kind !== "project" || t.viaHeading === true) {
            const what = t.viaHeading === true ? "heading" : t.kind;
            throw new RangeError(`"${ref}" is a ${what}, not a project (try \`things open\`)`);
          }
          return openInThings(t.uuid, opts.db, opts.dryRun);
        },
        (d) => [revealLine(d)],
      );
    });
}
