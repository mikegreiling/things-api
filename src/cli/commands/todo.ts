/**
 * `things todo show <uuid>` — full detail for one record, including checklist,
 * inherited tags, and repeating flags (works on templates too).
 */
import type { Command } from "commander";

import type { AnyTask } from "../../model/entities.ts";
import { withClient } from "./reads.ts";

function renderDetail(item: AnyTask | null): string[] {
  if (!item) return ["(not found)"];
  if (item.type === "heading") {
    return [`${item.uuid}  [heading] ${item.title}`, `  project: ${item.project?.title ?? "—"}`];
  }
  const lines = [
    `${item.uuid}  [${item.type}] ${item.title}`,
    `  status: ${item.status}${item.trashed ? " (trashed)" : ""}  start: ${item.start}`,
    `  when: ${item.startDate ?? "—"}${item.todaySection === "evening" ? " (this evening)" : ""}  deadline: ${item.deadline ?? "—"}`,
    `  area: ${item.area?.title ?? "—"}${item.type === "to-do" ? `  project: ${item.project?.title ?? "—"}  heading: ${item.heading?.title ?? "—"}` : ""}`,
    `  tags: ${item.tags.map((t) => t.title).join(", ") || "—"}  inherited: ${(item.inheritedTags ?? []).map((t) => t.title).join(", ") || "—"}`,
  ];
  if (item.repeating.isTemplate) lines.push("  repeating: TEMPLATE (invisible in list views)");
  if (item.repeating.isInstance)
    lines.push(`  repeating: instance of ${item.repeating.templateUuid}`);
  if (item.notes)
    lines.push(`  notes: ${item.notes.length > 200 ? `${item.notes.slice(0, 200)}…` : item.notes}`);
  if (item.type === "to-do" && item.checklist && item.checklist.length > 0) {
    lines.push("  checklist:");
    for (const c of item.checklist) {
      lines.push(
        `    [${c.status === "completed" ? "x" : c.status === "canceled" ? "~" : " "}] ${c.title}`,
      );
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
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((uuid: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "todo-detail",
        (c) => c.read.byUuid(uuid),
        renderDetail as (d: never) => string[],
      );
    });
}
