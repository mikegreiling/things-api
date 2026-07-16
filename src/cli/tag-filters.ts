/**
 * The five universal tag-filter flags (`--tag`, `--direct-tag`, `--exact-tag`,
 * `--untagged`, `--direct-untagged`) shared by every read command that accepts
 * them — the flat list views (reads.ts) and the container views (project.ts,
 * area.ts, show.ts). One place owns the help copy, the repeatable-collect, the
 * mutual-exclusivity guard, and the mapping to a {@link ViewFilter}.
 *
 * Two axes live in `--tag`: (A) CONTAINER inheritance (an item inherits its
 * project/area/heading tags) and (B) TAG-HIERARCHY descendant expansion
 * (filtering `Parent` matches items tagged with a descendant). `--tag` uses
 * both; `--direct-tag` drops only (A); `--exact-tag` drops only (B), for both.
 */
import type { Command } from "commander";

import type { ViewFilter } from "../read/views.ts";
import { shellQuote, usageError } from "./read-driver.ts";

/** Commander repeatable-collect: accumulate each `--tag`/`--direct-tag` value. */
export const collectRef = (value: string, previous: string[]): string[] => [...previous, value];

/** Help copy for the tag-filter flags (shared verbatim across every view). */
export const TAG_DESC =
  "filter by tag (uuid or unique name), repeatable — several tags AND together; " +
  "matches direct, container-inherited, or descendant-tagged items";
export const DIRECT_TAG_DESC =
  "filter by a tag assigned DIRECTLY to the item (repeatable, AND) — excludes tags " +
  "inherited from its project/area/heading; still matches hierarchy descendants";
export const EXACT_TAG_DESC = "match the named tag(s) only — exclude hierarchy descendants";
export const UNTAGGED_DESC =
  'only items with no tag, direct or inherited — the app\'s "No Tag" filter';
export const DIRECT_UNTAGGED_DESC =
  'only items with no DIRECT tag — an inherited tag is allowed (the in-context "No Tag")';

/** The parsed shape of the five tag-filter flags on any tag-accepting view. */
export interface TagFlags {
  tag?: string[];
  directTag?: string[];
  exactTag?: boolean;
  untagged?: boolean;
  directUntagged?: boolean;
}

/** Register the five universal tag-filter flags on a command, in help order. */
export function addTagFilterOptions(cmd: Command): Command {
  return cmd
    .option("--tag <ref>", TAG_DESC, collectRef, [])
    .option("--direct-tag <ref>", DIRECT_TAG_DESC, collectRef, [])
    .option("--exact-tag", EXACT_TAG_DESC)
    .option("--untagged", UNTAGGED_DESC)
    .option("--direct-untagged", DIRECT_UNTAGGED_DESC);
}

/** True when any tag-PRESENCE flag was passed (a positive filter, not a negation). */
export function hasTagPresence(opts: TagFlags): boolean {
  return (opts.tag?.length ?? 0) > 0 || (opts.directTag?.length ?? 0) > 0 || opts.exactTag === true;
}

/**
 * Shared usage guard for the tag-filter flags. The negations
 * (`--untagged`/`--direct-untagged`) invert a tag presence, so they combine
 * neither with a tag-presence flag nor with each other. `--tag` and
 * `--direct-tag` MAY compose (different predicates, AND-ed). Emits the usage
 * error (the view's conflict style) and returns true when it fires.
 */
export function tagFlagConflict(opts: TagFlags & { json?: boolean }): boolean {
  if (opts.untagged === true && opts.directUntagged === true) {
    usageError(opts, "--untagged and --direct-untagged do not combine");
    return true;
  }
  if (opts.untagged === true && hasTagPresence(opts)) {
    usageError(opts, "--untagged does not combine with --tag/--direct-tag/--exact-tag");
    return true;
  }
  if (opts.directUntagged === true && hasTagPresence(opts)) {
    usageError(opts, "--direct-untagged does not combine with --tag/--direct-tag/--exact-tag");
    return true;
  }
  return false;
}

/** The ViewFilter tag fields built from the parsed flags (empty keys omitted). */
export function tagFilterFields(opts: TagFlags): ViewFilter {
  return {
    ...(opts.tag !== undefined && opts.tag.length > 0 && { tags: opts.tag }),
    ...(opts.directTag !== undefined &&
      opts.directTag.length > 0 && { directTags: opts.directTag }),
    ...(opts.exactTag === true && { exactTag: true }),
    ...(opts.untagged === true && { untagged: true }),
    ...(opts.directUntagged === true && { directUntagged: true }),
  };
}

/** The invocation-echo fragments for the tag flags (one `--tag <ref>` per ref). */
export function tagInvocationParts(opts: TagFlags): Array<string | false> {
  return [
    ...(opts.tag ?? []).map((t) => `--tag ${shellQuote(t)}`),
    ...(opts.directTag ?? []).map((t) => `--direct-tag ${shellQuote(t)}`),
    opts.exactTag === true && "--exact-tag",
    opts.untagged === true && "--untagged",
    opts.directUntagged === true && "--direct-untagged",
  ];
}
