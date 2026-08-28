/**
 * The mutation-result DISCLOSURE REGISTRY — the single place every non-fatal
 * thing a successful write can tell its caller is enumerated and TIERED (#632).
 *
 * Field feedback (M1, v0.19.3): a successful `make-repeating` handed back ~10
 * flat `warnings` strings — the app-drive play-by-play, the mechanism
 * disclosure, the landed-rule prose, hints and caveats, all in one undifferentiated
 * array, then echoed AGAIN as stderr `warning:` lines after the JSON. An agent
 * reading that cannot tell "you should probably do something" from "here is what
 * happened", and pays context for both twice. So:
 *
 *  - `warning` — ACTIONABLE. The caller should consider doing something: a
 *    placement that needs a follow-up reorder, a series that will now spawn, an
 *    ambiguity worth re-reading, a consent prompt to expect. If nothing follows
 *    from a line, it is not a warning.
 *  - `note` — a matter-of-fact DISCLOSURE. What landed, how it was applied, what
 *    `undo` will and will not reach. Informative, never a call to action.
 *  - `failure-only` — diagnostic detail that earns its place only when something
 *    went wrong. It never rides a success result's arrays; it is recorded on the
 *    change-history record (retrievable with `things op-result`), it rides the
 *    failure detail, and `--verbose` opts a success back into it.
 *
 * The registry IS the classification law: `DisclosureId` is derived from it, so
 * a new disclosure cannot be emitted without an explicit tier and rationale, and
 * `test/unit/disclosure-tiers.test.ts` enforces that every producer routes
 * through {@link disclose} rather than pushing a bare string.
 */

export type DisclosureTier = "warning" | "note" | "failure-only";

export interface DisclosureSpec {
  tier: DisclosureTier;
  /** Why THIS tier — the rationale that keeps the classification from drifting. */
  why: string;
}

/**
 * Every disclosure a mutation result can carry, with its tier and the reason for
 * it. Adding a producer means adding an entry here first — that is the point.
 */
