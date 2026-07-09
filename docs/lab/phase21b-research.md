# Phase 21b research — environment probes + piggyback wish-list verdicts

Bespoke research scripts (suite-DSL probes fit entity mutations; TCC/defaults/settings lifecycles fit scripted phases better): [`lab/scripts/research-phase21b-a.sh`](../../lab/scripts/research-phase21b-a.sh) (autonomous, consent-preserving) and [`lab/scripts/research-phase21b-b.sh`](../../lab/scripts/research-phase21b-b.sh) (phased, consent-destroying, human clicks in Screen Sharing). Golden: `things-lab-golden-v1` (Things 3.22.11, macOS 15.7.7, clock pinned 2026-07-05). Disposable clones only.

## Script A — run `things-run-p21ba-20260709-002050` (2026-07-09)

### [D] Discovery

| Fact | Value | Consequence |
|---|---|---|
| Guest SIP | **enabled** | No direct guest TCC.db writes — the *denied* TCC signature needs a human "Don't Allow" click (script B `tcc` phase). |
| `defaults read com.culturedcode.ThingsMac` | **no URI/URL/scheme/token keys** (full dump in artifacts) | No known `defaults write` path to toggle "Enable Things URLs" — lifecycle probes use Settings-pane clicks (script B `url-off`/`url-on` phases). |
| `TMSettings.uriSchemeAuthenticationToken` | present, 22 chars | Baseline for the lifecycle probes; Phase 21a's NULL-token ⇒ `feature-disabled` heuristic is what script B tests. |

### Piggyback wish-list probes (all conclusive)

| # | Probe | Verdict | Evidence (artifacts `lab/artifacts/things-run-p21ba-20260709-002050/`) |
|---|---|---|---|
| A1 | Tags on a project via URL `update-project?tags=` | **WORKS** | `TMTaskTag` row (project uuid ↔ `lab-tag-1`) + AppleScript `tag names of project id` reads it back. Pre-existing-tag rule presumed to match to-dos (unprobed here). |
| A2 | Tags on a project via AppleScript `set tag names of project id` | **WORKS** | `TMTaskTag` row (project uuid ↔ `lab-tag-2`). |
| A3 | Project reminder via `update-project?when=today@14:30` | **WORKS** | Project row got `startDate=132805248` (the pin day) and `reminderTime=970981376` = `14<<26 \| 30<<20` — exactly the R-suite codec. |
| A4 | Tag keyboard-shortcut CLEAR via `delete keyboard shortcut of tag` | **WORKS** | `TMTag.shortcut` `'7'` → NULL; the P29 property-delete form generalizes. |
| A5 | Permanent single delete: second AppleScript `delete to do id` on a trashed row | **FAILS** (this spelling) | `-1728 Can't get to do id "…"` — the *delete* verb can't address a trashed row by bare `to do id` (yet `move to do id` can, E15). Row intact, no tombstone. Respellings via `list "Trash"` → script B [B0]. |
| A6 | Inbox reorder via `_private_experimental_ reorder to dos in list "Inbox"` | **WORKS** | Post-order matched the requested full reversed wire list exactly (index column re-ranked). Inbox joins today/project/area as a validated native-reorder scope. |

## Script B — run `things-run-p21bb-…` (phased; fill per phase)

### [B0] Permanent-delete respellings

_Pending._

### [B1–B3] Enable-Things-URLs lifecycle

**B1 baseline (URLs ON):** token present (`9dFi9fY-QBuqFq59yAUxOg`, 22 chars); URL write with token lands normally.

**B2 (URLs OFF) — the big correction:**

- **Token is NOT nulled when the feature is disabled.** Full `TMSettings` row while off: token still `9dFi9fY-QBuqFq59yAUxOg`, `groupTodayByParent=0`, `experimental` empty. ⇒ **Phase 21a's "token-less URL no-op ⇒ feature-disabled" heuristic is unsound** — a populated token does not imply the scheme is enabled.
- **No `defaults` key changed** (empty diff baseline→off). The toggle lives in app-internal state, not NSUserDefaults nor a visible TMSettings column.
- **Disabled-write signature = a tier-3 modal, not a silent no-op.** A `things:///add` while off raises **"Things URL Scheme — Things has been opened via the URL Scheme. Do you want to enable this feature? You can change it later in Settings → General."** with **Cancel · Enable** (screenshot: `lab/artifacts/things-run-p21bb-20260709-002645/disabled-write-modal.png`). The write is HELD pending the choice — no DB row appeared for either the token or no-token write. Two writes → two window-new monitor events (66, 67). **Cancel** discards the write and leaves the feature off. So the real availability signal is *this modal / the write not landing on read-after-write*, and it's the same for both authenticated and unauthenticated writes.

