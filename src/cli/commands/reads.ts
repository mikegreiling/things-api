/**
 * Read-only list commands: option/description wiring per view, delegating to
 * the read driver (../read-driver.ts) for envelope/output and to the pure
 * renderers (../render.ts) for human lines. Each command renders a compact
 * human table (UUIDs always shown — agents and humans both need stable
 * references) or a --json envelope.
 */
import { Option, type Command } from "commander";
import { execFileSync } from "node:child_process";

import { runAreaShow, type AreaShowActionOpts } from "./area.ts";
import { runProjectShow, type ProjectShowActionOpts } from "./project.ts";
import type { ListItem, TodayView, ViewFilter } from "../../read/views.ts";
import { localToday } from "../../model/dates.ts";
import { dim } from "../style.ts";
import { areaMark, LEGEND, shortDate } from "../glyphs.ts";
import {
  formatItem,
  disclosureHint,
  renderAnytimePreview,
  renderLegend,
  renderList,
  renderLogbook,
  renderProjectsSidebar,
  renderSearch,
  renderSections,
  renderSomedayPreview,
  renderToday,
  renderUpcoming,
  stripAnsi,
  uuidCol,
  uuidDisplayWidth,
  type LaterHints,
} from "../render.ts";
import {
  invocation,
  parseCap,
  parseLimit,
  runRead,
  shellQuote,
  truncationHint,
  usageError,
  withClient,
  type GlobalReadOpts,
} from "../read-driver.ts";
import {
  addTagFilterOptions,
  collectRef,
  CONTAINER_TAG_HINT,
  EXACT_TAG_DESC,
  hasTagPresence,
  TAG_DESC,
  UNTAGGED_DESC,
  tagFilterFields,
  tagFlagConflict,
  tagInvocationParts,
  type TagFlags,
} from "../tag-filters.ts";
import { doublePeriod, parsePeriodEnd, parsePeriodStart } from "../period.ts";
import { ExitCode, okEnvelope, type EnvelopeMeta } from "../../contracts.ts";
import {
  AREA_PREVIEW_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  truncateList,
  truncateToday,
  partitionSomedaySection,
  previewSections,
  previewSomedaySections,
  type GroupedLimits,
} from "../../read/truncation.ts";
import {
  ALL_DESC,
  AREA_LIMIT_DESC,
  GROUPED_ALL_DESC,
  LIMIT_DESC,
  PERIOD_SINCE,
  PERIOD_UNTIL,
  PROJECT_LIMIT_DESC,
} from "../../surface-copy.ts";

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

