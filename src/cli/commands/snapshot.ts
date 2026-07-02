/**
 * `things snapshot` — full normalized dump (all rows, all states) for
 * diffing, backup forensics, and the lab harness. Human output shows counts;
 * use --json for the data.
 */
import type { Command } from "commander";

import type { Snapshot } from "../../read/snapshot.ts";
import { withClient } from "./reads.ts";

function renderCounts(snapshot: Snapshot): string[] {
  const c = snapshot.counts;
  return [
    `areas: ${c.areas}  tags: ${c.tags}`,
    `todos: ${c.todos}  projects: ${c.projects}  headings: ${c.headings}`,
    `checklist items: ${c.checklistItems}`,
    `trashed: ${c.trashed}  repeating templates: ${c.repeatingTemplates}`,
    `(use --json for the full dump)`,
  ];
}

export function registerSnapshot(program: Command): void {
  program
    .command("snapshot")
    .description(
      "Full normalized dump of the library: every task row (all types/states incl. repeating templates and trashed), areas, tags, checklist items — uuid-ordered for stable diffs",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "snapshot",
        (c) => c.read.snapshot(),
        renderCounts as (d: never) => string[],
      );
    });
}
