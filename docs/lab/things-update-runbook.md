# Things-update runbook — recertifying after a new Things release

What to do when Cultured Code ships a new Things version (routine 3.22.x patch or the anticipated major release alongside macOS 27). Written 2026-07-09 as part of the hardening pass; companion to [drift-runbook.md](drift-runbook.md) (which covers the *schema fingerprint* mechanics — this runbook is the full recertification sequence around it).

## THE RUN LIST — follow top-to-bottom when a new version appears

*Established 2026-08-22 during the Things 3.23 cycle (the maintainer's directive: "so the next time this happens, we can follow a script"). This is the operational spine; the sections below it carry the detail. **Extend this list in the same change as any new step the next cycle invents.***

1. **Read the release intent.** CC's blog/release notes name the epicenter before any probe does (3.23: "Repeating to-dos, refined" → repeat-dialog overhaul, GUI-only features).
2. **Bank the installer IMMEDIATELY.** The direct-download URL is UNVERSIONED (`static.culturedcode.com/things/Things3.zip`) — old builds vanish the moment a new one ships. Download, read `CFBundleShortVersionString`/`CFBundleVersion` from the zip's Info.plist, store as `/Volumes/Workspace/things-releases/Things3-<version>-<build>.zip` (LOCAL archive only — the binaries are not ours to distribute, never committed).
3. **Parity + vendor staging.** sdef sha256: trial vs host MAS vs the previously recorded value (unchanged = zero new AppleScript surface — settles the automation-impact question in seconds). Update `vendor/manifest.json` (sha256, version, build, hostMasBuild, parity note) and stage the zip at `vendor/Things3.zip` for the golden build.
4. **Triage the host.** `things doctor --json`: databaseVersion, fingerprint status, behavioral line. A write block (`unknown database version` / `drift`, exit 5) is the gate WORKING — zero mutation, no panic.
5. **If `databaseVersion` bumped — bank the DB pair BEFORE the backups age out.** Things keeps ~10 daily backups in `<container>/ThingsData-*/Backups/`; the newest pre-update one is the last old-version database, free of charge (no Time Machine needed). Copy it, plus a consistent post-migration snapshot of the live db (`/usr/bin/sqlite3 -readonly <live> ".backup '<dest>'"`), into `/Volumes/Workspace/things-db-archive/` (personal data: chmod 700, NEVER committed). Verify both version stamps — backups open with the `file:…?immutable=1` URI (a plain read-only open fails on them).
6. **Measure the migration (the DBV27 method).** Against the banked pre-update backup: (a) full `sqlite_master` diff — this catches index/trigger changes the fingerprint deliberately ignores; (b) per-column changed-row counts joined on uuid (counts ONLY, never content — the evidence doc is public); (c) transition shapes for every mass-changed column (null→val / val→null / direction / fixed delta). Bank as an immutable `docs/lab/` evidence doc. Precedent + query recipes: [dbv27-migration-diff.md](dbv27-migration-diff.md).
7. **Baseline decision.** Fingerprint identical → ship the new-version baseline same-day reusing the hash (decisions.md 2026-08-22 ruling — the honest unblock, no `accepted-fingerprint` hatch); fingerprint drifted → the [drift-runbook](drift-runbook.md) path (author the baseline, do NOT ship until regress is green). Either way `certified-app-version` does NOT move yet — the passive behavioral notice is the standing reminder.
8. **Sweep engine dependencies of every migrated column.** `grep -rn <column> src/` for each column the migration touched: a retired or re-semanticized column the engine reads is a code break to fix before recertification (3.23: `rt1_nextInstanceStartDate` retired → the TMPLSORT/PTMPL projection-day break).
9. **Mint the candidate golden** (`golden-build.sh v<N+1>` + [golden-runbook.md](golden-runbook.md) seeding; DRIFT-1: build from the fresh base — never inherit a prior trial clock).
10. **Prove it**: `npm run lab:regress` + guest e2e against candidate-golden clones; full verdict table diffed against the prior golden's expectations. AX-census any redesigned surface (dialog trees, new choosers) BEFORE touching recipes — the census doc drives the rewrite.
11. **Reconcile deliberately** (never mid-campaign): suite expectations, assumption-register walk + *Confirmed under*, capability-matrix, oddities/craft entries, simulator/bench re-model ([drift-runbook](drift-runbook.md) step 5). THEN `things config set certified-app-version <version>` and a things-api release whose CHANGELOG names the newly certified Things version.
12. **Optional completeness:** bank the app's own first new-version daily backup (it lands the next midnight) alongside the step-5 snapshot.

## Standing defenses (already shipped — what fires on its own)

| Layer | Mechanism | What it catches |
|---|---|---|
| Schema | fingerprint gate (`db/fingerprint.ts`, baselines keyed by `databaseVersion`) | ANY table/column change hard-blocks writes (exit 5) until a new baseline is validated |
| App identity | environment tuple (`write/environment.ts`) | a Things/macOS/node change since the last verified write reclassifies failures (`app-updated`) and warns in doctor |
| Repeat rules | `rrv` strict decode + doctor `repeats:` canary | a repeat-rule format change surfaces as undecodable-template counts instead of silently misread rules |
| Private surface | sdef canary (`write/experimental.ts`) | the `_private_experimental_` reorder command vanishing blocks native reorder with a clear reason |
| Behavior | verified pipeline (read-after-write on every mutation) | ANY silent behavioral change fails the mutation loudly (exit 3) rather than pretending success |
| URL scheme | on-disk `uriSchemeEnabled` (availability layer) | a moved/renamed preference key degrades to `unknown` (never a false "enabled") |

## Version pinning (do this BEFORE any release drops)

- **Automation hosts hold their Things version** until this runbook has been completed for the new release. Direct-download installs: Things > Settings > General > uncheck automatic updates (Sparkle). Mac App Store installs: System Settings > App Store > disable automatic app updates (host-wide — prefer the direct download on dedicated automation machines for per-app control).
- The lab-certified version list lives in the golden metadata; the current certified app is **Things 3.22.14** (golden-v3, build 32214000) on macOS 15.7.7 — a behavioral-only advance over 3.22.12/3.22.11 (schema + sdef byte-identical throughout). See [golden-v3-metadata.json](golden-v3-metadata.json) + [gv3-certification.md](gv3-certification.md); the in-place DRIFT-1 swap path (clone the prior golden, `ditto -xk` the new app zip over `/Applications/Things3.app`, warm-up, re-fingerprint) is the routine recipe when a point release is schema-identical.

## Recertification sequence (new release drops)

1. **Do not update any automation host.** Snapshot current state: `things doctor --json > pre-update-doctor.json` on a lab clone.
2. **Stage the new app in the lab**: on a NETWORKED throwaway VM (never the golden), download the new Things build; copy the .app out to `lab/apps/Things3-<version>.app` (host-side stash). The golden stays frozen.
3. **Build a candidate golden**: follow [golden-runbook.md](golden-runbook.md) with the new app version (fresh consents, proxies re-imported from `shortcuts/*.shortcut` — one Add-Shortcut click each — trial-window pinning as usual).
4. **Fingerprint first** (cheapest signal): open the new DB, note `databaseVersion` + fingerprint. If drifted: follow [drift-runbook.md](drift-runbook.md) — diff the schema (`observeSchema` detail), author the new baseline, and DO NOT accept it until step 5 is green.
5. **Full behavioral regress**: `npm run lab:regress` (all suites + guest e2e — now incl. every reorder scope) against candidate-golden clones. Diff every verdict against the prior release's results. Any flip (WORKS→dead, dead→WORKS, convention change) gets banked in the affected campaign doc + capability-matrix before proceeding.
6. **Surface catalogs re-swept**:
   - **sdef diff**: dump the new app's sdef, diff against the stored one (private-command inventory, new verbs, new classes — a heading class appearing would be headline news).
   - **URL/TJSON**: re-run the T/U-suite probes; try the historically-dead shapes that CC might have fixed (heading create/move — HX shapes; repeat params; sidebar ordering).
   - **Shortcuts action catalog**: L5 Card-5 procedure (insert every Things action, note parameters) — new actions or new parameters (repeat rules in Shortcuts would fill the Repeating-items gap in the capability matrix).
   - **Crash catalog re-check** (oddities §7): do the schedule-class crashes still reproduce? A fix changes our guard story (keep guards, note the fix version).
7. **Repeat rules deep-check**: dump every template rule blob from a live-ish DB copy, `decodeRecurrenceRule` each (the doctor canary does this), and if CC changed repeat handling (they hinted at it): capture the new format corpus, extend the decoder behind the version gate (`KNOWN_RULE_VERSION`), and re-validate the deadline model against app-spawned instances before trusting projections.
8. **Certify**: update golden metadata + this runbook's certified-version line, add the fingerprint baseline, update capability-matrix/oddities with any deltas, publish a things-api release whose CHANGELOG names the newly certified Things version.

## Priority signals for the "Things 4 / macOS 27" scenario

- CC correspondence hints at **repeating-task changes** → step 7 is the likely epicenter; the `rrv` gate is the tripwire.
- New OS-level agent surfaces (App Intents expansion) → track in [../design/apple-intelligence-research.md](../design/apple-intelligence-research.md); a richer App Intents catalog could graduate Shortcuts-only capabilities to first-class (or obsolete the proxy pattern entirely).
- A major version may migrate the store (new `databaseVersion`, possibly a new container). `locateThingsDb` discovery + fingerprint block writes on day one by design; reads may need a new atlas pass.
