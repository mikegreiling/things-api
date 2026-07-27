# Heading demotion & the move/reorder vocabulary — ratified design

**Status: RATIFIED (design round with Mike, 2026-07-25 → 2026-07-27). This document is the canonical spec for implementation Phase A.** It supersedes the exploratory sketches in the up-next §6 heading-demotion and sort-ergonomics items (both now point here). The ALPHA-CONTRACT doctrine (AGENTS.md, architecture.md) applies to every change in this plan: the old spellings are removed outright — no aliases, no shims, no legacy readers.

Inputs the round weighed: Mike's GPT-5.6 clean-room CLI thought experiment; the multi-model replication study ([cli-vocabulary-study.md](cli-vocabulary-study.md) — five unanimous vocabulary elements, one non-replication, the unanimous reindex-hazard warning); the lab's ordering verdicts (O06, O14, P6h/P8b anchor-stack protocols, P8e bounce, scf P1 heading reorder); the shipped `projectView` grouping code; and the maintainer's live-GUI observations of 2026-07-27 (bucket rendering inside headings, resting-template drag behavior, mixed-selection drag semantics — described throughout in synthetic terms).

## 1. The containment & ordering model (ratified facts)

Everything below follows from a small set of facts the round pinned down; the vocabulary is honest to this model and to the wire protocols underneath it.

- **Headings PARTITION a project; they never interleave with unheaded to-dos.** A project's children split into the unheaded block (always rendered first) followed by heading groups. There is no way to place an unheaded to-do between two headings; for anything to sit "between" headings it must be a member of one. (Confirmed in the GUI and in `src/read/project-view.ts`, which models exactly this partition. This falsifies the "intermixed top-level sequence" framing from the earlier study rounds.)
- **Heading membership is an FK, not a position**, and heading reorder moves the children with the heading (scf P1, "children follow their heading").
- **Every section (unheaded block, and EACH heading group) carries its own display sub-buckets**, mirroring the GUI: the anytime/active sequence, then dated scheduled items grouped per day, then resting repeating templates, then someday items. Live-GUI confirmation 2026-07-27 (maintainer screenshots): scheduled to-dos, repeating templates, AND someday to-dos all render *inside their heading's section*, not pooled at the project level. Our shipped `projectView` pools someday/scheduled/repeating children into project-level buckets regardless of heading FK — that is a **read-side fidelity defect**, fixed as part of the 1.0 contract shape work (§9).
- **Ordering buckets.** Within any section, items sort only *within their bucket*: the anytime bucket; ONE bucket per scheduled DAY (all items dated the same day sort among themselves — the within-day key is `todayIndex`, shared with the Upcoming view: reordering there reorders here); the resting-template sub-bucket (waiting/paused/ended — see oddities §9e: the GUI itself cannot interleave these by drag); and the someday bucket. Cross-bucket "order" does not exist, and the vocabulary never pretends it does.
- **Mixed-selection drag in the GUI** (the parity oracle for `move`): a selection spanning buckets can be dropped INTO a container (project/heading/area) but cannot target a position; each dropped item lands at the TOP of its own bucket in the destination.
- **Homogeneous kinds on the wire.** The native area-scope reorder handles to-dos OR projects, never mixed in one call (O14). The vocabulary adopts the same rule rather than papering over it.

## 2. Heading demotion — project-scoped verbs

A heading exists only inside a project; the grammar now says so. The `things heading …` namespace is REMOVED (no aliases). Operations move under `project`, with op kinds renamed to match:

| Op kind | CLI | Notes |
|---|---|---|
| `project.add-heading` | `things project add-heading <project-ref> "Title" [--first\|--last\|--before-heading <sel>\|--after-heading <sel>]` | was `heading.add`; gains positional placement among the project's headings |
| `project.rename-heading` | `things project rename-heading <project-ref> <heading-sel> --to "New title"` | was `heading.rename` (the deferred rename question resolves here) |
| `project.archive-heading` / `project.unarchive-heading` | `things project archive-heading <project-ref> <heading-sel>` | was `heading.archive`/`heading.unarchive` |
| `project.promote-heading` | `things project promote-heading <project-ref> <heading-sel>` | was `heading.convert-to-project`; identity replacement + ui-vector gating unchanged, certification evidence (HEADCERT1) carries over |
| `project.move-heading` | `things project move-heading <project-ref> <heading-sel> --first\|--last\|--before-heading <sel>\|--after-heading <sel>` | replaces `reorder --scope headings`; homogeneous heading list, children follow |

**Heading selectors (`<heading-sel>`): exact title, or uuid.** The rules, with their justifications:

