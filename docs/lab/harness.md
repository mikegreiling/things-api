# Probe harness — how a lab run works

The harness executes **probe suites** (JSON, `lab/suites/`) against a fresh clone of the frozen golden image and judges every probe against locked expectations. It is the machine that produced/re-validates the capability matrix, and later the CI regression gate (any verdict/tier delta = a Things update moved the write surface).

## Running

```sh
npm run lab:run                          # default suite: lab/suites/u-suite.json
npm run lab:run -- --suite lab/suites/u-suite.json --keep-vm
npm run lab:compare -- u-20260703-091530 u-20260703-104512   # acceptance gate
npm run lab:gc                           # delete stray things-run-* VMs
```

Requirements: host GUI session (tart needs an unlocked keychain), `tart` + `sshpass` on PATH, the golden image under `TART_HOME` (default `/Volumes/Workspace/tart`). Exit code 0 = every probe green.

## Anatomy of a run

1. **Preflight** — tools present, golden exists, ≥10GB free, stray run-VMs deleted (2-VM ceiling).
2. **Clone + boot** — `tart clone` (APFS COW, instant) → `tart run --no-graphics` on default NAT (headless but full Aqua session). `--net-host` is deliberately **not** used: on current Tart it is implemented via Softnet, which requires passwordless root on the *host*. Boot output is captured to `tart-run.log` in the artifacts dir.
3. **Bootstrap** — **airgap guest-side** by deleting the guest's default route (SSH survives on the directly connected vmnet subnet; internet/updaters/phone-home become unroutable — verified by a failed ping each run); pin the guest clock to the golden's `pinnedDate` **before Things ever launches** (neutralizes trial expiry, freezes Today semantics); assert the disruption-monitor LaunchAgent is running; one warm-up launch+quit of Things (recomputes Today buckets / repeat instances for the pinned date, so probes see steady state); pull a consistent DB copy and **assert the schema fingerprint** against `docs/lab/golden-v1-metadata.json` — mismatch aborts the run.
4. **Execute** — push `lab/guest/probe-runner.py` + suite + context (auth token, pinned date, seed-manifest UUIDs); the guest runs probes **serially**, hazard-group probes (crash risk) quarantined last.
5. **Collect** — execution records, per-probe snapshots, `events.ndjson`, final DB copy, crash reports → `lab/artifacts/<runId>/` (gitignored).
6. **Evaluate (host-side)** — snapshot diffing, disruption tiers, assertions → `evidence/<probe>.json` + `verdicts.json` + console summary.
7. **Teardown** — stop + delete the clone (`--keep-vm` to skip).

## Division of labor

| Where | What | Why |
|---|---|---|
| Guest (`probe-runner.py`, Python 3.9) | app-state enforcement, MARK sentinels, raw table snapshots, command execution, SQL-poll waits, crash detection | timing-sensitive mechanics must run next to the app |
| Host (`lab/runner/*.ts`) | snapshot diffing, tier computation, assertion evaluation, verdicts, artifact assembly | judgment logic is unit-tested (vitest) and reusable across suites |

## Probe lifecycle (guest)

`setup` (creates targets; noise excluded from evidence) → enforce `appState` → before-snapshot → `MARK start` → `commands` (+ SQL-poll waits) → settle → `MARK end` → crash check → after-snapshot → `cleanup` (e.g. `pkill Things3` to clear modals — the canonical reset primitive).

App states: `not-running` · `running-background` (Finder frontmost) · `frontmost` · `modal-open` (modal spawned in setup).

## Evidence & verdicts

Every probe yields one evidence record (`docs/design/lab.md` §4.2): resolved commands + transport results, row-level DB delta (`inserted/deleted/changed` — the ground truth; `open` exit 0 proves nothing), disruption `{tier, signals, events}` from the monitor slice between MARKs, crash `{pidDied, ipsFiles}`, and the verdict.

A probe is **green** iff: transport clean (unless `allowNonzeroExit`) ∧ all waits satisfied ∧ observed tier == expected ∧ crash state == expected ∧ all assertions pass. Assertions are declarative (`rowExists`, `inserted`, `fieldEquals`, `fieldUnchanged`, `unchanged`, `rowCount`, `rowAbsent`, `notInserted`, `deltaEmpty`) with `@uuidOf:` / `@seed:` / `@ctx:` refs. Command strings support `{uuid:TITLE}` / `{seed:NAME}` / `{ctx:KEY}` placeholders resolved on the guest at execution time.

Disruption tiers: 0 = no observable effect · 1 = background launch · 2 = focus steal (Things became frontmost) · 3 = new window/modal beyond the window budget, or a title change. Window budget: a launch surfaces the main window plus (sometimes) an untitled companion (budget 2); a bare activation can surface that companion alone (budget 1); anything beyond is a modal/new window. Error modals show up as `window-new` events without a launch; the `json` command's error modal additionally steals focus. Note: AppleEvents to a *closed* Things auto-launch it **with focus steal** (tier 2, A40/A41) — pre-launch with `open -g` to keep AppleScript operations at tier 0.

## Command steps & vectors (suite DSL)

A probe's `setup`/`commands`/`cleanup` are lists of step objects the guest runs in order (`lab/guest/probe-runner.py`): `openUrl` (background `open -g` unless `foreground`), `exec` (raw argv), `osascript`, `shortcut`, `waitSql` (poll a SELECT until it returns a row), `waitCrash`, and `sleep`. String fields resolve `{ctx:…}`/`{seed:…}`/`{uuid:TITLE}` placeholders on the guest at execution time.

- **`shortcut`** — the Apple Shortcuts vector: `{ "shortcut": "<name>", "input": { … }, "timeoutSeconds": 40 }`. The guest writes `input` (a JSON dict; string values resolve placeholders) to a temp file and runs `shortcuts run <name> --input-path <in> --output-path <out>`. The output file (falling back to process stdout) becomes the command's `stdout`, so `stdoutMatches` assertions see the proxy's result; the stale output file is removed before each run (a proxy exits 0 even when it silently no-ops — the DB delta is the only truth, scf lesson). Requires the six golden-resident `things-proxy-*` shortcuts + inherited consent (see [s-campaign-results.md](s-campaign-results.md)).
- **`group: "interactive"`** — a probe the automated runner SKIPS (both the guest execution list and the host's `activeProbes` gate). It stays in the suite JSON as documentation for human sittings. Use it for the delete-class Shortcuts proxies, which have no Always-Allow and re-prompt every run (oddities 5j): S04/S-delperm ride a human sitting via `lab/scripts/l5-consent-absorb.sh`, never `lab:regress`.

## Suite conventions (u-suite)

- Canonical URL transport is **`open -g`** (background-open). U01 alone uses plain `open` to re-validate T01's launch/foreground finding. Matrix-v1 tiers assumed plain `open`; the recorded tiers here are the `-g` variant, which is what the write API will use.
- Probes create their own targets in `setup` wherever possible; golden seed records are only mutated by the hazard group (fresh clone every run makes this safe).
- U10/U11/U15 are **discovery cells**: T10 never executed and T11/T15 were evidence-based conclusions; their expectations were locked from the first observed run and any later delta is a real finding.

## Acceptance (Lab-3 exit gate)

Two full unattended runs with every probe green and `lab:compare` reporting identical verdicts (`ok`/`verdict`/`tier`/`crash` per probe).
