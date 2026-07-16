/**
 * The three universal tag-filter flags (`--tag`, `--exact-tag`, `--untagged`)
 * shared by every read command that accepts them — the flat list views
 * (reads.ts) and the container views (project.ts, area.ts, show.ts). One place
 * owns the help copy, the repeatable-collect, the mutual-exclusivity guard, and
 * the mapping to a {@link ViewFilter}.
 *
 * Two axes live in `--tag`: (A) CONTAINER inheritance (an item inherits its
 * project/area/heading tags) and (B) TAG-HIERARCHY descendant expansion
 * (filtering `Parent` matches items tagged with a descendant). `--exact-tag`
 * drops only (B). Axis (A) is view-dependent: FLAT views keep it (an
 * inheritance-inclusive `--tag`); CONTAINER views (`project show`, `area show`,
 * the `projects` list) drop it, since every child inherits the container's tags
 * — there a `--tag` matches a DIRECT assignment (still descendant-expanded).
 */
import type { Command } from "commander";

import type { ViewFilter } from "../read/views.ts";
import { shellQuote, usageError } from "./read-driver.ts";

/** Commander repeatable-collect: accumulate each `--tag` value. */
export const collectRef = (value: string, previous: string[]): string[] => [...previous, value];

/** Help copy for the tag-filter flags (shared verbatim across every view). */
export const TAG_DESC =
  "filter by tag (uuid or unique name), repeatable — several tags AND together; " +
  "matches direct, container-inherited, or descendant-tagged items (in a container " +
  "view — project/area/projects — the container's own inherited tags are ignored)";
export const EXACT_TAG_DESC = "match the named tag(s) only — exclude hierarchy descendants";
export const UNTAGGED_DESC =
  'only items with no tag, direct or inherited — the app\'s "No Tag" filter (in a ' +
  "container view: no tag on the item itself, ignoring the container's inherited tags)";

/**
 * The `--help` footer appended to the container views (`project show`,
 * `area show`, the `projects` list) explaining their `--tag` semantics: the
 * filter matches a tag carried directly on the child, ignoring tags inherited
 * from the container (every child inherits those, so an inheritance-inclusive
 * match would be vacuous).
 */
export const CONTAINER_TAG_HINT =
  "\n--tag / --untagged match a tag carried directly on the item, ignoring tags\n" +
  "inherited from this container (every child inherits them). --exact-tag still\n" +
  "drops hierarchy descendants.";

/** The parsed shape of the three tag-filter flags on any tag-accepting view. */
export interface TagFlags {
  tag?: string[];
  exactTag?: boolean;
  untagged?: boolean;
}

/** Register the three universal tag-filter flags on a command, in help order. */
export function addTagFilterOptions(cmd: Command): Command {
  return cmd
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC);
}

/** True when any tag-PRESENCE flag was passed (a positive filter, not a negation). */
export function hasTagPresence(opts: TagFlags): boolean {
  return (opts.tag?.length ?? 0) > 0 || opts.exactTag === true;
}

/**
 * Shared usage guard for the tag-filter flags. The negation (`--untagged`)
 * inverts a tag presence, so it does not combine with a tag-presence flag.
 * Emits the usage error (the view's conflict style) and returns true when it
 * fires.
 */
export function tagFlagConflict(opts: TagFlags & { json?: boolean }): boolean {
  if (opts.untagged === true && hasTagPresence(opts)) {
    usageError(opts, "--untagged does not combine with --tag/--exact-tag");
    return true;
  }
  return false;
}

/** The ViewFilter tag fields built from the parsed flags (empty keys omitted). */
export function tagFilterFields(opts: TagFlags): ViewFilter {
  return {
    ...(opts.tag !== undefined && opts.tag.length > 0 && { tags: opts.tag }),
    ...(opts.exactTag === true && { exactTag: true }),
    ...(opts.untagged === true && { untagged: true }),
  };
}

/** The invocation-echo fragments for the tag flags (one `--tag <ref>` per ref). */
export function tagInvocationParts(opts: TagFlags): Array<string | false> {
  return [
    ...(opts.tag ?? []).map((t) => `--tag ${shellQuote(t)}`),
    opts.exactTag === true && "--exact-tag",
    opts.untagged === true && "--untagged",
  ];
}