- **NO ordinal/index addressing.** All four clean-room model runs independently warned that an index silently re-targets a *different heading* after any reorder (the "reindex hazard") — and `move-heading` makes heading reorder routine. The checklist-model `--index` escape hatch deliberately does NOT transfer to headings.
- **Duplicate titles fail closed with uuid candidates.** The app happily creates same-titled headings, so uniqueness is a resolution *precondition*, not an invariant (the `H-DUPLICATE-TAG` precedent). The candidate list must carry something stable — with index banned, that can only be the uuid.
- **Empty-string titles are legal literal queries.** The app creates titleless headings (and projects, and to-dos), rendering placeholder text. `--heading ""` resolves records whose title is empty, same unique-or-fail-closed rule; ambiguity again disambiguates by uuid. (Flags-only for this case; positional empty args are shell-fumble-prone.)
- **uuids stay in READ payloads and remain valid selectors everywhere.** Three independent reasons ratified: duplicate-title disambiguation needs them; script robustness across renames (the strongest counter-position in the study — answered at zero cost by keeping them); titleless records may have no other handle. Writes *teach* project+title; uuid is the quiet escape hatch. The TTY may de-emphasize heading uuids cosmetically; JSON keeps them.

**Cross-project heading move is a first-class GUI drag with NO automation spelling on any vector.** Flagged as a 🧪 wish-list row (capability matrix, Ordering/heading rows) and a low-priority probe (HEADXPROJ, AX-drag family). Until then: `unsupported`, stated honestly.

MCP: the `heading` multiplexer tool's actions respell to match the new op kinds; project param required; heading-sel semantics identical.

## 3. Bulk titles-only creation

The quick-skeleton path, distinct from (and compiled onto) the batch machinery:

- **Variadic `todo add`**: `things todo add "T1" "T2" "T3" --project X [--when someday …]` — every shared flag applies to each title. Plus `--stdin` (newline-delimited titles) and `--id-only` (uuid-per-line output for shell chaining — a study convergent).
- **Implementation = a batch under the hood**: one batch txn, per-item results, ONE `undoToken` that removes the whole skeleton. No second creation pipeline exists.
- **`project add --todo` (repeatable) already ships** and is the documented skeleton path for new-project-with-children; the docs sweep makes it discoverable.
- Positioning vs `batch`: batch = rich per-item metadata + temp_id cross-references; variadic add = shared-flags skeleton, refine later. Two entry points, one machinery.

## 4. The `move` / `reorder` vocabulary

**No top-level generic `move`.** Genericity across movee kinds is where incoherence lives (mixed selections have no cross-kind order; kinds have different legal destinations; the wire itself refuses mixed kinds, O14). Noun-scoped verbs, extended:

- `things todo move <ref…> [destination] [position]` — variadic; destinations `--to-project <ref>` / `--to-heading <sel>` / `--to-area <ref>` / the detach family (§5). A `--to-heading` selector resolves within `--to-project`'s project when that flag is present; otherwise within the movees' current shared project; if the movees span projects and no `--to-project` is given, fail closed asking for it; positions `--first | --last | --before <todo-ref> | --after <todo-ref>`.
- `things todo reorder <ref…> --first|--last|--before <ref>|--after <ref>` — pure positioning within the movees' CURRENT shared container+bucket; **fail-closed if the movees span containers or the anchor lives elsewhere** (the unanimous cross-container guard).
- `things project move <ref…> --to-area <ref>|--no-area [--first|--last|--before <project>|--after <project>]` — existing op, gains the anchor grammar AND variadic movees.
- `things project move-heading <project-ref> <heading-sel…> …` — §2, variadic.