export const DISCLOSURES = {
  // ---------------------------------------------------------------- pipeline
  "auto-launch": {
    tier: "note",
    why: "a side effect worth stating, but the write already succeeded — nothing follows for the caller",
  },
  "template-delete-series-stops": {
    tier: "warning",
    why: "the caller asked to delete one item and stopped a whole series; they may want to re-create it",
  },
  "template-delete-occurrences-left": {
    tier: "warning",
    why: "rows the caller did not name are still live and now orphaned — theirs to clean up or keep",
  },
  "template-delete-irreversible": {
    tier: "warning",
    why: "`things undo` will refuse this one; recovery needs a manual step in the app",
  },
  "transport-recovered": {
    tier: "warning",
    why: "it exists to stop a retry the caller would otherwise make — the most actionable line we emit",
  },
  "environment-changed": {
    tier: "warning",
    why: "a macOS consent prompt may appear on the next capability use; the caller should be at the keyboard",
  },
  "ui-mechanism": {
    tier: "note",
    why: "how the change was applied — compressed to a few words; `vector`/`tier` carry it structurally anyway",
  },
  "ui-step-trace": {
    tier: "failure-only",
    why: "the drive play-by-play made the field bug reports rich, and costs context on every success; the change-history record keeps it, `--verbose` opts back in, failures always carry it",
  },
  "ui-recipe-uncertified": {
    tier: "note",
    why: "a lab-certification caveat about the recipe, not about this result — nothing to act on",
  },
  "already-in-state": {
    tier: "note",
    why: "the requested state is the state — the caller got what they asked for and nothing follows",
  },

  // ----------------------------------------------------------------- heading
  "heading-placement-failed": {
    tier: "warning",
    why: "the heading landed somewhere the caller did not ask for; a follow-up move is needed",
  },

  // ------------------------------------------------------------------- clone
  "clone-child-states-lost": {
    tier: "warning",
    why: "the copy is knowingly unfaithful — the caller must resolve the child states themselves if they matter",
  },
  "clone-non-atomic-legs": {
    tier: "note",
    why: "mechanism disclosure: how the copy was assembled; every leg verified or the whole thing failed",
  },
  "clone-created-date-coarse": {
    tier: "note",
    why: "a fidelity fact about what was copied; there is no finer option to choose instead",
  },

  // ------------------------------------------------------------ idempotency
  "reconciled-replay": {
    tier: "note",
    why: "the undo pointer for a replayed key — states what `undo` cannot reach, which is disclosure, not a task",
  },

  // ---------------------------------------------------------------- reorder
  "reorder-fallback": {
    tier: "note",
    why: "mechanism disclosure: the placement was realized a different way, and it did land as asked",
  },
  "reorder-today-cohort-restamp": {
    tier: "warning",
    why: "rows the caller never named had their Today grouping changed — collateral they may need to inspect",
  },
  "reorder-templates-silent": {
    tier: "warning",
    why: "a change-date-diffing sync or watcher will MISS this move; a caller relying on one must reconcile another way",
  },
  "reorder-templates-unmoved": {
    tier: "warning",
    why: "part of the requested placement did not happen — the caller's order is not what they asked for",
  },
  "reorder-scratch-cleaned": {
    tier: "note",
    why: "mechanism disclosure: a throwaway container was used to realize the placement, and it is gone again",
  },
  "reorder-scratch-orphaned": {
    tier: "warning",
    why: "an empty container is sitting in the caller's sidebar/project list and only they can remove it",
  },

  // ------------------------------------------------------- promote (repeat)
  "landed-rule": {
    tier: "note",
    why: "the plain-language echo of what landed; the request was honored, so there is nothing to do",
  },
  "promote-source-trashed": {
    tier: "note",
    why: "an undo pointer — where the original went and what reverses it",
  },
  "promote-placement": {
    tier: "warning",
    why: "the new occurrence sits at a default position and the prior slot was NOT restored — it names the reorder to run",
  },
  "promote-duplicate-trashed": {
    tier: "note",
    why: "the compound already removed the redundant occurrence; the caller is told, not asked",
  },
  "promote-duplicate-orphaned": {
    tier: "warning",
    why: "the redundant occurrence is still there and WILL double-book — it names the delete to run",
  },
  "promote-off-rule-first": {
    tier: "warning",
    why: "the series landed two-phase (a first occurrence off its own rule) — the caller may want to correct it",
  },
  "template-clone-new-series": {
    tier: "note",
    why: "an identity disclosure about what was minted; nothing follows unless the caller assumed otherwise",
  },
  "template-clone-created-best-effort": {
    tier: "note",
    why: "a fidelity caveat about a flag that was honored as far as it goes",
  },
  "template-clone-source-paused": {
    tier: "warning",
    why: "the new series is spawning although the source was suspended — it names the pause to run",
  },

  // --------------------------------------------------- resolution timestamps
  "resolution-non-atomic-legs": {
    tier: "note",
    why: "mechanism disclosure, same class as the clone leg list",
  },

  // ---------------------------------------------- template-target composites
  "occurrence-resolved": {
    tier: "note",
    why: "which occurrence was written and whether it was created for the call — a statement of what happened",
  },
  "occurrence-next": {
    tier: "note",
    why: "when the series comes back; matter-of-fact, and the caller asked for exactly this",
  },
  "occurrence-mint-irreversible": {
    tier: "note",
    why: "an undo pointer: what `undo` restores and what it cannot un-create",
  },
  "occurrence-exception-scope": {
    tier: "note",
    why: "states that the series itself is untouched — a scope disclosure, not a task",
  },

  // -------------------------------------------- instance derivation (#634)
  "instance-pending": {
    tier: "note",
    why: "the expectation MET: this rule shape is not supposed to have an occurrence yet, so it is a fact, not a surprise",
  },
  "instance-missing": {
    tier: "warning",
    why: "the expectation MISSED: the app should have materialized an occurrence and did not — the series may be wrong",
  },
  "instance-unexpected": {
    tier: "warning",
    why: "the expectation MISSED the other way: an occurrence exists that the measured laws say should not — worth a look",
  },
  "instance-ambiguous": {
    tier: "warning",
    why: "several rows link back to the template and we picked one — the caller should confirm which occurrence they hold",
  },
  "promote-source-unlinked": {
    tier: "warning",
    why: "an unexpected post-op state: the original survived without joining the series — the caller should re-read both",
  },
} as const satisfies Record<string, DisclosureSpec>;

