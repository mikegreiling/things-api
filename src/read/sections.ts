/**
 * Pure STRUCTURAL decomposition of the sidebar catalogues (anytime/someday)
 * into their innermost item blocks, plus the per-block cap shape the bounding
 * layer applies. No capping and no counts live here — this module only splits a
 * section into (direct/loose to-dos, per-project child lists); the actual
 * truncation is layered on top in ./truncation.ts. Split out so the human
 * renderers (src/cli/render.ts) can re-derive block structure WITHOUT importing
 * the truncation module (the surface/library layering boundary).
 */
import type { Ref } from "../model/entities.ts";
import type { ListItem, SidebarSection } from "./views.ts";

/**
 * Per-block caps for the grouped catalogues: `area` bounds each area-direct
 * block (and the leading loose block), `project` each project's to-do list.
 * `null` = uncapped (the caller passed --all / all: true, or — for someday's
 * active-projects section — asked for every item).
 */
export interface GroupedLimits {
  area: number | null;
  project: number | null;
}

/**
 * Split one sidebar section into its innermost item blocks: the direct
 * to-dos that precede any project row, then one block per project (the
 * project row plus the to-dos that follow it until the next project).
 */
export interface SectionBlocks {
  direct: ListItem[];
  projects: Array<{ project: ListItem; items: ListItem[] }>;
}

export function splitSectionBlocks(section: SidebarSection): SectionBlocks {
  const direct: ListItem[] = [];
  const projects: Array<{ project: ListItem; items: ListItem[] }> = [];
  let cur: { project: ListItem; items: ListItem[] } | null = null;
  for (const item of section.items) {
    if (item.type === "project") {
      cur = { project: item, items: [] };
      projects.push(cur);
    } else if (cur === null) {
      direct.push(item);
    } else {
      cur.items.push(item);
    }
  }
  return { direct, projects };
}

/**
 * Someday sections split differently from anytime: PROJECT rows there are
 * plain ITEMS (a someday project stands for itself — its children are never
 * inline), so a section's "own" block is its project rows + container-less
 * to-dos together, and the to-dos that DO carry a project reference (the
 * activeProjectItems toggle) form separate per-project child groups.
 */
export interface SomedayPartition {
  /** Project rows + direct to-dos, in section order. */
  own: ListItem[];
  /** Someday to-dos inside active projects, clustered per project. */
  children: Array<{ project: Ref; items: ListItem[] }>;
}

export function partitionSomedaySection(section: SidebarSection): SomedayPartition {
  const own: ListItem[] = [];
  const byProject = new Map<string, { project: Ref; items: ListItem[] }>();
  for (const item of section.items) {
    const container = item.type === "to-do" ? (item.project ?? item.headingProject ?? null) : null;
    if (container === null) {
      own.push(item);
      continue;
    }
    let group = byProject.get(container.uuid);
    if (group === undefined) {
      group = { project: container, items: [] };
      byProject.set(container.uuid, group);
    }
    group.items.push(item);
  }
  return { own, children: [...byProject.values()] };
}
