# CHKT1 — checklist writes on a repeating to-do TEMPLATE (issue #479)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a Sunday).** ONE disposable clone `chkt1-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 carries the baked L3-accessibility grant, so `todo add-repeating` (a ui-vector op) and the AX census drove over SSH via System Events — no VNC. Ground truth = read-only guest SQLite (`TMChecklistItem` rows keyed on the owning `task` uuid). Fixtures fully synthetic (`CHKT *` titles). Branch `mg/479-template-checklist`; driver [`lab/scripts/research-chkt1.sh`](../../lab/scripts/research-chkt1.sh); artifacts (gitignored) `lab/artifacts/chkt1-lab/` (`report.txt`, `drive/*.log`, `ax/*.txt`).

## The report (#479)

`things todo checklist <template-uuid> --item …` on a repeating to-do template was reported (from Things **3.22.14**) to exit `verify-failed:silent-noop`: the URL-scheme vector — the ONLY vector with a `todo.replace-checklist` matrix entry — is accepted but the DB shows no change (the fail-closed verify catches it). `--vector ui` reports no matrix entry for `todo.replace-checklist`. The `H-REPEAT-SCHEDULE` guard lets checklist writes THROUGH to templates and its remediation claims "title/notes updates and checklist replacement remain allowed on templates" — #479 appeared to falsify the checklist half of that claim.

## HEADLINE VERDICT — the silent no-op does NOT reproduce under the golden (3.22.12)

**On Things 3.22.12, `things todo checklist <template> --item …` SUCCEEDS.** The four items land on the template row, the read-after-write verify passes (`ok`, exit 0), and they PROPAGATE to the next spawned instance with per-item state reset. The `H-REPEAT-SCHEDULE` allow-list copy ("checklist replacement remain allowed on templates") is **CONFIRMED truthful on the golden**, not falsified. The #479 `verify-failed:silent-noop` is therefore **version-specific to Things 3.22.14** — the host is two point releases past the golden (3.22.13/3.22.14 changed the URL `update?checklist-items=` handling for repeating templates). Per the campaign gate this is a **STOP-and-report**: characterizing the 3.22.14 behavior and deciding whether to ship a preflight refusal or advance the golden is a **maintainer golden decision**, not shippable from a 3.22.12 clone (a refusal shipped now would BREAK a working, verified 3.22.12 feature and fail the golden's own `lab:regress`).

## Setup

- Plain control to-do `CHKT Plain` (`VAv75nWyY8wG9pyiLbKc1`) — a normal to-do, seeded via `todo add` (URL scheme).
- Repeating to-do template `CHKT Repeat` (`BUNm1yt1d4emHVBLGBgHg7`) — seeded via `todo add-repeating --when 2026-07-06 --frequency daily --interval 1 --dangerously-drive-gui`. Template row = `type=0`, `rt1_recurrenceRule` set, `trashed=0`. (add-repeating warned it could not derive the current instance — the app had not yet materialized an occurrence at the pinned 07-05 clock; the fresh 07-07 occurrence materialized later in Phase A5.)

## Phase 0 — production CLI, the exact #479 repro

The issue's exact command (`todo checklist <uuid> --item "Synthetic room A".."D" --json`), against BOTH targets:

| Target | result | DB after (`TMChecklistItem` where `task=<uuid>`) |
|---|---|---|
| plain control `VAv75nWyY8wG9pyiLbKc1` | `ok` · `todo.replace-checklist` · url-scheme · exit 0 | Room A, B, C, D (all open) ✓ |
| **repeating template `BUNm…`** | **`ok`** · `todo.replace-checklist` · url-scheme · exit 0 | **Synthetic room A, B, C, D (all open)** ✓ |

The template write dispatched the **url-scheme** vector (the only `todo.replace-checklist` cell) — same vector that #479 reports silently dropping on 3.22.14. Here it lands and verifies. **No reproduction.**

## Phase A — vector census on the template (each cell DB-verified, 3.22.12)

| # | Vector | Command | Template result | Verdict |
|---|---|---|---|---|
| A1 | **AppleScript** | `make new checklist item at end of to do id …` / `get checklist items of …` | compile error −2740 ("a class name can't go after this identifier") — `checklist item(s)` is not a class in the Things sdef | **no access** — corroborates A30 (AppleScript has no checklist surface at all, on any row) |
| A2 | **Shortcuts** | `things-proxy-set-detail` `{detail:"Checklist", value:"…\n…"}` | exit 0, empty output, **0 items** on BOTH template AND plain control | **silent no-op** — `Edit Items → Checklist` cannot SET (extends the s-campaign "set-detail can only CLEAR, not set" law from Reminder Time to Checklist; oddity 5k class) |
| A3a | **URL replace** (`checklist-items=`) | `things:///update?auth-token=…&id=<tmpl>&checklist-items=URLrep A\nURLrep B` | replaced wholesale → URLrep A, URLrep B ✓ | **WORKS** on templates — confirms the production CLI faithfully reproduces this wire path |
| A3b | **URL append** (`append-checklist-items=`) | `things:///update?…&id=<tmpl>&append-checklist-items=URLapp A\nURLapp B` | additive → URLrep A, URLrep B, URLapp A, URLapp B ✓ | **WORKS** on templates — an ADDITIVE param the shipped CLI does not currently use (we only do wholesale replace); untested until now, and it also lands on plain to-dos (control ✓) |
| A4 | **GUI** | `things:///show?id=<tmpl>` then full-app AX census | `show?id=<template>` navigates to the **Upcoming** view (no dedicated card surfaces headlessly — consistent with §5e, templates are hidden from lists); the only "checklist" AX node is the toolbar `Task Checklist Template` quick-entry image, unrelated to the item's checklist editor | **no distinct headless write path** — moot on the golden since URL works; a real GUI edit is the normal open-the-card flow, not `show?id=` |

## Phase A5 — propagation (clock-advance +1 day)

Template checklist (the four URL-written items) in place → clock advanced 07-05 → 07-07 (INS0 for 07-06 was pre-materialized) → warm relaunch + Upcoming/Today nudge → a fresh instance `3EpP1DnVarEDidNZjjuX68` spawned and **inherited all four template checklist items, every one reset to open** (`status=0`). Matches the RSIM-S law (a spawned occurrence is a pristine copy of the template's current child/checklist state, terminal state reset). So on 3.22.12 the issue's *expected* behavior — items land AND future instances inherit them — is exactly what the app does.

## Conclusion & recommendation (maintainer golden decision)

1. **Ship no fix from this clone.** On the golden, checklist-on-template WORKS, verifies, and propagates; the guard allow-list copy is confirmed. A preflight refusal (issue option 2) would regress a working 3.22.12 feature.
2. **The #479 failure is a suspected Things 3.22.14 regression** in the URL `update?checklist-items=` handler for repeating templates (the same guarded-vs-unguarded template split seen in oddity §2i, where `deadline=` is silently dropped on a template while `when=` crashes). It is **unverified under a golden** — no 3.22.14 golden exists.
3. **On 3.22.14 the shipped system already degrades safely:** the fail-closed read-after-write verify catches the no-op and returns `verify-failed:silent-noop` (no bad state, clear error) — it does not silently claim success.
4. **Decision needed:** advance the golden to 3.22.14 (or the current release) and re-run CHKT1. IF the silent no-op confirms there, the fix is branch-3 (extend `H-REPEAT-SCHEDULE` to `blocked` for `todo.replace-checklist`/`todo.edit-checklist-item` on a template, with a remediation naming the app-native route) — AND the allow-list copy is then corrected. Until a 3.22.14 golden confirms, the current behavior stays.
