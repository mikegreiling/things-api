/**
 * `things todo show <uuid>` — full detail for one record, including checklist,
 * inherited tags, and repeating flags (works on templates too).
 */
import type { Command } from "commander";

import { localToday, templateStatus, type AnyTask, type RepeatContext } from "../../index.ts";
import { blue, bold, dim, green, red } from "../style.ts";
import {
  containerLabel,
  deadlineDetail,
  inheritedChips,
  loggedDate,
  projectCircle,
  shortDate,
  thingsLink,
  todoBox,
  whenValue,
} from "../glyphs.ts";
import { openInThings, revealLine } from "./reads.ts";
import { renderNow, renderZone } from "../clock.ts";
import { runRead, withClient } from "../read-driver.ts";
import { DidYouMeanError } from "../did-you-mean.ts";

// The opened resource shows its tags green (GUI: list pills are gray).
const tagList = (tags: Array<{ title: string }>) =>
  green(`#${tags.map((t) => t.title).join(" #")}`);

/** The unit noun the after-completion caption phrases (singular; pluralized by the caller). */
const REPEAT_UNIT_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/**
 * The GUI's lower-corner repeat caption for a repeating INSTANCE, from its
 * template's joined context (src/read/detail.ts `repeats`): FIXED mode reads
 * `on <date>` (the "Repeats on Aug 19" projection); after-completion reads
 * `<N> <unit>(s) after completion` (the "Repeats 1 day after completion" form —
 * N/unit are the rule's own interval + frequency, singular/plural correct).
 * Returns null when the context carries no renderable caption (no decodable rule,
 * or a fixed rule with no projected date). The `paused` flag is surfaced
 * SEPARATELY so the caller can fold it into the merged `repeats:` line with the
 * instance-of handle. See {@link renderDetail}.
 */
function repeatContextValue(ctx: RepeatContext, todayIso: string): string | null {
  const rule = ctx.rule;
  if (rule === undefined) return null;
  if (rule.type === "fixed") {
    return ctx.next != null ? `on ${shortDate(ctx.next, todayIso)}` : null;
  }
  const noun = REPEAT_UNIT_NOUN[rule.unit] ?? rule.unit;
  const n = rule.interval;
  return `${n} ${noun}${n === 1 ? "" : "s"} after completion`;
}

/**
 * The detail card, project-card grammar: type-labeled title row (the box
 * carries open/completed/canceled; only `trashed` needs words), uri, then
 * labeled meta lines with absent values HIDDEN, the full note as a block,
 * and the checklist last. `status:`/`start:` lines are gone — the box, the
 * `when:` collapse, and the `logged:` line carry those between them.
 */
