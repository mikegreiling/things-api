# R-suite results — reminders campaign

Suite: [lab/suites/r-suite.json](../../lab/suites/r-suite.json) (16 probes, R01–R16). Locked 2026-07-04 after discovery + acceptance ×2 identical (`r-20260704-022520` / `r-20260704-022655`). All tier 0 except the quarantined crash probe. Every probe locks the EXACT stored `reminderTime` int, so any parser or codec change in a future Things build fails the suite loudly.

## The codec (atlas item CLOSED)

`TMTask.reminderTime = hour << 26 | minute << 20` — equivalently `(hour*64 + minute) << 20`. Verified against 13 known-time samples (e.g. `1207959552` → 18:00, `434110464` → 06:30, `15728640` → 00:15, `1425014784` → 21:15). Recorded in [docs/atlas/schema-v26.md](../atlas/schema-v26.md).

## The time-parser rules (the surprise finding)

`when=<list>@<time>` parses the time in three distinct lexical classes:

| Input class | Behavior | Evidence |
|---|---|---|
| Leading-zero hour (`06:30`, `06:45`, `00:15`) | 24-hour LITERAL, stored exactly | R02, R03, R10 |
| Hour ≥ 12 (`12:30`, `14:10`, `18:00`, `21:15`, `22:30`) | unambiguous, stored exactly | R01, R04, R11, R15, R16 |
| **Bare hour 1–11** (`10:05`, `6:45`) | 12-hour + **"next upcoming occurrence"** vs. the current clock — at pinned noon both became PM (22:05, 18:45) | R06, R12, R13 |
| Explicit suffix (`6pm`, `10:05am`) | honored deterministically | R05, R14 |

Consequence: **10:xx / 11:xx AM are inexpressible without the `am` suffix** (no leading-zero spelling exists). Same on add and update. Filed as oddity 2d in [docs/things-app-oddities.md](../things-app-oddities.md).

**Deterministic emitter for the write layer** (every branch evidence-backed): hour 0–9 → `0H:mm` (R02/R03); hour 10–11 → `H:mmam`/`H:mmpm` (R14/R05); hour 12–23 → `H:mm` (R16/R01/R11/R15).

## Semantics

- Reminder requires a scheduled `when` — set on add (`when=today@18:00`, R01) and on update (R06); `when=evening@21:15` works and lands in the evening bucket (R04).
- **Clear**: a bare `when=today` on update NULLs `reminderTime` (R07) — so every schedule-preserving update must re-send the reminder or it's silently dropped; conversely this IS the clear operation.
- The private `json` AppleScript property exposes the reminder on read (R08).
- **HAZARD (R09)**: `when=today@18:00` on a repeating template crashes Things exactly like the bare `when=` (U12 family, EXC_BREAKPOINT). H-REPEAT-SCHEDULE already blocks this path in the write layer; oddity 1 updated.

## Dated reminders (R17–R21, Phase 12b)

- Setting works on add AND update with `when=YYYY-MM-DD@time` (R17/R18, exact ints locked).
- The bare-hour 12-hour "next upcoming" heuristic is **today/evening-only**: `2026-07-09@10:05` stores 10:05 EXACTLY (R19) — scopes oddity 2d to clock-relative keywords.
- **Dated reminders are STICKY**: a bare `when=` does NOT clear them — neither same-date (R20) nor re-dated (R21; the reminder rides along to the new date). Asymmetric with today/evening, where a bare when= clears (R07). No URL clear path exists for dated reminders → H-REMINDER-SCOPE blocks `reminder:null` on dated whens with the re-schedule-via-today remediation. Filed as oddity 2e.

## Feed into Phase 9b

Extend the `when` vocabulary with `{ when: "today", reminder: "18:00" }` (or `when: "today@18:00"` sugar), compile via the deterministic emitter, verify `reminderTime` with the codec; `reminder: null` compiles to the bare-when clear.
