/**
 * `things project show <uuid>` — the composite project view.
 */
import type { Command } from "commander";

import type { Todo } from "../../model/entities.ts";
import type { ProjectView } from "../../read/project-view.ts";
import { localToday } from "../../model/dates.ts";
import { bold, dim, green, underline } from "../style.ts";
import {
  countChip,
  deadlineDetail,
  loggedDate,
  projectCircle,
  thingsLink,
  whenValue,
} from "../glyphs.ts";
import { formatItem, openInThings, uuidCol, uuidDisplayWidth, withClient } from "./reads.ts";

export interface ProjectShowOpts {
  showLater?: boolean;
  /** Optional-value flag: bare = the FULL project logbook (finite lifespans), a count to cap it. */
  showLogged?: boolean | string;
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

/**
 * GUI parity: later rows (scheduled / repeating / someday) render INLINE
 * beneath their heading — dimmed boxes and date chips carry the state — not
 * exiled to a separate section that disassociates them from their headings.
 * They are hidden by default like the GUI's toggle; `--show-later` reveals
 * them, `--show-logged` reveals the full logbook.
 */
export function renderProjectView(view: ProjectView, opts: ProjectShowOpts): string[] {
  const later: Todo[] =
    opts.showLater === true
      ? [
          ...view.later.scheduled.flatMap((d) => d.items),
          ...view.later.repeating,
          ...view.later.someday,
        ]
      : [];
  const knownHeadings = new Set(view.headings.map((g) => g.heading.uuid));
  const laterByHeading = new Map<string, Todo[]>();
  const looseLater: Todo[] = [];
  for (const item of later) {
    // A later row whose heading is absent from the view falls back to the
    // loose block rather than vanishing.
    if (item.heading !== null && knownHeadings.has(item.heading.uuid)) {
      const list = laterByHeading.get(item.heading.uuid) ?? [];
      list.push(item);
      laterByHeading.set(item.heading.uuid, list);
    } else {
      looseLater.push(item);
    }
  }
  const logged = loggedSlice(view, opts.showLogged);
  const everyItem = [...view.active, ...later, ...view.headings.flatMap((g) => g.items), ...logged];
  const w = uuidDisplayWidth([...everyItem, ...view.headings.map((g) => g.heading)]);
  // Rows inside this view never repeat the project's own name.
  const fmt = (i: (typeof everyItem)[number]) =>
    formatItem(i, w, { suppressProject: view.project.uuid });
  // Card header, GUI order: title row (circle, progress chip, area context),
  // share link, then labeled when/deadline/tags lines and the full note.
  // The opened resource shows its tags green (GUI: list pills are gray).
  const p = view.project;
  const todayIso = localToday();
  const areaSuffix = p.area === null ? "" : ` ${dim(`(${p.area.title})`)}`;
  // In the Trash the card says so — the only view where the project's
  // would-be-recovered (untrashed) children remain visible.
  const trashedSuffix = p.trashed ? ` ${dim("(trashed)")}` : "";
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
    lines.push(`  ${dim("logged:")} ${loggedDate(p.stopped, todayIso)} ${dim(`(${p.status})`)}`);
  if (p.tags.length > 0)
    lines.push(`  ${dim("tags:")} ${green(`#${p.tags.map((t) => t.title).join(" #")}`)}`);
  if (p.inheritedTags !== undefined && p.inheritedTags.length > 0)
    lines.push(
      `  ${dim("inherited:")} ${green(`#${p.inheritedTags.map((t) => t.title).join(" #")}`)}`,
    );
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
  // Default-hidden rows are never silent — a muted count names the toggle.
  if (opts.showLater !== true) {
    const hiddenLater =
      view.later.scheduled.reduce((n, d) => n + d.items.length, 0) +
      view.later.repeating.length +
      view.later.someday.length;
    if (hiddenLater > 0)
      lines.push(
        "",
        dim(`…${hiddenLater} later item${hiddenLater === 1 ? "" : "s"} (--show-later)`),
      );
  }
  if (logged.length > 0) {
    const header =
      logged.length < view.logged.length
        ? `── Logged (${logged.length} of ${view.logged.length}) ──`
        : `── Logged (${view.logged.length}) ──`;
    lines.push("", bold(header), ...logged.map(fmt));
  } else if (view.logged.length > 0) {
    lines.push("", dim(`…${view.logged.length} logged (--show-logged)`));
  }
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
  return lines;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project-scoped operations");
  project
    .command("show <ref>")
    .description(
      "Composite project view mirroring the native UI: active items and headings. --show-later adds scheduled/repeating/someday rows inline under their headings; --show-logged adds the full logbook. Target by uuid or unique name.",
    )
    .option("--show-later", "include scheduled, repeating, and someday rows")
    .option("--show-logged [n]", "include logged items (bare flag = all; pass a count to cap)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: ProjectShowOpts & { json?: boolean; db?: string }) => {
      withClient(opts, "project-view", (c) => c.read.projectView(ref), ((d: ProjectView) =>
        renderProjectView(d, opts)) as (d: never) => string[]);
    });
  project
    .command("open <ref>")
    .description(
      "Open the project in the Things app — foregrounds the GUI on this Mac (NOT headless). Errors when the reference is not a project.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "open",
        (c) => {
          const t = c.read.showTarget(ref);
          if (t.kind !== "project" || t.viaHeading === true) {
            const what = t.viaHeading === true ? "heading" : t.kind;
            throw new RangeError(`"${ref}" is a ${what}, not a project (try \`things open\`)`);
          }
          return { uri: openInThings(t.uuid) };
        },
        ((d: { uri: string }) => [`opened ${d.uri}`]) as (d: never) => string[],
      );
    });
}
