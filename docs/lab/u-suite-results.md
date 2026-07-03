# U-suite results — URL-scheme re-validation (Lab-3 exit)

**Environment:** things-lab-golden-v1 · Things 3.22.11 (trial build 32211007) · macOS 15.6 guest · pinned clock 2026-07-05 · schema fingerprint `sha256:e4267e…` verified at bootstrap each run.

**Acceptance (two identical unattended green runs, 2026-07-03):** `u-20260703-063310` and `u-20260703-063535` — every probe green; `npm run lab:compare -- u-20260703-063310 u-20260703-063535` → "identical verdicts across both runs (22 probes)". Evidence records live in `lab/artifacts/<runId>/evidence/` (gitignored; regenerate with `npm run lab:run`).

## Verdicts

Canonical transport is `open -g` (background-open) — the transport the write API will use. U01 alone uses plain `open` to re-validate T01's launch/foreground behavior. Tiers: 0 invisible · 1 background launch · 2 focus steal · 3 modal/new window.

| probe | legacy | operation | verdict | tier | notes |
|---|---|---|---|---|---|
| U01 | T01 | app.version-probe | supported | 2 | plain `open` launches + foregrounds; no DB delta |
| U02 | T02 | todo.update-unauthenticated | unsupported | 3 | modal, **no activation**; zero mutation |
| U03 | T03 | todo.create | supported | 0 | unknown tag silently ignored; no TMTag/TMTaskTag rows |
| U04 | T04 | todo.tags-replace | supported | 0 | full-set replacement; case-insensitive; no tag creation |
| U05 | T05 | area.create | unsupported | 3 | unsupported-command modal; no TMArea insert |
| U06 | T06 | todo.move-to-area (unknown) | silent-noop | 0 | unknown `list=` target: nothing at all happens |
| U06B | T06 | todo.move-to-area | supported | 0 | case-insensitive area match; `start`/`startDate` preserved |
| U07 | T07 | todo.checklist-replace | supported | 0 | wholesale replacement confirmed row-level |
| U08 | T08 | project.complete | supported | 0 | open child auto-completed; canceled child untouched; **no prompt** (unlike UI) |
| U09 | T09 | heading.create-via-add-param | partial | 0 | to-do created in project; missing heading NOT created, `heading` stays NULL |
| U10 | T10 | heading.update-via-json | unsupported | 3 | **discovery (T10 never ran):** json update op on a heading → error modal **with focus steal**; heading untouched |
| U11 | T11 | todo.reorder-via-index | silent-noop | 0 | `index` param ignored; `index`/`todayIndex` unchanged |
| U12B | T12 | todo.update-repeating-nonschedule | supported | 0 | title update on repeating template works; rt1 blob unchanged |
| U12 | T12 | todo.update-repeating-when | **crash** | 0 | `when=` on repeating template kills Things (pid death reproduced every run); template row byte-identical after |
| U13 | T13 | todo.update-during-modal | supported | 0 | valid update mutates silently while error modal open — modal ≠ execution lock |
| U14 | T14 | todo.delete | unsupported | 3 | modal **with focus steal**; target intact |
| U15 | T15 | todo.promote-to-project | silent-noop | 0 | **discovery:** bogus `type=project` param silently ignored; `type` stays 0 |
| U16 | T16 | read.repeating-template | supported | 0 | template: `rt1_recurrenceRule` blob, `start=2`, `repeater` NULL; spawned instance is a separate row without rt1 |
| U17 | T17 | read.project-ordering | supported | 0 | **`index` orders siblings within ONE container scope** — see below |
| U18 | T18 | read.tag-inheritance | supported | 0 | TMAreaTag row present; inherited tags NOT materialized onto children |
| U19 | T19 | project.reopen-via-new-child | supported | 0 | new open child (by `list-id`) reopens a completed project; auto-completed sibling stays completed |
| U20 | T20 | todo.checklist-on-completed | supported | 0 | checklist added open; to-do stays completed |

**Every T-finding re-validated.** No verdict contradicts matrix v1. The three cells that had never actually been executed (T10, and the evidence-only T11/T15 conclusions) are now backed by instrumented probes.

## New findings beyond matrix v1

1. **`open -g` keeps the whole URL vector at tier 0** for valid operations against a running app — creates, updates, tag ops, checklist ops, project completion all ran with zero observable app effect. Matrix v1 assumed tier-2 foregrounding (plain `open`); background-open is the transport the write API should use.
2. **Error modals differ by command class.** Plain bad commands / missing auth (U02, U05): one untitled window, no focus change. `things:///json` errors and `delete` (U10, U14): modal **plus activation** — the most disruptive failure mode observed.
3. **A Things launch surfaces two CGWindowList windows** (titled main window + one untitled companion), deterministically. The tier detector budgets both on launch.
4. **`index` is container-scoped.** Heading rows order among themselves (Alpha −409 < Beta 0) and children order within their heading (−609 < 0), but a flat item's `index` is not comparable to a heading's — a child's index can be lower than its own heading's. Any project-view mirror must sort per scope, not globally.
5. **T12 crash is cleanly reproducible and safe to automate**: `open` exits 0, Things dies ~1s later (pid death; `.ips` capture is racy — pid death is the detector), DB row untouched. The write API's repeating-item guard has hard evidence.

## Harness learnings (for future campaigns)

- Tart's `--net-host` needs Softnet + passwordless **host** root; runs boot on default NAT and airgap guest-side (`route -n delete default`, ping-verified every run).
- The disruption monitor must be the **only** writer to events.ndjson (private FileHandle offset clobbers other writers); MARK sentinels live in marks.ndjson, merged by timestamp at evaluation.
- SQLite BLOBs in snapshots are hashed (`blob:sha256:…`) — equality is all the differ needs.
- `waitSql` placeholders re-resolve every poll tick ({uuid:TITLE} races row creation otherwise).
- Fresh clones can flap SSH auth in the first seconds after boot; ssh/scp retry on exit 255.
- Screen Recording **is** granted in golden-v1 (window titles appear in evidence).

## Suite runtime

~8 minutes end-to-end per run: clone+boot ≈ 30 s, bootstrap (airgap, clock pin, warm-up, fingerprint) ≈ 70 s, 22 probes ≈ 2 min, collect+evaluate+teardown ≈ 30 s.