export function renderDetail(item: AnyTask | null): string[] {
  if (!item) return ["(not found)"];
  if (item.type === "heading") {
    return [
      `${bold("Heading:")} ${bold(item.title)}`,
      `  ${dim("uri:")} ${thingsLink(item.uuid)}`,
      `  ${dim("project:")} ${
        item.project === null
          ? "—"
          : containerLabel(item.project.title, item.project.isRepeatingTemplate === true)
      }`,
    ];
  }
  const todayIso = localToday(renderNow(), renderZone());
  const label = item.type === "to-do" ? "To-Do:" : "Project:";
  const box = item.type === "to-do" ? todoBox(item) : projectCircle(item);
  const trashed = item.derived.trashed ? ` ${red("(trashed)")}` : "";
  const lines = [
    `${bold(label)} ${box} ${bold(item.title)}${trashed}`,
    `  ${dim("uri:")} ${thingsLink(item.uuid)}`,
  ];
  const meta = (name: string, value: string | null | undefined) => {
    if (value != null && value !== "") lines.push(`  ${dim(`${name}:`)} ${value}`);
  };
  if (item.status === "open") {
    if (item.repeating.isTemplate) {
      // Templates: the stored start/deadline columns are app sentinels
      // (start=someday, deadline=4001-01-01) — the real dates belong to
      // spawned occurrences. Show the materialized next occurrence and,
      // when the rule assigns deadlines, say so instead of the sentinel.
      const next = item.repeating.nextOccurrence;
      meta("when", next == null ? null : `↻ ${shortDate(next, todayIso)}`);
      const rule = item.repeating.rule;
      const deadlines = rule !== undefined && (rule.type === "fixed" || rule.startOffsetDays < 0);
      meta(
        "deadline",
        deadlines
          ? `${bold(dim("⚑"))} ${dim(
              rule.startOffsetDays < 0
                ? `set per occurrence (${-rule.startOffsetDays} days after its start)`
                : "set per occurrence (due the day it appears)",
            )}`
          : null,
      );
    } else {
      meta("when", whenValue(item, todayIso));
      meta(
        "deadline",
        item.deadline !== null && item.deadline < "4000"
          ? deadlineDetail(item.deadline, todayIso)
          : null,
      );
    }
  } else if (item.stopped !== null) {
    meta(
      "logged",
      `${loggedDate(item.stopped, todayIso, renderZone())} ${dim(`(${item.status})`)}`,
    );
  }
  meta("area", item.area?.title);
  if (item.type === "to-do") {
    const projRef = item.project ?? item.headingProject;
    meta(
      "project",
      projRef == null
        ? undefined
        : containerLabel(projRef.title, projRef.isRepeatingTemplate === true),
    );
    meta("heading", item.heading?.title);
  }
  if (item.tags.length > 0) meta("tags", tagList(item.tags));
  // Inherited tags render dim as plain names (`#home #important`), and ONLY when
  // present — a zero-inherited card is byte-identical to no line.
  if (item.inheritedTags !== undefined && item.inheritedTags.length > 0)
    meta("inherited", inheritedChips(item.inheritedTags));
  if (item.repeating.isTemplate) {
    const st = templateStatus(item.repeating, todayIso);
    const state = item.repeating.nextOccurrence != null && st === "waiting" ? "scheduled" : st;
    meta("repeating", `TEMPLATE, ${state} (occurrences appear in upcoming)`);
  }
  if (item.repeating.isInstance) {
    // ONE merged line: the GUI's lower-corner caption plus the instance-of write
    // handle, e.g. `repeats: on Aug 19 (instance of <uuid>)` /
    // `repeats: 1 day after completion (instance of <uuid>)`; a paused template
    // folds in as `(paused; instance of <uuid>)`. With no renderable caption
    // (dangling FK / undecodable rule) the line is just `instance of <uuid>`
    // (paused appended). JSON wire is unchanged (`instanceOf` + `repeats` stay
    // separate keys, src/read/shape.ts).
    const tmpl = item.repeating.templateUuid;
    const instanceOf = `instance of ${tmpl}`;
    const ctx = item.repeating.repeats;
    const caption = ctx !== undefined ? repeatContextValue(ctx, todayIso) : null;
    const paused = ctx?.paused === true;
    if (caption !== null) {
      meta("repeats", `${caption} (${paused ? "paused; " : ""}${instanceOf})`);
    } else {
      meta("repeats", `${instanceOf}${paused ? dim(" (paused)") : ""}`);
    }
  }
  if (item.notes !== "") lines.push("", item.notes);
  if (item.type === "to-do" && item.checklist && item.checklist.length > 0) {
    lines.push("", dim("checklist:"));
    for (const c of item.checklist) {
      const cbox =
        c.status === "completed" ? blue("[✓]") : c.status === "canceled" ? blue("[×]") : "[ ]";
      lines.push(`  ${cbox} ${c.title}`);
    }
  }
  return lines;
}

export function registerTodoCommands(program: Command): void {
  const todo = program.command("todo").description("To-do–scoped operations");
  todo
    .command("show <uuid>")
    .description(
      "Full detail for one record by UUID — includes checklist items, inherited tags, and repeating flags; finds records list views hide (templates, trashed)",
    )
    .option("--all", "show the full record (single-record card — no default restriction to lift)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((uuid: string, opts: { json?: boolean; db?: string; all?: boolean }) => {
      runRead(
        opts,
        "detail",
        (c) => {
          const detail = c.read.byUuid(uuid);
          // A miss gets a type-scoped did-you-mean (to-dos only), not a bare
          // "(not found)". Ambiguous prefixes still throw from byUuid verbatim.
          if (detail === null) {
            throw new DidYouMeanError(
              `no to-do matches "${uuid}"`,
              uuid,
              c.read.liteTitleSearch(uuid, { type: "to-do" }),
            );
          }
          return { data: detail };
        },
        renderDetail,
      );
    });
  todo
    .command("open <ref>")
    .description(
      "Open the to-do in the Things app on this Mac (brings the window forward). Errors if the reference is not a to-do.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string; dryRun?: boolean }) => {
      withClient(
        opts,
        "open",
        (c) => {
          const t = c.read.showTarget(ref);
          if (t.kind !== "to-do")
            throw new RangeError(
              `"${ref}" is a ${t.viaHeading === true ? "heading" : t.kind}, not a to-do (try \`things open\`)`,
            );
          return openInThings(t.uuid, opts.db, opts.dryRun);
        },
        (d) => [revealLine(d)],
      );
    });
}