**B3 (URLs back ON via the Settings checkbox):**

- **Token does NOT rotate** across an off→on cycle (`9dFi9fY-QBuqFq59yAUxOg` before and after). The old token works immediately on re-enable (`R21B-OLDTOK-1` landed).
- The two disabled-write modals (windows 66/67) closed on Mike's Cancels; window 65 "General" is the Settings pane.

### Where the enabled/disabled state actually lives (Mike's question)

**Key `uriSchemeEnabled` (integer bool) in the group-container preferences plist:**

```
~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist
```

- Reads `1` when enabled (snapshot `groupcontainer-prefs-url-on.txt`); the plist mtime updated to the exact minute of the re-enable click. **Off-value `0` is inferred** (key name + mtime; Mike opted to skip the confirming toggle — a one-click re-confirm if ever doubted).
- **Not** in the standard `com.culturedcode.ThingsMac` domain, **not** a TMSettings column (full row/schema dumped — only `logInterval`/`manualLogDate`/`groupTodayByParent`/`uriSchemeAuthenticationToken`/`experimental`), **not** in NSUserDefaults visible to `defaults read` over a headless SSH session (cfprefsd doesn't serve the group container to a non-GUI session). **Reliable read path = `plutil -p` on the plist file directly.**
- Same plist also holds **`intentsSkipsConfirmationForEditingOrDeletingLargeAmountsOfData => 1`** — the "Allow Shortcuts to edit large amounts of data without confirmation" toggle (a deferred S-campaign probe, runbook §5 / L5 Card 3).
- **Availability-layer use:** doctor/planner can read `uriSchemeEnabled` to report URL-scheme availability *proactively* (vs. reactively via the modal / a non-landing write). **Prod caveat:** on the host this is a *new read shape against the Things group container* — the safety rails forbid ad-hoc shapes there (TCC re-prompt); it needs a single stable `prod-read.sh`-style wrapper, not an inline `plutil`.

**Net correction to Phase 21a:** the `feature-disabled` classifier must key on `uriSchemeEnabled=0` (disk) and/or the non-landing write + enable-modal, **not** on a null token — the token persists while disabled.

### [B0] Permanent-delete respellings

**Single-item permanent delete is DEAD on AppleScript** (confirms A5). Against an already-trashed row, three spellings all fail to permanently remove it:

- `delete to do id X` → `-1728 Can't get to do id "X"` (the delete verb can't re-address a trashed row by bare `to do id`).
- `delete (first to do of list "Trash" whose id is X)` → silent no-op (row intact).
- `delete to do id X of list "Trash"` → silent no-op (row intact).

Row present, zero tombstones after all three. Verdict: **no single-item permanent-delete surface exists** on AppleScript; only `trash.empty` (all-or-nothing) hard-deletes. (URL/Shortcuts hard-delete unprobed — Shortcuts delete-toggle wording is an L5 Card 3 note.)

### [B4] TCC consent signatures — all four grounded in the VM

Golden has SIP enabled, so no programmatic deny-row insert — the denied signature required a genuine "Don't Allow" click (Mike). Signatures, as Phase 21a's `failure-hints.ts` classifies them:

| State | How produced | Observed signature | Phase 21a mapping |
|---|---|---|---|
| **granted** | baseline (image default, sshd→Things auth_value=2) | osascript exit 0, returns `count of areas` | — |
| **pending** (deadline-kill) | `tccutil reset AppleEvents`, then osascript killed at a short deadline | non-zero exit, **empty output**, wall-time = the deadline | `timedOut` ⇒ `permission-pending` |
| **pending** (AppleEvent self-timeout) | reset, osascript left to run; the AppleEvent itself times out before any click | **`-1712` AppleEvent timed out** | `-1712` ⇒ `permission-pending` |
| **denied** | reset, hold prompt open (`with timeout of 180 seconds`), click **Don't Allow** | **`-1743` Not authorized to send Apple events to Things3** | `-1743` ⇒ `permission-denied` |

**Key discriminator confirmed:** once denied, the retry fails **instantly (0s)** with `-1743` — no hang. Pending hangs until a deadline. So deadline-kill-with-no-output ⇒ pending, instant-`-1743` ⇒ denied — exactly the split Phase 21a assumes. The `-1712` finding adds a second pending signature (the AppleEvent's own timeout, distinct from our deadline kill) that Phase 21a already maps correctly.

**Prompt-longevity gotcha (for future consent probes):** a short-timeout osascript's prompt auto-dismisses on the AppleEvent timeout (~seconds) before a human can click. Hold the prompt open with `with timeout of <long> seconds` so the click window stays open.