/** Every classified disclosure. The registry is the union — no unclassified ids exist. */
export type DisclosureId = keyof typeof DISCLOSURES;

/** The ids of a given tier, derived from the registry (single source of truth). */
type IdsOfTier<T extends DisclosureTier> = {
  [K in DisclosureId]: (typeof DISCLOSURES)[K]["tier"] extends T ? K : never;
}[DisclosureId];

export type WarningDisclosureId = IdsOfTier<"warning">;
export type NoteDisclosureId = IdsOfTier<"note">;
export type FailureOnlyDisclosureId = IdsOfTier<"failure-only">;

/** The ids a SUCCESS result may carry — `failure-only` is excluded at compile time. */
export type SuccessDisclosureId = Exclude<DisclosureId, FailureOnlyDisclosureId>;

/**
 * The two tiers a successful mutation result carries, in the order they were
 * disclosed. Empty arrays are dropped at the wire boundary ({@link attach}).
 */
export interface Disclosures {
  warnings: string[];
  notes: string[];
}

/** A fresh, empty pair of tiers. */
export function newDisclosures(): Disclosures {
  return { warnings: [], notes: [] };
}

/**
 * Record one disclosure under its registered tier. The id is compile-time
 * checked against the registry, so the tier is never decided at the call site —
 * which is what makes the classification auditable in one file.
 */
export function disclose(bag: Disclosures, id: SuccessDisclosureId, text: string): void {
  if (text === "") return;
  const spec: DisclosureSpec = DISCLOSURES[id];
  if (spec.tier === "warning") bag.warnings.push(text);
  else bag.notes.push(text);
}

/** {@link disclose} for a producer that yields several lines under one id. */
export function discloseAll(
  bag: Disclosures,
  id: SuccessDisclosureId,
  texts: readonly string[],
): void {
  for (const text of texts) disclose(bag, id, text);
}

/**
 * Fold an inner result's already-tiered disclosures into an outer bag. Compound
 * orchestrators (clone→promote, composites, replays) build their result on top
 * of a leg's — the leg's classification is already made, so it is CARRIED, never
 * reclassified.
 */
export function carry(
  bag: Disclosures,
  from: { warnings?: readonly string[]; notes?: readonly string[] } | undefined,
): void {
  if (from === undefined) return;
  bag.warnings.push(...(from.warnings ?? []));
  bag.notes.push(...(from.notes ?? []));
}

/**
 * The two tiers as a SPREADABLE fragment, omitting each EMPTY array (the
 * omit-when-empty wire policy: an absent key means "none", and neither tier ever
 * appears as `[]`). For building a result literal in place; {@link attach} wraps
 * an already-built one.
 */
export function tiers(bag: Disclosures): { warnings?: string[]; notes?: string[] } {
  return {
    ...(bag.warnings.length > 0 && { warnings: bag.warnings }),
    ...(bag.notes.length > 0 && { notes: bag.notes }),
  };
}

/**
 * Project the tiers onto an existing result object (see {@link tiers}). Both
 * keys are REPLACED, so folding a leg's result into an outer one cannot leave a
 * stale array behind.
 */
export function attach<T extends object>(
  result: T,
  bag: Disclosures,
): T & { warnings?: string[]; notes?: string[] } {
  const {
    warnings: _w,
    notes: _n,
    ...rest
  } = result as T & {
    warnings?: string[];
    notes?: string[];
  };
  return { ...(rest as T), ...tiers(bag) };
}

/** The tiers already on a result, as a bag the caller can add to. */
export function disclosuresOf(from: {
  warnings?: readonly string[];
  notes?: readonly string[];
}): Disclosures {
  const bag = newDisclosures();
  carry(bag, from);
  return bag;
}
