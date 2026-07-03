# Things-Lab — Disposable macOS VM Environment, Write-Surface Probe Methodology, and CI Regression Harness

> Produced at project kickoff (2026-07-02). Facts marked with sources were web-verified during design. Section 8 is a kickoff addendum: host-side static analysis performed after the main design, which elevates several probes.

**Host:** M3 Pro (Mac15,7), 12 cores, 36GB RAM, macOS 15.7.4 Sequoia; production Things 3.22.11 with live GTD data — never touched by this system.
**Prior art:** URL-scheme capability matrix + T01–T20 validation in `../research/` (03, validation-notes, 08, 09). AppleScript/Shortcuts exclusion is now reversed.

## 0. Executive summary and verified-fact deltas

Three research findings materially changed the original plan:

1. **In-VM App Store purchase is dead.** Apple's support doc confirms Apple Account sign-in works in macOS 15 VMs (host and guest both ≥ 15, VM created fresh on Sequoia), but **App Store access and running App-Store-purchased apps do not work in VMs** ([Apple: Use iCloud on a virtual machine](https://support.apple.com/en-us/120468); [Eclectic Light analysis](https://eclecticlight.co/2024/07/12/sequoia-virtualisation-and-apple-id/)). Things for Mac is sold **exclusively** through the App Store ([Getting Things](https://culturedcode.com/things/support/articles/2803552/)). Consequence: **no Apple ID is needed in the VM at all** (Things Cloud is Cultured Code's own account system, not iCloud); the VM runs the **direct-download 15-day trial** — full-featured, "15 days from your first launch," read-only mode afterward, extensions available from support ([Trying the App](https://culturedcode.com/things/support/articles/2803551/)).

2. **AppleScript is confirmed to unlock exactly the write gaps the URL scheme has.** Cultured Code officially documents ([Things AppleScript Commands](https://culturedcode.com/things/support/articles/4562654/), [AppleScript Guide PDF](https://culturedcode.com/things/download/Things3AppleScriptGuide.pdf)): `make new area`, `make new tag` (+ `parent tag` hierarchy), `delete` (moves to Trash; **areas are deleted permanently, not trashed**), `empty trash`, `move` between lists/projects/areas, `schedule` (required for Upcoming; `move` cannot target Upcoming), status set to completed/canceled, full read access to every built-in list including Logbook and Trash. Documented limits: **no checklist or heading editing**, cannot create built-in lists.

3. **Shortcuts is not marginal — it covers headings.** Things 3.17+ (macOS 14+) ships overhauled Shortcuts actions: Create To-Do / Create Project / **Create Heading**, Edit Items (11 properties), **Delete Items (tasks, projects, and headings)**, Duplicate Items, Find/Get Items with structured output, Get Selected Item, Open List, Run Things URL ([Things Shortcuts Actions](https://culturedcode.com/things/support/articles/9596775/), [MacStories review](https://www.macstories.net/reviews/things-3-17-overhauls-the-apps-shortcuts-actions/)). Heading lifecycle was "UI-only" in matrix v1 — Shortcuts likely flips that. Checklist items remain URL-scheme-only on current evidence.

The three vectors are **complementary, not redundant**.

## 1. VM tooling: Tart

**Decision: Tart** (cirruslabs). Purpose-built for ephemeral macOS VMs for CI on Apple silicon, CLI-first, OCI image distribution. Licensing is Fair Source: **royalty-free on personal workstations** ([tart.run/licensing](https://tart.run/licensing/)). Rejected: UTM (GUI-oriented, weak headless story), Anka (commercial), raw Virtualization.framework (you'd rebuild Tart), Lume (younger).

### 1.1 Golden image strategy: pull prebuilt, do not build from IPSW

Use `ghcr.io/cirruslabs/macos-sequoia-vanilla:latest`. The [Packer template](https://github.com/cirruslabs/macos-image-templates) configures: **50GB disk**, macOS 15.6.x, auto-login via kcpassword, SSH enabled, passwordless sudo, screen lock/screensaver disabled, VM sleep disabled, Screen Sharing enabled, Gatekeeper disabled, timezone UTC, analytics prompts declined, `admin`/`admin` credentials. That is 90% of golden-image prep done reproducibly. IPSW builds (`tart create --from-ipsw`) only as fallback for point-releases Cirrus doesn't publish.

- Prefer **vanilla** over **base** (base adds brew + dev tooling we mostly don't need in-guest). Needed in-guest: sqlite3, osascript, shortcuts — all ship with macOS. Pin Node in the golden seed step only if needed.
- Guest OS = **Sequoia 15.x** to match the production host. Do not chase Tahoe images.
- SIP is **enabled** in these images (template doesn't touch csrutil) — relevant to TCC strategy (§3).

### 1.2 Storage

Budget: OCI cache (compressed layers, prunable) ~15–25GB · golden image ~30–40GB actual · clone per run ~0 at creation (APFS COW), grows <2GB/run · second golden during drift testing +few GB (COW-shared).

Per user decision: reclaim disk on the Workspace volume first (~40GB of `node_modules` measured) and set `TART_HOME=/Volumes/Workspace/tart`; prune the OCI cache after golden creation. **Fallback trigger:** attach a dedicated APFS external SSD if free space <55GB after cleanup or the volume gets cramped. Critical constraint: **APFS copy-on-write clones only work within one volume** — golden and clones must both live under the same `TART_HOME` volume.

### 1.3 Lifecycle: clone-per-run

Tart has **no live snapshot tree**. Model: stopped golden → `tart clone golden run-<id>` (instant, COW) → `tart run` → execute → collect artifacts → `tart delete run-<id>`. `tart suspend`/`--suspendable` (single resumable memory state) is useful for warm dev iteration only; clone-per-run remains the CI model.

```
tart clone things-lab-golden-v3 run-$(date +%s)
tart run run-XXXX --no-graphics --net-host &
IP=$(tart ip run-XXXX)           # poll until sshd answers
ssh admin@$IP ...                 # drive suite
tart delete run-XXXX
```

### 1.4 Concurrency: the 2-VM limit

Virtualization.framework/EULA allows **max two concurrent macOS VMs per host**. Consequences: CI queue depth = 1 (keep slot 2 free for interactive seeding/debug), never parallelize probe suites, teardown promptly on failure paths (`lab:gc` sweep).

### 1.5 GUI session: `--no-graphics` still yields a full Aqua session

`--no-graphics` only skips the host-side viewer window; the guest boots the window server and **auto-login establishes a console Aqua session** (how Cirrus images run headless UI tests). Everything we need — `open "things:///…"` via LaunchServices, AppleEvents to a GUI app, `shortcuts run` — requires that session and gets it. Prior host-side finding ("SSH works when the same user has an active GUI session") transfers: the guest is permanently in that state.

Host drives guest via `tart ip` + SSH (`admin`/`admin`, passwordless sudo). No `tart exec` exists; SSH is the supported channel. Human steps: `tart run --vnc` or macOS Screen Sharing to the VM IP. Host gotcha ([tart FAQ](https://tart.run/faq/)): on macOS 15 hosts, `tart run` needs an **unlocked login keychain** — run the runner from the logged-in GUI session (or `security unlock-keychain` first).

### 1.6 App acquisition: trial-based golden image

- **Primary:** [direct-download trial](https://culturedcode.com/things/support/articles/2803551/) from culturedcode.com. The direct build stores data in the **same** Group Container as the MAS build (`~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/…`) — schema knowledge carries over unchanged. (Confirm container path + sandbox parity as probe P0-3 on first boot — assumption, not yet observed.)
- **Trial clock:** expiry = first-launch + 15 days **wall-clock**. Clone rollback restores the on-disk first-launch marker but not time — the golden itself ages. Two mitigations, use both:
  - **Pinned-clock runs (default):** clones boot airgapped (`--net-host`), bootstrap runs `sudo systemsetup -setusingnetworktime off && sudo date <PINNED_DATE>` *before* Things launches (PINNED_DATE = golden-first-launch + 2 days). Simultaneously: (a) trial never expires in clones, (b) Today/Upcoming/deadline semantics **deterministic forever**, (c) no TLS breakage because offline. Airgap also guarantees no phone-home, no updater, no sync.
  - **Golden rebuild cadence:** goldens are rebuilt from vanilla + seed scripts per Things-version-under-test anyway; each rebuild is a fresh trial.
- **Legitimacy track:** email Cultured Code support for a trial extension / testing license (they grant extensions per their own docs).
- **Things Cloud sync:** OFF for determinism (free CC account, not iCloud). Pinned-clock/airgapped mode is incompatible with it by design; sync probing is out of scope.
- **No Apple ID in the VM, period.**

## 2. Golden image build recipe

Layered, versioned, reproducible. Name: `things-lab-golden-v<N>`; metadata baked into guest at `/Users/admin/things-lab/metadata.json` (golden version, Things version+build, trial first-launch ISO date, pinned run date, schema fingerprint, seed-dataset manifest hash).

**L0 — pull:** `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest things-lab-golden-v1`; `tart set --cpu 4 --memory 8192`.

**L1 — determinism hardening (idempotent script in repo, run over SSH):** `softwareupdate --schedule off` + SoftwareUpdate defaults off; `com.apple.commerce AutoUpdate` false; `mdutil -a -i off`; `tmutil disable`; permanent Do Not Disturb/Focus; `systemsetup -setusingnetworktime off`; `pmset -a sleep 0 displaysleep 0 disksleep 0`.

**L2 — Things install + trial start [HUMAN]:** download trial DMG on host (record version + SHA256 in `vendor/manifest.json`; DMG itself gitignored); copy in via `tart run --dir=seed:…` (guest sees `/Volumes/My Shared Files/seed/`) or scp; install to `/Applications/Things3.app`. **Via Screen Sharing:** first launch (starts the 15-day clock → record ISO timestamp into metadata.json immediately); decline Things Cloud; Settings → General → enable Things URLs; capture auth token (harness cross-reads it from SQLite at run start); disable Things auto-update; fix view options to documented values.

**L3 — TCC pre-authorization [HUMAN]:** see §3. Grants land in guest TCC databases → every clone inherits.

**L4 — harness install (scripted):** `/Users/admin/things-lab/bin/`: probe runner, `disruption-monitor` (Swift, §4.2), `db-snapshot` helper; LaunchAgent `com.thingslab.disruption-monitor.plist` (gui domain, event stream to `events.ndjson`); `sdef /Applications/Things3.app > artifacts/Things-<version>.sdef`.

**L5 — Shortcuts proxy import [HUMAN]:** `shortcuts` CLI can run/list/sign but **cannot import** ([Apple docs](https://support.apple.com/guide/shortcuts-mac/import-shortcuts-apd02bffbaac/mac)); keep signed `.shortcut` exports in `lab/shortcuts/`, open each and click Add (~10 clicks); trigger each proxy once to absorb per-app consents; verify with `shortcuts list` over SSH. Enable Shortcuts → Advanced → Allow Running Scripts.

**L6 — curated synthetic seed dataset** (inside the golden, so every clone starts byte-identical): areas `LAB-AREA-A`/`LAB-AREA-B` (one tagged, for inheritance probes); tag taxonomy incl. hierarchy (`lab-tag-1`, `lab-tag-2`, `prio/high`, `prio/low`); projects (plain / with headings / mixed child states / completed+logged); to-dos in every state (inbox, today, evening `startBucket=1`, upcoming-dated, someday, checklists, completed, trashed); **repeating templates created in UI** (daily to-do, weekly project) — the crash-probe targets; all dates fixed relative to PINNED_DATE. Then: quit Things cleanly, snapshot DB, record schema fingerprint + UUID→role manifest.

**L7 — freeze:** `tart stop`; never boot the golden again except to rebuild. Scripted rebuild recipe is the real backup.

## 3. TCC / permissions pre-authorization

TCC grants are keyed to the *requesting process's* code identity. Two executor identities:

| Executor | Identity TCC sees | Used for |
|---|---|---|
| SSH-spawned commands | `sshd-keygen-wrapper` | MVP path for all probes |
| `disruption-monitor` + optional `probe-agentd` LaunchAgent (ad-hoc-signed Swift with stable identity) | the binary itself | In-session monitoring; fallback executor if any SSH context fails (most likely: `shortcuts run`) |

Grant matrix (all granted once in golden, L3):

| TCC service | Grantee → target | How granted |
|---|---|---|
| kTCCServiceAppleEvents (Automation) | sshd-keygen-wrapper → Things3 + System Events; monitor/agent → same | Trigger prompt via `osascript` over SSH while watching Screen Sharing; click Allow per pair |
| kTCCServiceAccessibility | disruption-monitor (+ sshd) | System Settings → Accessibility → add binaries |
| kTCCServiceScreenCapture | disruption-monitor (or sshd if screenshots via SSH `screencapture`) | Screen & System Audio Recording |
| Full Disk Access | sshd-keygen-wrapper (+ monitor) | Blanket grant for Group Container reads without macOS 14+ per-app-data prompts (pattern per [CircleCI](https://support.circleci.com/hc/en-us/articles/360057033612-Enabling-AppleScript-Support-on-macOS)) |

**Sequoia screen-capture monthly re-consent** would silently break screenshots ~a month after golden creation ([9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/)). Mitigation baked into L3: far-future approval date in `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist` ([tinyapps workaround](https://tinyapps.org/blog/202409180700_disable_sequoia_nag.html)); pinned-clock also freezes time inside the window. Screenshots are **best-effort evidence** — AX/window-list records are primary.

**Fully-scripted alternative (post-MVP hardening):** SIP-off via `tart run --recovery` + direct TCC.db row insertion (standard headless-CI technique). Row formats churn across macOS releases — treat as automation debt; the interactive click-through is ~10 clicks once per golden rebuild.

**Shortcuts specifics:** `shortcuts run` from SSH is expected to work given the auto-logged-in Aqua session — Phase-3 smoke item; fallback is `probe-agentd`. Proxy shortcuts may surface one-time per-app consent on first run — absorbed during seeding.

## 4. Probe methodology

### 4.1 Frame

Every probe is an **(operation × vector × app-state)** experiment producing one machine-readable evidence record. Vectors: `url`, `applescript`, `shortcuts` (+ `thingscli`). App-states set by harness before each probe: `not-running`, `running-background` (dedicated FocusHolder window frontmost), `frontmost`, `modal-open` (deliberately spawned URL-error modal — the T13 scenario). Default sweep: every probe runs at least `not-running` + `running-background`; disruption-sensitive probes run all four.

**Disruption tiers (first-class output, drives API gating):**

| Tier | Meaning | Detector |
|---|---|---|
| 0 | No observable app effect | no launch event, no frontmost change, no window delta |
| 1 | Launches app if closed (no focus steal) | NSWorkspace didLaunch, frontmost unchanged |
| 2 | Foregrounds / steals focus | NSWorkspace didActivate + frontmost-poll delta |
| 3 | Navigates visible UI or spawns modals/windows | CGWindowList delta; AX: new AXSheet/AXDialog, main-window title change |

Central hypotheses: (a) AppleScript `tell app "Things3"` auto-launches **in background without activation** → tiers 0–1 vs URL's tier 2 (T01 showed foregrounding); (b) Shortcuts' "Run Things URL" may execute without foregrounding — if true, Shortcuts becomes the low-disruption transport even for URL-semantics operations; (c) AppleScript reads are tier 0–1 and could replace some SQLite reads where liveness matters.

### 4.2 Guest instrumentation

- **disruption-monitor (Swift, ~300 lines, LaunchAgent):** NSWorkspace notifications (didLaunch/didActivate/didTerminate), 50ms frontmost polling, `CGWindowListCopyWindowInfo` snapshots filtered to Things, AX window reads (count, subrole, title, sheets). Emits NDJSON `{ts, kind, detail}` to `events.ndjson`. Probe runner brackets each probe with `MARK <probe-id> START/END` sentinels → evidence extraction is a log slice.
- **db-snapshot:** before/after each probe, dump rows of `TMTask`, `TMArea`, `TMTag`, `TMTaskTag`, `TMAreaTag`, `TMChecklistItem` (+ settings/meta) via read-only sqlite3, keyed by uuid; diff → `{inserted, deleted, changed:[{uuid,field,before,after}]}`. Ground-truth success/no-op/side-effect detector (`open` exit 0 proves nothing — validated).
- **Crash detector:** Things PID lifetime + new `.ips` in `~/Library/Logs/DiagnosticReports` (the T12 repeating-`when` crash becomes a *safe, desirable* probe — collect the report).
- **Screenshots:** `screencapture -x` on any tier ≥1 event and at probe end (best-effort).
- **Callback capture (Phase 5+ nice-to-have):** tiny scheme-handler app registering `probecb://`; pass `x-success=probecb://…` to capture `x-things-id` without DB polling.

**Evidence record schema (one JSON per probe execution):**
```json
{
  "probe_id": "A07", "legacy_ref": "T05", "vector": "applescript",
  "operation": "area.create", "app_state_before": "running-background",
  "params": {"name": "LAB-NEW-AREA"}, "command": "osascript -e '…'",
  "started_at": "…", "duration_ms": 412,
  "transport_result": {"exit_code": 0, "stdout": "…", "stderr": ""},
  "db_delta": {"inserted": [{"table": "TMArea", "uuid": "…", "title": "LAB-NEW-AREA"}], "changed": [], "deleted": []},
  "disruption": {"tier": 1, "events": [{"ts": "…", "kind": "launch"}], "screenshots": ["A07-01.png"]},
  "crash": null, "verdict": "supported",
  "env": {"things_version": "3.22.11", "macos": "15.6.1", "golden": "things-lab-golden-v3", "schema_fingerprint": "sha256:…", "pinned_date": "…"}
}
```
`verdict` ∈ supported | unsupported | silent-noop | partial | crash | disruptive-only.

### 4.3 AppleScript campaign (A-probes)

- **A00:** `sdef` dump; parse classes/commands/properties into a checklist; diff against the guide PDF (rev 17, 2018 — the sdef is authoritative for 3.22.x). *(Host-side inventory already done — see §8.)*
- **Creation:** A01 `make new to do` (insertion loci per sdef), A02 `make new project`, A03 `make new area`, A04 `make new tag`, A05 tag hierarchy via `parent tag`, A06 create with full properties bundle.
- **Reads:** A10 enumerate every built-in list incl. Logbook/Trash; A11 project/area children; A12 **repeating-template visibility** (the things.py blind spot); A13 tag lists incl. inherited-tag behavior vs T18; A14 `selected to dos` (UI-coupled read).
- **Mutation:** A20 rename/notes; A21 `schedule` (incl. **on repeating items — expect crash, capture it**); A22 `move` between lists/projects/areas; A23 status completed/canceled + Logbook timing; A24 `delete` to-do/project → verify `trashed=1`; A25 `delete` area → verify **permanent**; A26 `delete` tag; A27 `empty trash`; A28 `log completed now`; A29 to-do⇄project conversion attempts (expected unsupported); A30 checklist access (expected absent); A31 heading access (expected absent).
- **Disruption:** every A-probe in `not-running` + `running-background`; A40 explicitly: does an AppleEvent to closed Things launch it backgrounded? Does `activate` differ? Do URL-error modals block AppleEvents (T13 cross)?
- **A50+ (undocumented surfaces — see §8):** `_private_experimental_ reorder to dos in`; `to do._private_experimental_ json`; `parse quicksilver input`; `edit` / `show quick entry panel` (expected tier 3 — document); full dynamic `thingscli` surface.

### 4.4 Shortcuts campaign (S-probes)

- **S00 enumeration:** in-guest action inventory (+ screenshot; cross-check [official list](https://culturedcode.com/things/support/articles/9596775/)).
- **Proxy architecture:** shortcuts cannot be authored programmatically → ~8 parameterized proxies built once (L5): input JSON → `Get Dictionary from Input` → bind fields → Things action → serialize output. Invoke: `shortcuts run "things-proxy-create-heading" -i params.json -o out.json`. Where a field refuses dictionary binding (enums/dates), fall back to per-scenario static shortcuts. Proxies: create-todo, create-project, **create-heading**, edit-items, delete-items, duplicate-items, find-items, run-things-url.
- **Probes:** S01–S03 create to-do/project/heading (heading-in-existing-project is the marquee capability); S04 edit-items across its 11 properties (incl. repeating items — crash check); S05 delete-items for task/project/**heading** → DB delta (trash vs hard-delete vs archive); S06 duplicate; S07 find/get → structured output fidelity (UUIDs? doubles as read API?); S08 Run Things URL → foregrounding vs `open`?; S09 `shortcuts run` transport behavior from SSH vs LaunchAgent, Shortcuts.app's own focus cost, latency.
- **Gate:** Shortcuts earns API residency only where sole-vector (headings) or strictly lower-tier.

### 4.5 URL scheme re-validation (U-probes)

Re-encode T01–T20 as scripted probes (U01–U20 with `legacy_ref`), now instrumented: exact disruption tiers per command, modal detection via AX, DB-delta verdicts, plus previously-skipped hazardous cells: full T12 sweep (every field × repeating config, crash reports collected), T10 (heading JSON update), T19/T20 logged-item edges. Add U21+: x-callback behavior (`x-things-id` capture), `things:///json` full operation grid, auth-token failure modes, URL-encoding hazards (emoji, newlines, 8KB+ payloads), `open -g` (background-open flag — potential tier reduction for the whole URL vector).

### 4.6 Cross-vector probes (X-probes)

X01 create-via-AppleScript → update-via-URL → read-via-SQLite (UUID identity stable); X02 AppleScript mutations while URL-error modal open; X03 rapid interleave across vectors (ordering/atomicity); X04 delete + re-add identity checks; X05 vector behavior during app cold-start races.

### 4.7 Output: capability matrix v2

Generator consumes all evidence records → emits:
- `capability-matrix-v2.json` (machine-readable; `operation → vector → {support, disruption_tier_by_app_state, evidence_refs, hazards}`)
- `docs/atlas/capability-matrix-v2.md` (rendered; supersedes matrix v1: object, operation, url, applescript, shortcuts, best-vector, min-tier, hazards)
- **API gating spec:** tier 0–1 → default-allowed; tier 2 → `allowFocusSteal`; tier 3 → `allowUIDisruption`; crash-prone cells → hard-blocked with named error; delete/empty-trash → `dangerouslyPermanent`. The matrix JSON is imported by the API build — gates are generated, not hand-maintained.

## 5. CI orchestration

### 5.1 Host runner (`lab/runner/`, TypeScript)

`lab:run [--suite url|applescript|shortcuts|all] [--keep-vm] [--live-clock]`:

**preflight** (TART_HOME volume + free space ≥ threshold; golden exists; trial window valid for live-clock mode; host keychain unlocked) → **clone** → **boot** (`tart run --no-graphics --net-host`, poll `tart ip` then TCP 22, timeout 180s) → **bootstrap** (pin clock; verify monitor LaunchAgent; Things warm-up launch + quit — recomputes Today buckets, prior quirk #5; baseline DB snapshot; **assert schema fingerprint vs metadata.json, abort on mismatch**) → **execute** (push suite bundle; run probes serially; stream NDJSON evidence) → **collect** (evidence, events.ndjson, screenshots, guest DB copy, crash reports, `shortcuts list`, sdef → `lab/artifacts/<runid>/`; JUnit XML of verdicts vs expected matrix) → **teardown** (`tart delete`; `--keep-vm` for debugging; `lab:gc` deletes stray `run-*` VMs).

Regression mode = same harness, expectations locked to capability-matrix-v2.json: any verdict/tier delta fails. That is the CI regression harness — it detects Things/macOS updates silently moving the write surface.

### 5.2 Determinism controls

Golden-frozen dataset + pinned clock + airgapped `--net-host` + updaters/indexers disabled + serialized probes + app-state reset between probes (`pkill Things3` is the canonical modal-clear/reset primitive) + versioned golden with fingerprint asserted at bootstrap.

> **Empirical correction (2026-07-03, Lab-3):** `--net-host` on current Tart is implemented via Softnet and requires passwordless root on the **host** ("root privileges are required … Softnet process terminated prematurely"); the Lab-1 smoke only verified the flag existed, not that it boots. Everywhere this document says "airgapped `--net-host`", the shipped harness instead boots on default NAT and airgaps **guest-side** at bootstrap: `sudo route -n delete default` (SSH survives on the directly connected vmnet subnet; internet becomes unroutable, verified by a failed ping every run). See docs/lab/harness.md.

### 5.3 Intentional-drift workflow (new Things release)

1. Download new trial DMG → `vendor/manifest.json` update.
2. `tart clone golden-vN golden-v(N+1)` → boot with network → install new Things over old → **check trial clock inheritance** (DRIFT-1 open question: does an in-place update inherit the old trial clock? if yes, rebuild from L0) → re-dump sdef, re-fingerprint → freeze.
3. Full probe suite on v(N+1); diff matrix v2(N+1) vs (N) → human-readable drift report.
4. Promote golden; keep vN (COW-cheap) until the API is migrated.

### 5.4 GitHub Actions (note only, non-MVP)

The design is runner-shaped: a self-hosted GHA runner on this Mac executing `lab:run` works as-is (runner in a logged-in GUI session for the keychain constraint; concurrency 1). Orchard exists if this outgrows one host. Nothing in the MVP couples to GHA.

## 6. Risk register

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| R1 | Trial expiry bricks writes mid-campaign | High×High | Pinned-clock airgapped runs (default); write-canary at bootstrap; rebuild runbook; CC extension request |
| R2 | Trial build ≠ MAS build (container/sandbox/features) | Low×High | Phase-2 parity probe; divergences encoded in matrix metadata; production API targets the MAS build on host |
| R3 | Sequoia monthly screen-capture re-consent kills screenshots | Med×Low | ScreenCaptureApprovals.plist far-future date; AX evidence primary |
| R4 | TCC prompts reappear after updates (bundle identity change) | Med×Med | Guest OS updates disabled; drift runbook re-verifies; automation smoke probe runs first in every suite |
| R5 | Disk exhaustion on VM volume | Med×Med | Preflight free-space gate; prune OCI cache post-golden; artifacts host-side; `lab:gc`; SSD fallback trigger |
| R6 | 2-VM ceiling wedged by orphan clone | Med×Low | Teardown in `finally`; gc sweep at preflight; never parallelize |
| R7 | `shortcuts run` unusable from SSH | Med×Med | probe-agentd LaunchAgent fallback executor designed in |
| R8 | Host keychain locked when runner starts | Med×Low | Preflight check + `security unlock-keychain`; runner runs from GUI login session |
| R9 | Crash probes corrupt guest DB mid-suite | Low×Low | It's a clone; crash probes quarantined into a dedicated final probe group (or own clone) |
| R10 | Volume disconnect mid-run corrupts running clone | Low×Med | Golden is stopped/never written; clones disposable; preflight volume check |
| R11 | Tart licensing misread | Low×Low | Verified: Fair Source, personal-workstation use royalty-free |
| R12 | Pinned clock artifacts (cert/timestamp weirdness) | Low×Low | Airgapped runs need no TLS; small live-clock smoke subset runs periodically |

## 7. Lab phase plan

**[HUMAN]** marks one-time manual steps.

- **Lab-0 — Host prep (½ day):** disk reclamation per user decision; `brew install cirruslabs/cli/tart`; `TART_HOME=/Volumes/Workspace/tart`; pull vanilla image (validates disk budget).
- **Lab-1 — Boot/access smoke (½ day):** scratch VM `--no-graphics`; `tart ip` + SSH; Screen Sharing; confirm Aqua session headless (frontmost query succeeds); `--net-host` keeps SSH with internet dead; `--dir` share visible; **dynamic `thingscli` probe** (install trial Things in scratch, run bare/help/defaults variants, document — early wheel-reinvention gate); delete scratch. Exit: scripted clone→boot→ssh→delete loop <3 min.
- **Lab-2 — Golden v1 (1–2 days):** L0–L7. **[HUMAN]**: Things first launch + settings + token; TCC click-through; Shortcuts import + consents; seed-dataset UI portions (repeating templates, headings). Deliverables: frozen golden, metadata.json, sdef artifact, seed manifest, rebuild runbook. P0-3 container-parity probe answered.
- **Lab-3 — Harness MVP + URL re-validation (2–3 days):** monitor, differ, evidence schema, runner; U01–U20 scripted. Exit: **U-suite reproduces matrix v1 unattended, twice, identical verdicts** (the harness's own acceptance test).
- **Lab-4 — AppleScript campaign (2–4 days):** A00–A50+ incl. deliberate crash probes.
- **Lab-5 — Shortcuts campaign (2–3 days):** proxies (golden v2 if they change → **[HUMAN]** re-import), S00–S09.
- **Lab-6 — Matrix v2 + gating spec (1 day):** generator, rendered doc, gate JSON, drift-diff tooling.
- **Lab-7 — CI hardening (1–2 days):** JUnit, expectation lockfile, `lab:gc`, trial watchdog, drift runbook exercised once end-to-end. **Green CI = one command, zero interaction, clone→probe-all→matrix-diff-clean→artifacts→teardown, exit 0.**

## 8. Kickoff addendum: host-side static analysis (2026-07-02)

Performed read-only on the host's Things 3.22.11 bundle after the main design:

**`Things3.app/Contents/MacOS/thingscli`** (~230KB, universal, stripped):
- Sandboxed with `com.apple.security.app-sandbox` + group `JLMPQHK86H.com.culturedcode.ThingsMac` — it operates on the Things data container.
- arm64 `__cstring` contents: version stamp `3.22.11`/`32211507`; settings keys `calendarEventsEnabled`, `remindersInboxEnabled`; error strings `thingscli: unsupported command '…'`, `thingscli: no command provided`, `defaults: unsupported subcommand '…'`, `defaults read: key '…'`, `Domain not found`.
- Verdict: a **settings/diagnostics utility** (`defaults` read/write over Things' settings domain), not a task-CRUD interface — this project is not reinventing an existing wheel. Caveat: Swift inlines string literals ≤15 bytes into code, so short hidden subcommand names are statically invisible → the Lab-1 dynamic probe remains the definitive enumeration.
- Not referenced by the main `Things3` binary; not on PATH; no XPC automation services in the bundle (the `.appex` extensions are widgets/share/intents).

**`Things3.app/Contents/Resources/Things.sdef`** inventory:
- Commands: `make, move, schedule, delete, duplicate, edit, empty trash, log completed now, show, show quick entry panel, parse quicksilver input, add contact named, filter by next top tag, filter by previous top tag, close, count, exists, get localized string, print, quit` — plus **`_private_experimental_ reorder to dos in`**.
- Classes: `application, area, contact, list, project, selected to do, tag, to do, window`. **No heading or checklist classes** (consistent with CC docs; headings stay Shortcuts-only, checklists URL-only).
- `to do` properties: `id, name, creation date, modification date, due date, activation date, completion date, cancellation date, status, tag names, notes, project, area, contact` — plus **`_private_experimental_ json`**.
- `tag` properties: `id, name, keyboard shortcut, parent tag`. `area` properties: `tag names, collapsed` (+ inherited).
- The two `_private_experimental_` surfaces are high-priority A50+ probes: native reorder would obsolete the bounce hack (treat as version-fragile, gate behind experimental config); the json property may expose checklist/repeat data invisible elsewhere.

## Sources

- Apple: https://support.apple.com/en-us/120468 · Eclectic Light: https://eclecticlight.co/2024/07/12/sequoia-virtualisation-and-apple-id/
- Things: trial https://culturedcode.com/things/support/articles/2803551/ · App Store exclusivity …/2803552/ · AppleScript …/4562654/ + Things3AppleScriptGuide.pdf · Shortcuts …/9596775/
- Tart: https://tart.run/quick-start/ · /faq/ · /licensing/ · https://github.com/cirruslabs/macos-image-templates · APFS clones: https://eclecticlight.co/2020/04/14/copy-move-and-clone-files-in-apfs-a-primer/
- Shortcuts CLI: https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac · import: …/apd02bffbaac/mac
- TCC in CI: https://support.circleci.com/hc/en-us/articles/360057033612-Enabling-AppleScript-Support-on-macOS · Screen-capture nag: https://tinyapps.org/blog/202409180700_disable_sequoia_nag.html
