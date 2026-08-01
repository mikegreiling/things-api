# Move and reorder (deep reference)

Two verbs, kept strictly apart:

- **move** changes WHAT an item belongs to — a to-do's project/area/heading, a project's area.
- **reorder** changes only the ARRANGEMENT of items already sharing a container and bucket — never membership. Unmentioned siblings keep their order.

The SKILL.md summary is enough for most calls; this page is the full contract. Exact flags always come from `things todo move --help`, `things project move --help`, and `things reorder --help` (current for the binary you invoke).

## Move — changing membership

**To-dos** (`things todo move <refs…> [destination] [position]`, one destination):

- `--to-project <ref>` · `--to-heading <sel>` · `--to-area <ref>` — place into a container.
- Detach family: `--no-heading` (leave the heading, stay in the project) · `--loose` (leave heading, project, AND area) · `--inbox` (back to the Inbox — this also DROPS the schedule).
- There is no `--detach` (removed) and no `--no-area` on a to-do — a to-do's area is inherited, so use `--loose`.

**Projects** (`things project move <refs…> [--to-area <ref> | --no-area] [position]`): `--no-area` is a project's detach (the to-do word `--loose` is refused on a project).

**`--to-heading` scoping.** A heading selector (exact title or uuid) resolves within the movees' shared project; when the movees are not already all in that project, name it with `--to-project`. A heading belongs to one project and cannot hold projects.

## Reorder — changing arrangement

`things reorder <refs…> [--first | --last | --before <ref> | --after <ref>] [--in <target>]` is the ONE kind-neutral in-place verb (it replaced the old `todo reorder` subcommand and the raw `reorder --scope`). It rearranges to-dos AND the project rows the Today/Evening/day lists intermix with them.

- **Bare (no position)**: the named items assemble as ONE block at the EARLIEST one's current slot, in argument order (`--first` is NOT implied). Partial selection is fine — unmentioned siblings keep their order.
- **Positioned**: `--first`/`--last` send the block to the top/bottom of its bucket; `--before <ref>`/`--after <ref>` place it relative to an anchor.
- **Selection order = landing order** (reverse by naming the refs backwards).
- **Mixed to-do + project refs are allowed** in the Today/Evening/day buckets those kinds share; elsewhere reorder operates within one container+bucket.

Sibling verbs for the two things `reorder` does NOT touch: `things project move-heading` reorders a project's HEADINGS; `things area reorder` reorders the sidebar AREAS.

## Anchors POSITION, never MIGRATE

A `--before`/`--after` anchor only says WHERE in a bucket — it never moves the anchor and never reschedules a movee to reach it. The anchor must already sit in the movees' container+bucket; a cross-container or cross-bucket anchor **fails closed** with a message naming where the rows and the anchor actually are (no silent rescheduling). For a global-axis bucket (today/evening/tomorrow/a future day-group) the anchor need only share the movees' day-group, not their structural container — the app permits exactly that drag.

## The dual axis and `--in` (fail-closed)

A Today/Evening member has TWO order slots: its slot in the Today VIEW (`todayIndex`) and its slot in its own CONTAINER (`index` — a project/area/heading child, or the loose Anytime bucket). When a set (and its anchor) is coherent on BOTH axes and no `--in` is given, the reorder is REFUSED with a message naming both readings and their exact `--in` spellings — this replaces any silent always-Today guess.

- `--in` accepts `today | evening | anytime | someday | inbox`, or a project/area/heading ref (uuid or unique title). `loose` is refused (it is a read view, not a bucket).
- Forcing the container index axis on a Today/Evening member PRESERVES the Today/Evening flag — a flag-safe move protocol routes it off the de-Today path. Only the someday/inbox loose axes still refuse a flagged member (their re-entry cannot preserve the flag).

## Mixed-stage move placement

A `move` selection spanning stage sub-buckets (anytime + scheduled + someday + templates):

- `--before`/`--after` is REFUSED unless every movee shares the anchor's sub-bucket (remediation: split the call, or drop the anchor).
- `--first`/`--last` apply PER sub-bucket — each stage-group lands at the top/bottom of ITS matching bucket in the destination, and the result note states every group's placement outcome.

## Gates, caps, and automatic fallbacks

Three config knobs (`things config get/set …`) tune ordering; every default gives full sortability:

- **`allow-experimental`** (default `true`) — enables the private NATIVE re-rank command for the scopes only it can reach directly (`inbox`, `someday`, a project's unheaded children, an area's members, a container's same-day children, `tomorrow`). It is the off-switch, not an opt-in.
- **`bounce-enabled`** (default `true`) — permits the verified `when=`/move round-trip protocols the other scopes use. `false` REFUSES a bounce-dependent placement rather than degrading destructively.
- **`bounce-max-items`** (default `30`) — caps how many items one bounce may touch; a set larger than the cap is refused, not truncated.

**Automatic non-experimental fallbacks (SIT7).** When `allow-experimental` is off (or the native surface is unavailable), the native-only scopes DO NOT fail — each degrades to a proven, verified, flag-safe move protocol (park-and-re-home for `inbox`/`project`/`area`, a `when=` bounce for `someday` and day-groups). Collateral is preserved (Today/Evening flag, live reminder, deadline, container FKs). The result's `warnings` note discloses which fallback ran (e.g. "reordered via the non-experimental PROJROOT fallback because the native reorder is unavailable") — a native placement is never silently mistaken for a degraded one.

**Flag-aware routing (SIT6).** A reorder touching a Today/Evening-FLAGGED row never de-Todays it: the whole touched set swaps to a flag-safe MOVE protocol on the same axis (the `when=` bounce would strip the flag). This is transparent — you still call `things reorder`; the chosen strategy is disclosed in the result.

## Placement guarantees and the one dead class

"Top of bucket in selection order" is GUARANTEED wherever a lab-clean protocol exists: loose inbox/today/evening/someday/anytime; a project's or area's members (anytime AND someday); a heading's anytime/someday children; any container child's evening slot; area-less someday/anytime projects; and a whole future day-group across containers (including scheduled project rows, area'd ones too). The result's placement class names which guarantee you got, and a bounce that co-touches unnamed siblings to honor a `--before`/`--after` anchor lists them.

**The one class that cannot be reordered is a repeating TEMPLATE** — a dated `when=` leg crashes it, so a template movee or anchor is refused and template placement stays app-default (disclosed). Everything non-template is sortable.

## MCP parity

The MCP server exposes reorder as two tools: **`reorder`** (the planner form — `refs`, an optional position, an optional `in` axis) mirrors `things reorder`, and **`reorder_areas`** mirrors `things area reorder` (sidebar areas, with the same two-key GUI gate). Both call the same library entries the CLI does, so the dual-axis refusal, the flag-safe routing, and the automatic fallbacks behave identically.
