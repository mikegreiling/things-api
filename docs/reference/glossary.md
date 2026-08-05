# Glossary — lifecycle verbs and states

House vocabulary for the Things lifecycle, preferring **Cultured Code's own GUI language** wherever it exists. Each entry names the canonical word, its DB substrate, and our consumer-surface word — with honest caveats where no canonical choice is nailed down. GUI menu strings marked *(maintainer-verified 2026-08-05)* are screenshot-confirmed from the macOS GUI (Things 3.22.x): the heading `⋯` menu shows **Archive** (open heading) / **Restore** (archived heading); the resolved to-do context menu shows **Reactivate**.

## Resolution states (to-dos & projects)

- **open** — a to-do/project that is not completed or canceled (`status=0`). Our stage/consumer word. CC's GUI names the *action back to* this state — **"Mark as Incomplete"** *(maintainer-observed)* — and **"Reactivate"** for log-swept items — but does not obviously name the state itself; "active"/"open" are our choices, not CC's. Caveat: no canonical CC state-noun discovered yet.
- **completed** — checked off (`status=3`). GUI: **"Mark as Completed"**.
- **canceled** — resolved-without-doing (`status=2`, dash checkbox). GUI: **"Mark as Canceled"**.
- **resolved** — OUR umbrella for completed-or-canceled (`status IN (2,3)`). CC has no public umbrella word (caveat: house term, used in probe docs and refusal copy).
- **stopDate / `stopped`** — the DB column stamping the resolution instant; surfaced in JSON as `stopped`. "Stop" is CC-internal substrate vocabulary — the GUI never says "stop" (caveat). Notable: toggling an already-resolved (even log-swept) item between Completed ↔ Canceled does **not** change `stopDate` and does not un-sweep it *(maintainer-observed; not yet VM-probed)* — the resolution instant is preserved across resolution-kind changes.
- **reactivate** — CC's GUI verb for returning a **log-swept to-do/project** to open *(maintainer-verified 2026-08-05: context menu → "Reactivate")*. Substrate: `status→0`, `stopDate→NULL`, index-silent (LOGSORT L-RESTORE: the item re-enters its container at its retained `index`, retained heading, retained schedule). Prefer this verb for to-dos/projects; note CC uses a *different* verb for headings (below).

## Heading lifecycle

- **archive / archived** — a heading's analogue of completion (`status=3` + `stopDate`); JSON field `archived` (presence-keyed ISO datetime). GUI verb: **"Archive"** *(maintainer-verified 2026-08-05: heading `⋯` menu)*; the state renders as a struck heading in place until swept.
- **restore** — CC's GUI verb for un-archiving a heading *(maintainer-verified 2026-08-05: archived heading `⋯` menu → "Restore")*. Substrate: `status→0` + `stopDate→NULL`, index-silent (HEADSORT H-RESTORE). Distinct from **reactivate**: CC deliberately uses different verbs for headings vs to-dos/projects — mirror that.

## The Logbook and the sweep

- **Logbook** — CC's GUI name for the resolved-history view. Use it (never "archive" for this view).
- **log / logged** — CC's verb family for the move into the Logbook (Settings: "Move completed items to Logbook"; AppleScript `log completed now`). Our reads stamp a derived `logged` boolean ([src/read/log-boundary.ts](../../src/read/log-boundary.ts) `markLogged`).
- **swept / unswept** — OUR house terms (probe-doc vocabulary) for logged / resolved-but-not-yet-logged. Interchangeable with logged/unlogged; "swept" is preferred in lab docs because it names the *crossing*, "logged" on consumer surfaces because it matches CC. An unswept resolved item renders struck-through **in place** in its container.
- **log boundary** — the derived line that makes an item logged: `status IN (2,3) AND stopDate ≤ boundary`, where boundary = `max(interval edge, manualLogDate)` from the `TMSettings` singleton (`logInterval` 0=Immediately · 1=Daily · 4=Manually — no weekly/monthly, oddities §8c). **There is no per-row swept bit and the sweep mutates zero task rows** (plog1/A28/LOGNOW) — "swept" is a pure projection, which is why `index` survives the whole complete→sweep→restore cycle (HEADSORT/LOGSORT). Guard: flipping the Settings interval **stamps `manualLogDate` at flip time** (observed during HEADSORT/LOGSORT AX flips), so changing the setting cannot rewind the boundary and dump history back into live views. Caveats: under Daily the interval edge is the **viewer's local midnight** — nothing is written when a day passes, so two synced devices in different timezones can disagree about Logbook membership at the same instant (model-derived; not yet cross-device probed). A Daily→Manually flip's stamp lands at *flip time*, which would forward-sweep that day's pending window (unprobed — only Immediately→Manually flips have been observed).

## Scheduling

- **when** — CC's GUI word (the "When" field) and our derived consumer field: the time-axis position (`today` / `evening` / ISO date / `someday`), replacing raw substrate in consumer payloads (contract R12).
- **start / startDate** — DB substrate: `start` is the coarse bucket enum, `startDate` the raw scheduled date. Consumer surfaces never say "start" (reserved substrate vocabulary; the `*Date` suffix convention marks raw substrate — see the naming discussion behind heading `archived`). Enum details live in the [schema atlas](../atlas/schema-v26.md).
- **deadline** — same word in GUI, DB, and API; no divergence.

## Usage rules

1. Prefer the CC GUI verb when one exists (**reactivate**, **restore**, **archive**, **log**, **when**); house terms (**resolved**, **swept**, **open**) are fine in lab/design docs but consumer-facing copy should not invent lifecycle vocabulary CC doesn't use (see [../design/surface-copy.md](../design/surface-copy.md)).
2. When a term here is marked *unverified* or *caveat*, nail it down (screenshot or probe) before promoting it to consumer copy.
