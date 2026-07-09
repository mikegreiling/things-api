# Things-update runbook — recertifying after a new Things release

What to do when Cultured Code ships a new Things version (routine 3.22.x patch or the anticipated major release alongside macOS 27). Written 2026-07-09 as part of the hardening pass; companion to [drift-runbook.md](drift-runbook.md) (which covers the *schema fingerprint* mechanics — this runbook is the full recertification sequence around it).

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
- The lab-certified version list lives in the golden metadata (`golden-v1-metadata.json`); the current certified app is **Things 3.22.11** on macOS 15.7.7.

## Recertification sequence (new release drops)

1. **Do not update any automation host.** Snapshot current state: `things doctor --json > pre-update-doctor.json` on a lab clone.
2. **Stage the new app in the lab**: on a NETWORKED throwaway VM (never the golden), download the new Things build; copy the .app out to `lab/apps/Things3-<version>.app` (host-side stash). The golden stays frozen.
3. **Build a candidate golden**: follow [golden-runbook.md](golden-runbook.md) with the new app version (fresh consents, proxies re-imported from `shortcuts/*.shortcut` — one Add-Shortcut click each — trial-window pinning as usual).
4. **Fingerprint first** (cheapest signal): open the new DB, note `databaseVersion` + fingerprint. If drifted: follow [drift-runbook.md](drift-runbook.md) — diff the schema (`observeSchema` detail), author the new baseline, and DO NOT accept it until step 5 is green.
5. **Full behavioral regress**: `npm run lab:regress` (all suites + guest e2e — now incl. every reorder scope) against candidate-golden clones. Diff every verdict against the prior release's results. Any flip (WORKS→dead, dead→WORKS, convention change) gets banked in the affected campaign doc + capability-matrix before proceeding.
6. **Surface catalogs re-swept**:
   - **sdef diff**: dump the new app's sdef, diff against the stored one (private-command inventory, new verbs, new classes — a heading class appearing would be headline news).
   - **URL/TJSON**: re-run the T/U-suite probes; try the historically-dead shapes that CC might have fixed (heading create/move — HX shapes; repeat params; sidebar ordering).
   - **Shortcuts action catalog**: L5 Card-5 procedure (insert every Things action, note parameters) — new actions or new parameters (repeat rules in Shortcuts would close gaps.md §2).
   - **Crash catalog re-check** (oddities §7): do the schedule-class crashes still reproduce? A fix changes our guard story (keep guards, note the fix version).
7. **Repeat rules deep-check**: dump every template rule blob from a live-ish DB copy, `decodeRecurrenceRule` each (the doctor canary does this), and if CC changed repeat handling (they hinted at it): capture the new format corpus, extend the decoder behind the version gate (`KNOWN_RULE_VERSION`), and re-validate the deadline model against app-spawned instances before trusting projections.
8. **Certify**: update golden metadata + this runbook's certified-version line, add the fingerprint baseline, update capability-matrix/oddities with any deltas, publish a things-api release whose CHANGELOG names the newly certified Things version.

## Priority signals for the "Things 4 / macOS 27" scenario

- CC correspondence hints at **repeating-task changes** → step 7 is the likely epicenter; the `rrv` gate is the tripwire.
- New OS-level agent surfaces (App Intents expansion) → track in [../design/apple-intelligence-research.md](../design/apple-intelligence-research.md); a richer App Intents catalog could graduate Shortcuts-only capabilities to first-class (or obsolete the proxy pattern entirely).
- A major version may migrate the store (new `databaseVersion`, possibly a new container). `locateThingsDb` discovery + fingerprint block writes on day one by design; reads may need a new atlas pass.
