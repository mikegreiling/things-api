# NOTECAP1 — the content-field ceilings: notes, titles, names, checklist counts

**Probed under:** `things-lab-golden-v4` · **Things 3.23** (build 32300036) · macOS 15.7.7 · dbv27 · pinned clock **2026-07-05** (the trial wall is 2026-07-18; this campaign never rolls the clock) · 2026-08-27.
**Driver:** [`lab/scripts/research-notecap1.sh`](../../lab/scripts/research-notecap1.sh) + [`lab/scripts/notecap1-nc.py`](../../lab/scripts/notecap1-nc.py) (`setup` / `run` / `teardown`; `SKIP_P1=1` and `P3=1` select the later phases).
**Beep sentinel:** ON, report-only. **Zero alert beeps** across all five phases (62 + 91 + 15 + 13 + 4 marks).
**Payloads:** fully synthetic — cycling digits, U+1F600, `e`+U+0301, a regional-indicator pair, an emoji + skin-tone modifier, a four-person ZWJ family, CR LF.

Occasioned by [#621](https://github.com/mikegreiling/things-api/issues/621): a notes body a little over 10,000 characters was accepted by Things as a prefix cut mid-word. The mutation half-landed and the CLI could say only `verify-failed:mismatch`.

---

## 0. The law, in one place

| Field class | Ceiling | Unit | Where the ceiling lives | Over-limit behavior |
|---|---|---|---|---|
| **notes** (`notes`, `append-notes`, `prepend-notes`) | **10,000** *and* **40,000**, whichever binds first | grapheme clusters / UTF-16 code units | the **URL scheme** — AppleScript has none | stored as a prefix; the row is still created/mutated |
| **titles and names** (to-do, project, heading, checklist item, area, tag) | **4,000** | UTF-16 code units | the **app's model** — same through AppleScript | stored as a prefix; the row is still created/mutated |
| **checklist items per dispatch** | **100** | items | the app — same on `add`, `update` and `things:///json` | the first 100 are created, the rest never exist |

Two things that are NOT ceilings: there is **no URL-length limit** below 1,000,100 characters, and the notes ceiling is **per parameter value**, not per resulting field.

---

## 1. The notes ceiling belongs to the URL scheme, not to Things

The campaign opened against AppleScript, on the assumption the ~10,000 boundary was a property of the app or the column. It is not. `set notes of to do id …` stores everything it is handed:

| AS-* cell | payload | requested | landed |
|---|---|---|---|
| AS-ASCII | 15,000 digits | 15,013 scalars / 15,013 bytes | **INTACT** |
| AS-EMOJI | 15,000 × U+1F600 | 15,013 scalars / 60,013 bytes | **INTACT** |
| AS-COMB | 15,000 × `e`+U+0301 | 30,012 scalars / 45,012 bytes | **INTACT** |

A binary search from 9,000 to 12,000 found no cut in any of the three classes. So the database column is not the constraint and neither is the app's notes model — the ~10,000 boundary is a property of the **URL scheme's parameter handling**.

That matters because it is nonetheless the ceiling every caller of this package meets: every notes-carrying operation compiles to the URL scheme and refuses any other vector (`src/write/commands.ts`, eleven `if (vector !== "url-scheme") unsupportedVector(…)` sites). The AppleScript matrix *declares* `todo.add` / `todo.update` support, but no command spec can compile them, so the roomy vector is unreachable today.

## 2. The unit is the GRAPHEME CLUSTER — 10,000 of them

Three payload classes with different byte : scalar : UTF-16 : cluster ratios pin the unit uniquely. Each was written over the ceiling via `things:///update?notes=` and the stored value measured with `length(notes)` (scalars) and `length(CAST(notes AS BLOB))` (bytes):

| payload | 1 cluster costs | requested | landed (scalars / bytes) | landed in clusters |
|---|---|---|---|---|
| digits | 1 B / 1 scalar / 1 unit | 15,013 clusters | 10,000 / 10,000 | **10,000** |
| U+1F600 | 4 B / 1 scalar / 2 units | 15,013 clusters | 10,000 / 39,961 | **10,000** |
| `e`+U+0301 | 3 B / 2 scalars / 2 units | 15,012 clusters | 19,988 / 29,976 | **10,000** |
| 🇺🇳 (regional-indicator pair) | 8 B / 2 scalars / 4 units | 15,012 clusters | 19,988 / 79,916 | **10,000** |
| 👍🏽 (emoji + skin-tone modifier) | 8 B / 2 scalars / 4 units | 15,012 clusters | 19,988 / 79,916 | **10,000** |

Bytes, scalars and UTF-16 units all disagree across the rows; the cluster count is 10,000 in every one.

The flag and skin-tone rows are the sharp ones. Foundation's older *composed character sequence* enumeration splits both of those into two units, while UAX #29's *extended grapheme cluster* keeps each whole — and the measurement says ONE. So the app's counting matches `Intl.Segmenter`'s, which is what makes a client-side guard possible at all.

**The boundary, exactly** (URL-BSEARCH-* and G-EXACT):

| clusters requested | landed |
|---|---|
| 9,999 | 9,999 — INTACT |
| **10,000** | 10,000 — INTACT |
| 10,001 | 10,000 — TRUNCATED |

Confirmed independently in digits (largest intact n = 9,988 + a 12-character tag), emoji (n = 9,988) and combining pairs (n = 9,989 + an 11-character tag) — each arriving at exactly 10,000 clusters from a different direction.

## 3. A SECOND ceiling: 40,000 UTF-16 code units

A ZWJ emoji family (👨‍👩‍👧‍👦) is one cluster but **eleven** UTF-16 units — the only payload class probed whose clusters are wide enough to cross a unit ceiling before the cluster ceiling. It does:

| families | clusters | UTF-16 units | landed |
|---|---|---|---|
| 3,000 | 3,011 | 33,010 | **INTACT** |
| 3,630 | 3,641 | 39,940 | **INTACT** |
| 3,636 | 3,647 | 40,006 | **TRUNCATED at exactly 40,000 units** |
| 4,000 | 4,011 | 44,010 | truncated to the same 40,000 units |

The 3,636 cell landed 25,458 scalars / 90,896 bytes — a 10-character tag plus 3,635 whole families plus 👨 + ZWJ + 👩, which is 40,000 UTF-16 units on the nose. So the notes ceiling is **min(10,000 clusters, 40,000 UTF-16 units)**, and ordinary text never meets the second one (10,000 clusters of Latin text is 10,000 units; of emoji, ~20,000).

## 4. Where the cut lands

**Cluster-safe under the cluster rule.** Every stored tail in §2 ends on a complete sequence: `…F09F9880` (a whole emoji), `…65CC81` (`e` with its combining acute intact), `…F09F87BAF09F87B3` (a whole flag). The cut never splits a scalar and never orphans a combining mark. It does cut mid-WORD, which is what makes it invisible in ordinary prose — but it is not producing invalid UTF-8, and that is deliberate engineering worth crediting (recorded in [things-app-craft.md](../things-app-craft.md)).

**Not cluster-safe under the unit rule.** The 40,000-unit cut in §3 lands *inside* a ZWJ family and leaves a dangling joiner. It is surrogate-safe (it backed off from 40,001 to 40,000 rather than split 👧), but it does not respect cluster boundaries.

**CR LF is normalized in transit.** A payload of 15,000 CR LF pairs stored 10,000 clusters of bare LF — the CRs are gone before the app stores anything, so the pair arrives as one LF rather than as one CR LF cluster.

## 5. The ceiling is per PARAMETER VALUE, not per field

This is the finding that reshapes the fix. `append-notes` sends a FRAGMENT and lets Things do the join; the ceiling applies to the fragment, and the joined result is free to exceed it:

| cell | existing notes | `append-notes` fragment | landed |
|---|---|---|---|
| V-URL-APPEND | 9,010 | 3,009 | **12,020** — the whole join, intact, well over 10,000 |
| V-URL-APPEND-XXL | 511 | 15,013 | **10,512** — the fragment cut to 10,000, then joined |

So a notes body may legitimately grow past 10,000 characters through repeated appends (and through AppleScript, §1), and a client-side guard that validated the JOIN would refuse writes the app performs correctly. **The fragment is what must be checked.**

## 6. The transport is not the constraint

| URL length dispatched | notes landed |
|---|---|
| 15,098 chars | 10,000 |
| 20,105 chars (same notes + 5,000 chars of `title` padding) | 10,000 — **the cut did not move** |
| 50,098 chars | 10,000 |
| 200,099 chars | 10,000 |
| **1,000,100 chars** | 10,000 |

`open -g` carried a 1 MB URL, exit 0, and the write landed. Padding the URL with an unrelated parameter leaves the notes cut exactly where it was, which is what makes this a FIELD ceiling rather than a URL-size one. There is nothing here for vector selection to route around.

## 7. What lands when exceeded, per vector

Every vector truncates and keeps going. Nothing is refused; nothing is rolled back. A 15,000-digit notes payload (15,013 clusters requested):

| vector | landed | row delta |
|---|---|---|
| `things:///add?notes=` | 10,000 | **+1 — the to-do is created**, holding the prefix |
| `things:///add-project?notes=` | 10,000 | **+1 — the project is created**, holding the prefix |
| `things:///update?notes=` | 10,000 | row mutated to the prefix |
| `things:///update-project?notes=` | 10,000 | row mutated to the prefix |
| `things:///json` (add) | 10,000 | **+1**, holding the prefix |
| `things:///json` (update) | 10,000 | row mutated to the prefix |
| AppleScript `set notes` | 15,013 — intact | no ceiling found |

## 8. The field-length matrix — titles and names cap at 4,000 UTF-16 units

A 15,000-digit payload written into each field, and the same fields probed at 100,000 where a vector allows it:

| field | vector | requested | landed |
|---|---|---|---|
| to-do title | `things:///add?title=` | 15,013 / 100,014 | **4,000** |
| to-do title | `things:///update?title=` | 15,013 | **4,000** |
| to-do title | AppleScript `set name` | 15,013 and 100,014 | **4,000** |
| project title | `things:///add-project?title=` | 15,013 | **4,000** |
| heading title | `things:///json` project items | 15,013 | **4,000** |
| checklist-item title | `things:///add?checklist-items=` | 15,013 | **4,000** |
| area name | AppleScript `make new area` | 15,013 and 100,014 | **4,000** |
| tag name | AppleScript `make new tag` | 15,013 and 100,014 | **4,000** |
| tag name | `things:///add?tags=` | 15,013 | **no row** — the URL scheme applies existing tags, it does not create them, so no ceiling is measurable there |

Two differences from notes, both load-bearing:

- **The unit is UTF-16 CODE UNITS, not clusters.** An emoji title cuts at 1,993 emoji — 3,999 units — not at 4,000 emoji. A combining-pair title cuts at 1,994 pairs, which is 4,000 units and only 2,006 clusters.
- **AppleScript caps identically**, so this is the app's own model rather than a transport property. There is no roomier vector for a title at any price.

**The boundary, exactly** (T-EXACT-*):

| UTF-16 units requested | landed |
|---|---|
| 3,999 digits | 3,999 — INTACT |
| **4,000** digits | 4,000 — INTACT |
| 4,001 digits | 4,000 — TRUNCATED |
| 4,000 (1,994 emoji + a 12-char tag) | 4,000 — INTACT |
| 4,002 (1,995 emoji + a 12-char tag) | 4,000 — TRUNCATED, back to a cluster boundary |

The cut still lands on a cluster boundary, which is why an emoji title can stop one unit short of the ceiling.

## 9. Checklist items — 100 per dispatch

Not a length cap at all; a count cap, and just as silent:

| requested | landed |
|---|---|
| 50 | 50 |
| **100** | 100 |
| 101 | **100** |
| 150 | **100** |

Identical on `things:///add?checklist-items=`, `things:///update?checklist-items=` and `things:///json` with a `checklist-items` attribute array. The to-do is created or updated normally; the items past 100 simply never exist. A 3,000-item dispatch (29,999 characters joined) also lands exactly 100, so the drop is on the count, not on the joined parameter's length.

## 10. The shipped CLI, before the fix

Run against the same clone with the shipped `dist/`:

| command | payload | result | what the DB held |
|---|---|---|---|
| `todo update <uuid> --notes -` | 15,013 clusters | `verify-failed:mismatch`, exit 3 | notes = 10,000 — **the write half-landed** |
| `todo add <title> --notes -` | 15,013 clusters | `verify-failed:mismatch`, exit 3 | **row created (+1)** with 10,000-character notes |
| `todo update <uuid> --append-notes <3,010>` on a 9,010 body | fragment under the ceiling | `ok` | 12,021 — correct, and above 10,000 |

The first two are #621 exactly: read-after-write catches the difference, and the only thing the caller is told is that the database "reached a state contradicting the expected delta". The third confirms §5 from the shipped surface — the joined result is not the app's problem and must not become ours.

## 11. What shipped

- **`src/write/field-limits.ts`** — the measured constants, a UAX #29 cluster counter with an ASCII fast path (CR excluded, since CR LF is one cluster), the refusal builder, and `describeTruncation`.
- **Pre-write refusal at the #584 registry choke point** (`src/write/param-schema.ts`): `str()` carries the title ceiling, `text()` the notes ceilings, `checklistTitles()` both the title ceiling per item and the 100-item cap; the structured `checklistItems`/`projectItems` validators check the same. Every untyped entry point — batch JSONL, MCP `run_operation`, a JavaScript caller — inherits it identically, and nothing is locked, dispatched or audited.
- **Post-write backstop** (`src/write/pipeline.ts` `truncationDetail`): when a mismatch's observed value is a strict prefix of the requested one, the failure names the truncation and how much landed instead of the generic sentence.
- **Regressions**: `test/unit/field-limits.test.ts` (the counters and every boundary, below/at/above, per payload class), `test/unit/param-schema.test.ts` (the registry refusals), `test/engine/write-pipeline.test.ts` (zero dispatch on refusal; the truncation detail).

## 12. Not measured

- **Whether a generic URL-parameter ceiling exists for non-notes parameters.** The 4,000-unit title cap binds long before any URL-level cap could, so `title=` never reveals one. The 10,000-cluster law is established for `notes=`/`append-notes=` only.
- **Whether `project.add`'s structured `items` array has its own count cap** (the checklist 100 is measured; the project-items analog is not).
- **Where the notes ceiling sits on iOS or on Things Cloud sync** — this is a macOS 3.23 measurement.
- **The `things:///json` `checklist-items` cap beyond 150 items**, and whether a second dispatch appends past 100 (only the single-dispatch cap was probed).