/** Help copy for the `--overdue` content scope (open items past their deadline). */
const OVERDUE_DESC = "only open items past their deadline (due today is not overdue)";

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

  program
    .command("today")
    .description(
      "The Today list, split into Today and This Evening (evening expires daily), with the sidebar badge split (red = deadline due/overdue)",
    )
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--overdue", OVERDUE_DESC)
    .option("--evening", "show only the This Evening section")
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
          overdue?: boolean;
          evening?: boolean;
          limit?: string;
          all?: boolean;
        },
      ) => {
        if (tagFlagConflict(opts)) return;
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        const eveningOnly = opts.evening === true;
        const base = invocation("today", [
          ...tagInvocationParts(opts),
          opts.overdue === true && "--overdue",
          eveningOnly && "--evening",
        ]);
        const filter = {
          ...tagFilterFields(opts),
          ...(opts.overdue === true && { overdue: true }),
          ...(eveningOnly && { eveningOnly: true }),
        };
        runRead(
          opts,
          "today",
          (c) => {
            const full = c.read.today(filter);
            const { data, truncation } = truncateToday(full, lim.limit);
            // The renderer needs the PRE-cap view to keep This Evening honest
            // under truncation, so the lines are precomputed here; the global
            // footer (whole-view remainder) is still appended by the driver.
            return { data, truncation, lines: renderToday(full, data, base, { eveningOnly }) };
          },
          // Type-correct fallback for the TodayView payload; never reached
          // because `lines` is always precomputed above.
          (data: TodayView) => renderToday(data, data, base, { eveningOnly }),
          base,
          "today",
        );
      },
    );

  program
    .command("inbox")
    .description(
      "Unprocessed captures (Inbox). Bound the CREATION date with --since/--until — an " +
        "item's arrival into Things (a demoted item keeps its original creation date, so " +
        "this is not strictly when it entered the Inbox).",
    )
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--overdue", OVERDUE_DESC)
    .option("--since <when>", `only captures created on/after this bound: ${PERIOD_SINCE}`)
    .option("--until <when>", `only captures created on/before this bound: ${PERIOD_UNTIL}`)
    .option("--limit <n>", LIMIT_DESC)
    .option("--all", ALL_DESC)
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
          overdue?: boolean;
          since?: string;
          until?: string;
          limit?: string;
          all?: boolean;
        },
      ) => {
        if (tagFlagConflict(opts)) return;
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        const since = opts.since !== undefined ? parsePeriodStart(opts.since) : undefined;
        const until = opts.until !== undefined ? parsePeriodEnd(opts.until) : undefined;
        for (const [flag, value] of [
          ["--since", since],
          ["--until", until],
        ] as const) {
          if (value !== undefined && Number.isNaN(value.getTime())) {
            usageError(opts, `${flag} is not a parseable date`);
            return;
          }
        }
        // Bounds-&-defaults lift rule (identical to logbook): an explicit range
        // bound (--since/--until) drops the default row cap unless --limit is
        // also stated — the creation window the user named IS the bound, not an
        // arbitrary 50-row cut.
        const boundGiven = opts.since !== undefined || opts.until !== undefined;
        const effectiveLimit =
          opts.limit === undefined && opts.all !== true && boundGiven ? null : lim.limit;
        const base = invocation("inbox", [
          ...tagInvocationParts(opts),
          opts.overdue === true && "--overdue",
          opts.since !== undefined && `--since ${shellQuote(opts.since)}`,
          opts.until !== undefined && `--until ${shellQuote(opts.until)}`,
        ]);
        runRead(
          opts,
          "inbox",
          (c) => {
            const { data, truncation } = truncateList(
              c.read.inbox({
                ...tagFilterFields(opts),
                ...(opts.overdue === true && { overdue: true }),
                ...(since !== undefined && { since }),
                ...(until !== undefined && { until }),
              }),
              effectiveLimit,
            );
            const lines = renderList(data);
            // Standard row-truncation hint (bigger --limit / --all), as every
            // flat view — handled here (not via the driver's hintBase) so the
            // creation-window note can sit last, mirroring upcoming's window
            // footer mechanics.
            const hint = truncationHint(base, truncation);
            if (hint !== null) lines.push("", hint);
            // Presentation order is unchanged (manual ORDER BY index); the date
            // bound is an invisible axis in the rows, so name the effective
            // window in a dim footer note. Human output only — the precomputed
            // lines never ride --json.
            if (boundGiven) {
              const today = localToday();
              const sinceLabel = since !== undefined ? shortDate(localToday(since), today) : null;
              const untilLabel = until !== undefined ? shortDate(localToday(until), today) : null;
              const note =
                sinceLabel !== null && untilLabel !== null
                  ? `(created ${sinceLabel} – ${untilLabel})`
                  : sinceLabel !== null
                    ? `(created since ${sinceLabel})`
                    : `(created through ${untilLabel})`;
              lines.push("", dim(note));
            }
            return { data, truncation, lines };
          },
          renderList,
          undefined,
          "inbox",
        );
      },
    );

  program
    .command("anytime")
    .description(
      "All active items in canonical order (area-less first, then per " +
        "area: direct to-dos, then each project with its members). Today members are " +
        "starred (★). Children of someday/future-scheduled projects are excluded — the " +
        "project row represents them. Every group and project row is always shown; " +
        "--area-limit caps each area's direct list, --project-limit each project's list, " +
        "--all shows everything",
    )
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--overdue", OVERDUE_DESC)
    .option("--area-limit <n>", AREA_LIMIT_DESC)
    .option("--project-limit <n>", PROJECT_LIMIT_DESC)
    .option("--all", GROUPED_ALL_DESC)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        opts: GlobalReadOpts & {
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
          overdue?: boolean;
          areaLimit?: string;
          projectLimit?: string;
          all?: boolean;
          limit?: string;
        },
      ) => {
        if (tagFlagConflict(opts)) return;
        if (opts.limit !== undefined) {
          usageError(
            opts,
            "--limit is not available on anytime — cap blocks with --area-limit / --project-limit, or pass --all",
          );
          return;
        }
        const area = parseCap(
          "--area-limit",
          opts.areaLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
          opts.json === true,
        );
        if (!area.ok) return;
        const project = parseCap(
          "--project-limit",
          opts.projectLimit,
          PROJECT_PREVIEW_LIMIT,
          opts.all === true,
          opts.json === true,
        );
        if (!project.ok) return;
        const limits: GroupedLimits = { area: area.limit, project: project.limit };
        const base = invocation("anytime", [
          ...tagInvocationParts(opts),
          opts.overdue === true && "--overdue",
        ]);
        // Content scopes compose (AND): --overdue narrows a tagged/untagged
        // set, so the filter is built additively rather than one-or-the-other.
        const filter: ViewFilter = {
          ...tagFilterFields(opts),
          ...(opts.overdue === true && { overdue: true }),
        };
        runRead(
          opts,
          "anytime",
          (c) => {
            const full = c.read.anytime(filter);
            const { data, grouped } = previewSections(full, limits);
            return { data, grouped, lines: renderAnytimePreview(full, limits, base) };
          },
          // Grouped views hand back precomputed `lines`; renderSections is the
          // type-correct fallback for the SidebarSection[] payload but is never
          // reached here.
          renderSections,
          undefined,
          "anytime",
        );
      },
    );

  program
    .command("someday")
    .description(
      "Someday items (incubated, undated) in canonical order — inside each group the " +
        "someday projects list first, then the to-dos; project children are represented " +
        "by their project row. --show-active-project-items [n] appends a trailing section " +
        "of someday to-dos inside active projects, grouped under their project (the UI's " +
        "'Show items from active projects' toggle; n caps each project's list). " +
        "--area-limit caps each group, --all shows everything",
    )
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--overdue", OVERDUE_DESC)
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
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
          overdue?: boolean;
          areaLimit?: string;
          showActiveProjectItems?: boolean | string;
          all?: boolean;
          limit?: string;
        },
      ) => {
        if (tagFlagConflict(opts)) return;
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
            opts.json === true,
          );
          if (!capped.ok) return;
          projectCap = capped.limit;
        }
        const area = parseCap(
          "--area-limit",
          opts.areaLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
          opts.json === true,
        );
        if (!area.ok) return;
        const limits: GroupedLimits = { area: area.limit, project: projectCap };
        const filter = {
          ...tagFilterFields(opts),
          ...(opts.overdue === true && { overdue: true }),
        };
        const base = invocation("someday", [
          ...tagInvocationParts(opts),
          opts.overdue === true && "--overdue",
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
          // Precomputed lines above; renderSections is the type-correct
          // SidebarSection[] fallback, never reached here.
          renderSections,
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
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
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
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
          horizon?: string;
        },
        command: Command,
      ) => {
        if (tagFlagConflict(opts)) return;
        const untilGiven = command.getOptionValueSource("until") !== "default";
        const sinceGiven = opts.since !== undefined;
        const limitGiven = opts.limit !== undefined;
        if (opts.all === true && (untilGiven || sinceGiven)) {
          usageError(opts, "--all does not combine with --until/--since");
          return;
        }
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        // Bounds-&-defaults rule: an explicit volume cap (--limit) or range
        // bound (--until/--since) disables the OTHER class's default. So an
        // explicit --limit drops the default window (the next N scheduled
        // items), and an explicit window drops the default row cap — each
        // stated bound takes over output sizing.
        const dropWindowDefault = !untilGiven && (limitGiven || sinceGiven);
        const dropLimitDefault = !limitGiven && opts.all !== true && (untilGiven || sinceGiven);
        const effectiveLimit = dropLimitDefault ? null : lim.limit;
        const untilDate =
          opts.all === true || dropWindowDefault ? undefined : parsePeriodEnd(opts.until);
        if (untilDate !== undefined && Number.isNaN(untilDate.getTime())) {
          usageError(opts, `--until is not a parseable period: ${opts.until}`);
          return;
        }
        const sinceDate = sinceGiven ? parsePeriodStart(opts.since as string) : undefined;
        if (sinceDate !== undefined && Number.isNaN(sinceDate.getTime())) {
          usageError(opts, `--since is not a parseable period: ${opts.since}`);
          return;
        }
        const until = untilDate === undefined ? undefined : localToday(untilDate);
        const since = sinceDate === undefined ? undefined : localToday(sinceDate);
        // The default window is in force only for a bare invocation (no
        // explicit cap or bound); that is the one case whose footer names the
        // window itself alongside the levers.
        const defaultWindowActive = until !== undefined && !untilGiven;
        const base = invocation("upcoming", [
          untilGiven && `--until ${shellQuote(opts.until)}`,
          sinceGiven && `--since ${shellQuote(opts.since as string)}`,
          ...tagInvocationParts(opts),
          opts.horizon !== undefined && `--horizon ${shellQuote(opts.horizon)}`,
        ]);
        runRead(
          opts,
          "upcoming",
          (c) => {
            const { data, truncation } = truncateList(
              c.read.upcoming({
                ...(until !== undefined && { until }),
                ...(since !== undefined && { since }),
                ...tagFilterFields(opts),
                ...(opts.horizon !== undefined && { horizon: Number(opts.horizon) }),
              }),
              effectiveLimit,
            );
            const lines = renderUpcoming(data);
            if (defaultWindowActive && until !== undefined) {
              const windowLabel = shortDate(until, localToday());
              if (truncation.truncated && truncation.limit !== null) {
                // Bare invocation, row cap biting inside the default window: one
                // line names BOTH the window and the two levers, so neither the
                // limit nor the horizon is a hidden second bound.
                const more = truncation.total - truncation.shown;
                lines.push(
                  "",
                  dim(
                    `── ${more} more item${more === 1 ? "" : "s"} through ${windowLabel} — ` +
                      `see more: \`${base} --limit ${truncation.limit * 2}\` · ` +
                      `\`${base} --all\` ──`,
                  ),
                );
              } else {
                // Default window active, row cap NOT biting: the only useful
                // lever is a wider window (or everything).
                lines.push(
                  "",
                  dim(
                    `(through ${windowLabel} — wider: \`${base} --until ${doublePeriod(opts.until)}\`` +
                      ` · \`${base} --all\`)`,
                  ),
                );
              }
            } else if (truncation.truncated && truncation.limit !== null) {
              // The user stated a bound: no window line, only a row hint, and
              // only when an explicit --limit truncated. A stated --until/--since
              // makes --all a usage error (and would discard the very window
              // they asked for), so a bounded run offers just a bigger cap.
              const more = truncation.total - truncation.shown;
              const bounded = untilGiven || sinceGiven;
              const allLever = bounded ? "" : ` · \`${base} --all\``;
              lines.push(
                "",
                dim(
                  `── ${more} more item${more === 1 ? "" : "s"} — ` +
                    `see more: \`${base} --limit ${truncation.limit * 2}\`${allLever} ──`,
                ),
              );
            }
            return { data, truncation, lines };
          },
          (items: ListItem[]) => renderUpcoming(items),
          undefined,
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
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
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
          tag?: string[];
          exactTag?: boolean;
          untagged?: boolean;
        },
      ) => {
        if (tagFlagConflict(opts)) return;
        const lim = parseLimit(opts);
        if (!lim.ok) return;
        const since = opts.since !== undefined ? parsePeriodStart(opts.since) : undefined;
        const until = opts.until !== undefined ? parsePeriodEnd(opts.until) : undefined;
        for (const [flag, value] of [
          ["--since", since],
          ["--until", until],
        ] as const) {
          if (value !== undefined && Number.isNaN(value.getTime())) {
            usageError(opts, `${flag} is not a parseable date`);
            return;
          }
        }
        // Bounds-&-defaults rule: an explicit range bound (--since/--until)
        // drops the default row cap unless --limit is also stated — the logged
        // window the user named is the bound, not an arbitrary 50-row cut.
        const boundGiven = opts.since !== undefined || opts.until !== undefined;
        const effectiveLimit =
          opts.limit === undefined && opts.all !== true && boundGiven ? null : lim.limit;
        const base = invocation("logbook", [
          opts.area !== undefined && `--area ${shellQuote(opts.area)}`,
          opts.project !== undefined && `--project ${shellQuote(opts.project)}`,
          opts.since !== undefined && `--since ${shellQuote(opts.since)}`,
          opts.until !== undefined && `--until ${shellQuote(opts.until)}`,
          ...tagInvocationParts(opts),
        ]);
        runRead(
          opts,
          "logbook",
          (c) =>
            truncateList(
              c.read.logbook({
                limit: null,
                ...(opts.area !== undefined && { area: opts.area }),
                ...(opts.project !== undefined && { project: opts.project }),
                ...(since !== undefined && { since }),
                ...(until !== undefined && { until }),
                ...tagFilterFields(opts),
              }),
              effectiveLimit,
            ),
          (items: ListItem[]) => renderLogbook(items),
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
        (c) => truncateList(c.read.trash({ limit: null }), lim.limit),
        renderList,
        invocation("trash", []),
        "trash",
      );
    });

  const projects = program
    .command("projects [ref]")
    .description(
      "List active projects in canonical order, or — given a ref — show that one " +
        "project (exactly like `things project show <ref>`). List: loose projects " +
        "first, then grouped under their area (optionally scoped to --area <ref>). " +
        "Someday and future-scheduled projects are hidden — --show-later appends them " +
        "after each group's active block (state carried by the (~) mark and ‹date› " +
        "chip). Filter the listed projects by their own tags with --tag / --untagged — " +
        "inheritance-inclusive (a project inherits its area's tags), the same as the flat " +
        "views. --show-logged applies only when showing one project.",
    )
    .option("--area <ref>", "filter by area (uuid or unique name)")
    .option("--show-later", "include someday/future-scheduled projects after each active block")
    .option("--show-logged [n]", "showing one project: include logged items (bare = all)")
    .option("--overdue", "only projects past their deadline (due today is not overdue)")
    .option("--all", "include someday/future-scheduled projects (same as --show-later)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path");
  addTagFilterOptions(projects).action(
    (
      id: string | undefined,
      opts: GlobalReadOpts &
        ProjectShowActionOpts & {
          area?: string;
          showLater?: boolean;
          all?: boolean;
          overdue?: boolean;
        },
    ) => {
      // Given a ref, this IS `things project show <ref>` — delegate to the same
      // code path so the output is identical (a true synonym). --overdue rides
      // along (it filters the shown project's children there).
      if (id !== undefined) {
        runProjectShow(id, opts);
        return;
      }
      if (tagFlagConflict(opts)) return;
      // --all lifts the sole default restriction here — the hidden later block
      // — so it is exactly --show-later (the charter: --all removes every
      // default restriction on the view's own content).
      const showLater = opts.showLater === true || opts.all === true;
      // OWN-DEADLINE UNIFORM content scope: keep only projects whose own
      // deadline is overdue. Composes as AND with --area/--show-later; a
      // content scope, it never lifts a limit. Threaded into the hidden-later
      // counting queries too so the counts reflect the same filter.
      const overdue = opts.overdue === true;
      // Tag scope (§9a): the projects LIST is a FLAT view — each project ROW is
      // filtered by its own tags, INHERITANCE-INCLUSIVE (a project inherits its
      // area's tags), the same as `anytime`. NOT a single-container view.
      // Threaded into the hidden-later counts too so they reflect the same filter.
      const tagFilter = tagFilterFields(opts);
      let hints: LaterHints | undefined;
      withClient(
        opts,
        "projects",
        (c) => {
          const scope = opts.area !== undefined ? { areaUuid: opts.area } : {};
          const visible = c.read.projects({
            ...scope,
            ...(showLater && { later: true }),
            ...(overdue && { overdue: true }),
            ...tagFilter,
          });
          if (opts.area === undefined) {
            // Sidebar scaffold: every VISIBLE area renders (project-less
            // ones say so), in sidebar order; the loose block leads. One
            // extra projects query buys the hidden-later counts.
            const full = showLater
              ? visible
              : c.read.projects({ later: true, ...(overdue && { overdue: true }), ...tagFilter });
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
          } else if (!showLater) {
            // --area scoped: only the bottom hint needs a count.
            const full = c.read.projects({
              ...scope,
              later: true,
              ...(overdue && { overdue: true }),
              ...tagFilter,
            });
            hints = { groups: [{ area: null, hidden: full.length - visible.length }] };
          }
          return visible;
        },
        // Scoped to one area the list is flat (the scope names the group);
        // unscoped it mirrors the sidebar with ⬡ area headers.
        (items) => {
          if (opts.area === undefined) return renderProjectsSidebar(items, hints);
          const lines = renderList(items);
          const hidden = hints?.groups.reduce((n, g) => n + g.hidden, 0) ?? 0;
          if (hidden > 0) {
            // Hidden-section placeholder: the reveal command echoes the user's
            // own scope (--area) plus the flag that surfaces the later block.
            const reveal = invocation("projects", [
              opts.area !== undefined && `--area ${shellQuote(opts.area)}`,
              overdue && "--overdue",
              ...tagInvocationParts(opts),
              "--show-later",
            ]);
            lines.push("", disclosureHint(hidden, "later project", [{ command: reveal }]));
          }
          return lines;
        },
      );
    },
  );

  const areas = program
    .command("areas [ref]")
    .description(
      "List all areas with their direct tags, or — given a ref — show that one area " +
        "(exactly like `things area show <ref>`: its projects and direct to-dos). " +
        "--show-later / --show-logged / --area-limit / --project-limit / the tag filters " +
        "apply only when showing one area.",
    )
    .option("--all", "show every area (no default restriction applies)")
    .option("--show-later", "showing one area: include its Upcoming and Someday sections")
    .option("--show-logged [n]", "showing one area: include the n most recent logged items")
    .option("--project-limit <n>", "showing one area: maximum project rows to show")
    .option("--area-limit <n>", "showing one area: maximum direct to-dos to show")
    .option(
      "--overdue",
      "showing one area: only rows whose own deadline is past (due today is not overdue)",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path");
  addTagFilterOptions(areas).addHelpText("after", CONTAINER_TAG_HINT);
  areas.action((id: string | undefined, opts: GlobalReadOpts & AreaShowActionOpts) => {
    // Given a ref, this IS `things area show <ref>` — delegate to the same code
    // path so the output is identical (a true synonym); --overdue and the tag
    // filters scope its rows there.
    if (id !== undefined) {
      runAreaShow(id, opts);
      return;
    }
    // The areas LIST has no deadline to compare against — an area is not a
    // dated entity — so --overdue is vacuous here and rejected fail-closed
    // (the same exclusion style #159 used for upcoming/logbook/trash).
    if (opts.overdue === true) {
      usageError(
        opts,
        "--overdue does not apply to the areas list — areas have no deadline; use it on `things areas <ref>` (that area's rows) or `things projects --overdue`",
      );
      return;
    }
    // The tag filters scope an area's ROWS, not the area LIST — the bare list
    // shows every area with its direct tags. Rejected fail-closed here (same
    // style as --overdue); use `things areas <ref>` or `things projects --tag`.
    if (hasTagPresence(opts) || opts.untagged === true) {
      usageError(
        opts,
        "the tag filters (--tag/--untagged) do not apply to the areas list — use them on `things areas <ref>` (that area's rows) or `things projects --tag`",
      );
      return;
    }
    withClient(
      opts,
      "areas",
      (c) => c.read.areas(),
      (data) => {
        const w = uuidDisplayWidth(data);
        return data.map(
          (a) =>
            `${dim(uuidCol(a.uuid, w))}  ${areaMark()} ${a.title}${a.tags.length ? ` ${dim(`#${a.tags.map((t) => t.title).join(" #")}`)}` : ""}`,
        );
      },
    );
  });

  program
    .command("tags")
    .description("Tag taxonomy — the parent → child hierarchy as an indented tree")
    .option("--all", "show every tag (no default restriction applies)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: GlobalReadOpts) => {
      withClient(
        opts,
        "tags",
        (c) => c.read.tags(),
        // An INDENTED TREE, leaf names only — nesting is conveyed by indentation
        // (2 spaces per depth level), mirroring the Things GUI. Tag names are
        // globally unique (TAGW1-c), so each displayed leaf name is directly
        // usable as a tag ref — no path prefix or uuid needed. Rows arrive in
        // canonical DFS order (index, uuid) from tagsView, children following
        // their parent; the tree IS structure, so leaf names render plainly (not
        // dim). Depth is the length of the parent-name chain (names are unique).
        (data) => {
          const parentOf = new Map(data.map((t) => [t.title, t.parent]));
          const depthOf = (title: string): number => {
            let depth = 0;
            const seen = new Set<string>();
            let cur = parentOf.get(title) ?? null;
            while (cur !== null && !seen.has(cur)) {
              seen.add(cur);
              depth++;
              cur = parentOf.get(cur) ?? null;
            }
            return depth;
          };
          return data.map((t) => `${"  ".repeat(depthOf(t.title))}${t.title}`);
        },
      );
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
        usageError(opts, `--since is not a parseable date: ${opts.since}`);
        return;
      }
      const base = invocation("changes", [`--since ${shellQuote(opts.since)}`]);
      runRead(
        opts,
        "changes",
        (c) => truncateList(c.read.changes({ since, limit: null }), lim.limit),
        (items) =>
          items.length === 0
            ? ["(no changes)"]
            : items.map(
                (i) =>
                  `${i.changeKind === "created" ? "+" : "~"} ${formatItem(i)}${i.trashed ? " [trashed]" : ""}`,
              ),
        base,
      );
    });

  program
    .command("search <query>")
    .description(
      "Title/notes substring search, ranked: title matches first, then notes, then a " +
        "project surfaced by a matching heading title (shown as its parent project, " +
        "`via heading`); projects rank above to-dos, active above someday, ties broken by " +
        "most-recently-modified. Default scope: OPEN + untrashed items only — widen with " +
        "--logged / --trashed / --all. Scope with --project / --area / --tag (tag matches " +
        "include hierarchy descendants) / --type / --overdue (open items past their deadline).",
    )
    .option("--project <ref>", "restrict to one project's children (uuid or unique name)")
    .option("--area <ref>", "restrict to one area's direct members (uuid or unique name)")
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--overdue", OVERDUE_DESC)
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
      const json = opts["json"] === true;
      const type = opts["type"] as string | undefined;
      if (type !== undefined && type !== "todo" && type !== "project") {
        usageError({ json }, "--type must be todo or project");
        return;
      }
      const tagFlags: TagFlags = {
        ...(Array.isArray(opts["tag"]) && { tag: opts["tag"] as string[] }),
        exactTag: opts["exactTag"] === true,
        untagged: opts["untagged"] === true,
      };
      if (tagFlagConflict({ ...tagFlags, json })) return;
      const overdue = opts["overdue"] === true;
      const all = opts["all"] === true;
      // --overdue lists OPEN, past-deadline items; the status-widening flags
      // pull in completed/canceled/trashed rows, so the combination is
      // contradictory (like --untagged with --tag).
      if (overdue && (opts["logged"] === true || opts["trashed"] === true || all)) {
        usageError({ json }, "--overdue does not combine with --logged/--trashed/--all");
        return;
      }
      const limitOpt = opts["limit"] as string | undefined;
      // --all widens the scope AND lifts the row limit — combining it with an
      // explicit --limit is contradictory (like every other view).
      const lim = parseLimit({ all, json, ...(limitOpt !== undefined && { limit: limitOpt }) });
      if (!lim.ok) return;
      const base = invocation("search", [
        shellQuote(query),
        opts["project"] !== undefined && `--project ${shellQuote(opts["project"] as string)}`,
        opts["area"] !== undefined && `--area ${shellQuote(opts["area"] as string)}`,
        ...tagInvocationParts(tagFlags),
        overdue && "--overdue",
        type !== undefined && `--type ${type}`,
        opts["logged"] === true && "--logged",
        opts["trashed"] === true && "--trashed",
      ]);
      runRead(
        opts,
        "search",
        (c) =>
          truncateList(
            c.read.search(query, {
              limit: null,
              ...(opts["project"] !== undefined && { project: opts["project"] as string }),
              ...(opts["area"] !== undefined && { area: opts["area"] as string }),
              ...tagFilterFields(tagFlags),
              ...(overdue && { overdue: true }),
              ...(type !== undefined && { type: type === "todo" ? "to-do" : "project" }),
              ...(opts["logged"] === true && { logged: true }),
              ...(opts["trashed"] === true && { trashed: true }),
              ...(all && { all: true }),
            }),
            lim.limit,
          ),
        renderSearch,
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