**Variadic movees generalize to ALL kinds — homogeneity means one KIND per command, not one item per command.** `project move` accepts multiple projects as an ordered block (an area's project population buckets into anytime/scheduled/someday exactly like to-dos, so the GUI-parity rules below apply unchanged); `project move-heading` accepts multiple headings as an ordered block within their project. Per-item wire legs and the existing per-scope caps apply the same as for to-dos. The homogeneity rule (rule 3) forbids MIXING kinds in one call — it never limits how many refs of the one kind a call takes.

**Core rules (ratified):**

1. **Selection order = destination block order.** The argument order of the movees is the order they land in (per bucket — see rule 4). Reversal costs nothing: name them backwards.
2. **Anchors may POSITION, never MIGRATE.** An anchor-implied destination is legal only when it changes no movee's membership (pure repositioning among items already sharing the anchor's container). Any container-crossing move requires the explicit destination flag. `todo move T4 T5 --after T1` works when all three share a container; when they don't, it fails closed naming the anchor's container and the flag to say if you mean it. The silent de-project/de-area footgun is structurally impossible.
3. **Homogeneous movee kinds.** Mixed uuid kinds in one call = immediate usage error (the wire's own rule, O14).
4. **Mixed-bucket semantics = GUI parity.** Membership moves (destination flag, no `--before`/`--after`) are ALWAYS legal for a mixed-bucket selection: each movee lands in its own bucket at the destination, at the TOP of that bucket, preserving the selection's relative order within each bucket — exactly what dragging a mixed selection does. `--first`/`--last` are bucket-relative and apply PER BUCKET. `--before`/`--after` anchors are the one genuinely incoherent case: ALL movees must share the anchor's bucket, else fail closed with an error naming which movees sit in which bucket (anchoring a someday item after an anytime item has no honest meaning short of silently rescheduling it, which we never do).
5. **Placement honesty.** "Top of bucket in selection order" is guaranteed where a reorder protocol exists for the destination bucket (project/area/today/evening/someday/inbox scopes — the lab-locked set), and app-default placement with an explicit note in the result where none does (unprobed in-project bucket cases; scheduled day-buckets until DAYORD lands). The result payload states which you got. No silent pretending.
6. **Compilation.** Both verbs compile onto the existing lab-locked wire protocols (native re-rank, anchor-stack two-call, bounce) through a minimal-move planner: fewest wire legs for the requested placement, per-scope caps and the bounce abort-honesty model apply per leg.

**Bare invocations (ratified 2026-07-27).** With a destination flag and no position, `--first` is effectively implied per bucket (rule 4's GUI parity — dropped items land at the top of their bucket in selection order). With NEITHER destination NOR position: **bare `todo move` is a teaching usage error** ("no destination and no position — use `todo reorder` to fix order in place, or add `--to-…`/`--first`/`--after`"); `move` never mutates unless a destination or position was named. **Bare `todo reorder <ref…>` IS legal**, with a deterministic in-place default: the block assembles **at the earliest movee's current slot**, in argument order — "fix the relative order, displace nothing farther than necessary." `--first` is deliberately NOT implied (silently yanking a selection to the top of its bucket is the surprise-displacement class this vocabulary exists to prevent; the flag is one keystroke away when meant). Preconditions for the bare form: all movees in ONE container and ONE bucket, else fail closed listing who is where. Note the corollary worth teaching loudly: `reorder` does NOT require enumerating the whole bucket — unmentioned siblings keep their order and the block lands relative to them. **Phase A documentation deliverable: the help topics AND the agent skill must teach the move-vs-reorder distinction explicitly** (move = membership somewhere; reorder = arrangement in place, earliest-slot anchored, partial-selection-friendly) — ratified after the maintainer noted the distinction was not inferable from the verb names alone.

**Day-bucket reorder is out of scope until DAYORD** (probe-backlog): each scheduled DAY is a sortable bucket keyed on `todayIndex` (shared with Upcoming — reordering there is the same index), but no current write scope addresses a future day. If DAYORD lands a spelling, day buckets join rule 5's guaranteed set with zero vocabulary change.

## 5. The detach family — `--detach` is removed

The single `--detach` flag ("remove ALL container links keeping the schedule") conflated three different intents and is REMOVED (no alias). The replacement family follows one law: **one spelling per kind, no synonyms** — a kind with a single containment level gets its one precise `--no-*` flag; the multi-level kind (to-dos) gets one total-sever word plus one single-level flag; nothing overlaps.

| Flag | Applies to | Meaning |
|---|---|---|
| `--no-heading` | to-dos ONLY | leave the heading; stay in the project (land in the unheaded block, top of bucket) |
| `--loose` | to-dos ONLY | the total sever: leave heading, project, AND area — become a fully loose, containerless to-do. Want it in an area instead? That is not a detach, it is a move: say `--to-area <ref>` |
| `--no-area` | projects ONLY | leave the area — the project's complete (single-level) detach |

**No synonym spellings exist.** `--loose` on a project is a usage error pointing at `--no-area` (a project has one containment level; the total-sever word would be a duplicate spelling). `--no-area` on a to-do is a usage error in both of its cases: on a project child it fails closed with the inherited-area explanation ("its area comes from its project; use `--loose` to leave the project, or move the project"); on a direct-area loose to-do it fails closed pointing at `--loose` (which is exactly area removal for a to-do with no project — a second spelling would drift). There is no `--no-project`: leaving the project is either `--loose` (sever) or a `--to-*` destination (move). Every one of these refusals is a teaching error naming the correct spelling (§7).

## 6. `project set-layout` — Phase B

The one home where strict full-order declaration earns its keep (it did NOT replicate as a general `reorder` semantic in the study, and as a *partial* operation it breaks "the result contains what you typed where you typed it" the moment an unmentioned resident exists):

`things project set-layout <ref> T1 H1 T2 T3 H2 T4 …` — a DECLARATIVE full layout: every active child and every heading exactly once, headings claiming the to-dos that follow them, unheaded block first (the partition rule makes the flat list unambiguous). Any omission, duplicate, or foreign uuid fails closed before any leg dispatches. Compiled to minimal move/reorder legs. Scope: the ACTIVE sequences only (scheduled/someday/resting buckets keep their own order; a layout call neither reads nor rewrites them). Subsumes swap-contents, bulk restructuring, and the agent-native "make the project look like this" reconciliation.

## 7. Refusal matrix

Every refusal is specific — code family, exact copy naming the offender, candidates where resolution failed. No generic "invalid move."

| Situation | Outcome |
|---|---|
| Mixed movee kinds in one call (to-do + project/heading uuids) | `usage` — homogeneous kinds required; names the offending refs and their kinds |
| Illegal destination for kind (project → project, heading → heading, project → heading, …) | `usage` — states the containment rule violated |
| Anchor outside the movees' container on `reorder` / anchor-only `move` | `blocked` — names the anchor's actual container; points at the explicit destination flags |
| `--before`/`--after` with movees outside the anchor's bucket | `blocked` — lists each movee's bucket; suggests per-bucket `--first`/`--last` or split commands |
| Cross-project heading move | `unsupported` — no vector speaks it (GUI-only); cites the wish-list row |
| `--no-area` on a PROJECT CHILD to-do | `usage` — inherited-area guard: "its area comes from its project; use `--loose` or move the project" (§5) |
| `--no-area` on a DIRECT-AREA loose to-do | `usage` — teaching error: for a to-do this is `--loose` (no duplicate spellings) |
| `--loose` on a project | `usage` — teaching error: a project's detach is `--no-area` (single containment level) |
| `--detach` (removed flag) | `usage` — names the replacement family |
| Heading-sel ambiguity (duplicate or empty titles) | resolution error with uuid-bearing candidates |
| Per-scope caps / protocol limits (e.g. bounce ≤10) | existing cap errors, unchanged |
| Bare `todo move` (no destination, no position) | `usage` — teaching error: "use `todo reorder` to fix order in place, or add `--to-…`/`--first`/`--after`" |
| Bare `todo reorder` with movees spanning containers or buckets | `blocked` — lists each movee's container/bucket; the bare in-place form requires one container + one bucket |
| `set-layout` list ≠ exactly the active children + headings | `usage` — lists missing/extra/duplicated refs |

## 8. Phases

- **Phase A (next implementation arc):** the §2 demotion verbs; §3 bulk creation; §4 `todo move`/`todo reorder` + `project move` anchors over the existing protocols (today/evening/someday/inbox/project/area containers); §5 detach family; the refusal matrix; MCP mirrors. This supersedes the up-next sort-ergonomics item (anchor ergonomics for project/area/today were its asks; they are Phase A scope).
- **Phase B:** `project set-layout`; retiring the old `reorder --scope` spellings once Phase A parity is proven; view-order polish. Candidate, unratified: a `sort --by <key>` convenience (deadline/title/created) computing the permutation server-side — parked from the old ergonomics item, decide during Phase B.
- **Externally gated:** day-bucket reorder (DAYORD probe); cross-project heading move (HEADXPROJ probe, low priority).

## 9. Read-side: the heading sub-bucket fidelity fix (1.0 shape work)

`projectView` currently pools someday/scheduled/repeating children into project-level buckets regardless of heading FK; the GUI nests them under their headings (§1). As part of the 1.0 contract shape work (the ratified shape break, see up-next §0½ item 3), heading groups gain their own sub-buckets — `{heading, items, scheduled, someday, repeating}` — and the project-level buckets retain only UNHEADED members. This supersedes the earlier flatten-`later` sketch *for heading children* (the flatten rule itself stands: every named field an array, date-groups the only intermediate nesting — now applied at both the project level and inside each heading group). The v2 response-explorer samples update when this lands.

## 10. Naming: there is no v2

Ratified: everything pre-1.0 is alpha; the contract that ships with package v1.0 IS API v1. The `apiVersion` envelope field keeps its value (`1`); the shape break formerly discussed as "apiVersion 2" is now "the 1.0 contract" throughout. Release shape: Phase A + the 1.0 contract shape work (including §9) land → publish 1.0 → the ALPHA-CONTRACT doctrine is removed per its own instructions.
