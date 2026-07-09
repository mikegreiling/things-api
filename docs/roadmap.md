# things-api roadmap & parked work

Durable plan (survives context compaction). Written 2026-07-09. Everything shipped through v0.6.0 lives in CHANGELOG / the living docs; this file tracks what is DECIDED-BUT-UNBUILT, PARKED, or awaiting Mike. Update as items land.

## ⟹ RESUME HERE (post-compaction order)

1. **Publish v0.6.0 to npm.** Prepared (package.json/lock + `PKG_VERSION` at 0.6.0, CHANGELOG 0.6.0 section dated 2026-07-09) but NOT tagged/published — needs Mike's `npm login` + OTP. Steps: confirm `npm run check` green → `npm pack --dry-run` (watch for the npm-11 bin warning, see memory `npm11-bin-path-quirk`) → `git tag v0.6.0` → `npm publish --access public --otp=<code>`.
2. **§A Shortcuts onboarding** — the biggest gap; Mike wants the setup/share plan (below) actioned.
3. **§B availability layer** (greenlit, straightforward).
4. **§C e2e reorder coverage** + **§D project-schedule vector** (small).
5. **§F comprehensive reference compendium** (Mike's "reference book" goal).

Headings doctrine (§E) is DECIDED below — no flatten mode. Tag/area emoji-archival first-class support is SHELVED indefinitely (Mike, item 4).

---

## §A. Shortcuts onboarding & distribution

### What is truly Shortcuts-only (the reason onboarding matters)
Three capabilities exist on NO other surface (everything else — heading rename/archive/delete/reorder, placement under existing headings, etc. — now works via AppleScript/URL, see docs/lab/heading-research.md):
1. **Create a heading in an EXISTING project** (S02) — the marquee gap. AppleScript has no `make heading` (A31); URL `heading=` never creates (T09). Headless once consented (output-class).
2. **Clear a reminder from a DATE-scheduled item** (P3b) — AppleScript has no reminder property (⛔); URL can't clear dated reminders (oddity 2e). Headless.
3. **Permanently delete ONE item** (S-delperm) — interactive-only (delete-class consent has no Always-Allow); AppleScript's only hard-delete is all-or-nothing `trash.empty`.

So onboarding unlocks (1) and (2) headlessly; (3) stays user-present regardless.

### The six proxy shortcuts (golden-resident; rebuild on a networked Mac)
Build cards: docs/lab/l5-build-cards.md. Names/contracts: docs/lab/s-campaign-results.md. They are:
`things-proxy-find-items`, `-create-heading`, `-edit-title`, `-set-detail`, `-delete-items`, `-delete-items-permanently`. All use Find Items (ID filter) → act; one item per run.

### iCloud share-link durability (answers to Mike's questions)
How Apple's `https://www.icloud.com/shortcuts/<id>` sharing works:
- **Durability**: the link points to a SNAPSHOT stored on Apple's iCloud servers, tied to the sharer's Apple ID. It stays live as long as the sharer keeps it shared and the Apple ID is active — effectively indefinite, but Apple-hosted (not under our control).
- **Editing after sharing**: sharing is **immutable per link**. Editing your local copy does NOT update the shared snapshot; re-sharing mints a NEW link. So a README link pins one version — update = new link + README bump.
- **Removing from your system**: deleting your local shortcut does NOT immediately kill the link (the snapshot lives on iCloud), but if you **stop sharing** (Shortcut → Share sheet → Copy iCloud Link is per-share; there's a "Stop Sharing" in the shortcut's details) the link dies for everyone. So: don't revoke the shared links once published.
- **Signing**: shared shortcuts are signed by the sharer's Apple ID; on import the recipient sees "Untrusted Shortcut" unless they've allowed untrusted shortcuts, OR the shortcut came through the signed iCloud share (which is trusted). Sharing via iCloud is the trusted path.

### Recommended distribution plan
1. On a networked Mac signed into Mike's Apple ID, build the six proxies from the build cards (or export from the golden — but the golden is airgapped/Apple-ID-less, so it can only make unsigned copies; rebuild is cleaner).
2. For each, Share → Copy iCloud Link. Collect six `https://www.icloud.com/shortcuts/...` links.
3. Put them in the README under a "Shortcuts setup (optional)" section + a one-time consent note (grant "Always Allow" on first run of each output-class proxy).
4. Build `things setup shortcuts`: prints the six links + install/consent instructions, and verifies presence via `shortcuts list`.
5. Emit the same link + instructions from otherwise-blocked actions (heading create, dated-reminder clear) as the remediation string.

### Bulk edits (Mike's question)
All proxies are single-item by design (Find Items → one → act), which is CORRECT for us: per-item verification is the whole point of the pipeline. A bulk case ("tag 500 items matching 'drive'") is served by `things batch` iterating single mutations, each guarded+verified — we do NOT want a bulk Shortcuts action (loses verification, and triggers the scary "allow large edits" consent). Conclusion: the "allow Shortcuts to edit large amounts of data" setting is MOOT for our design; doctor need not flag it. (uriSchemeEnabled still gets surfaced — §B.)

---

## §B. Availability / environment layer (greenlit)

- Advisory `availability(env)` per write vector: does this surface work in the current environment? (URL scheme needs `uriSchemeEnabled`; Shortcuts needs the proxies present + consented.)
- `things doctor` reads `uriSchemeEnabled` (int-bool in the group-container plist, via `plutil -p` — see docs/lab/phase21b-research.md) and reports Enable-Things-URLs state.
- Correct the `feature-disabled` failure classifier to key on `uriSchemeEnabled` rather than a null token (the token persists even when disabled — Phase 21b).
- Do NOT flag the "allow large edits" Shortcuts setting (moot, §A bulk note).

## §C. e2e reorder coverage (small)
The guest e2e smoke (lab/scripts/e2e-write-smoke.sh) has NO reorder steps. Add smoke steps for the shipped scopes: inbox, someday (to-dos + area-less projects), headings, projects (bounce). One VM run; wire into `lab:regress`.

## §D. AppleScript project-schedule vector (small — "what did you mean")
P14-A3 found `schedule to do id <PROJECT>` SUCCEEDS via AppleScript (projects inherit the `to do` class), setting the project's startDate with no error/crash. Today `project.update` schedules a project only via the URL vector (`update-project?when=`). This means AppleScript is an ALTERNATIVE, un-wired vector for project scheduling. Action: add an `applescript` matrix entry + compile branch for project schedule (evidence P14-A3), OR just document it and leave URL as the sole vector (it already works). Low priority; decide during §F.

## §E. Headings doctrine — DECIDED 2026-07-09: no flatten mode

**Decision: headings are ALWAYS first-class. There is NO flatten/dual-mode.** Rationale (supersedes gaps.md §0's flatten-by-default plan):
- The original case for flattening was "headings barely work without Shortcuts + their index makes flat reads incoherent." Both premises are now FALSE: AppleScript unblocked rename/archive/delete/reorder + placement (P10/P11), leaving only heading CREATE-in-existing-project Shortcuts-gated; and we HID `index`/`todayIndex` (v0.6.0), so the incoherence argument is gone entirely.
- **Reads**: always heading-aware — free (SQLite; project-view already groups by heading). No second flat shape to build or maintain.
- **Writes**: naturally capability-gated. Placement/rename/archive/delete/reorder work now. Only `heading.create` (in an existing project) reports `unsupported` with a "run `things setup shortcuts`" remediation when Shortcuts isn't configured — exactly the `allow-experimental` pattern.
- **No silent clobbering**: the O06 "reorder rips headed children out" stays a guard, never a silent flatten. Silence is what created that hazard class.
- **Maintenance burden avoided**: a flatten/dual-mode would mean two read shapes, index-reconciliation, mode config, and a whole class of "which mode am I in" bugs — for the sake of one create op. Not worth it.

Only remaining heading work: wire `heading.create` behind the Shortcuts vector (§A). Update gaps.md §0 to record this decision when §A lands.

## §F. Comprehensive reference compendium (Mike's "reference book")
Goal: by project end, EVERYTHING probed is documented in one navigable place. Consolidate the per-campaign lab docs (a/o/p/r/e/u/x/s-suite results, phase21b, scf/scf2, P7–P14, heading-research) into a `docs/reference/` compendium: the full op×vector×verdict matrix with evidence ids, the crash/erratic catalog (oddities §7), and the "novel working paths" list. Leave no stone: any op we hand-waved as "probably dead" without a probe gets one. Track open probe candidates here as they arise.

## Shelved indefinitely (Mike, item 4)
First-class support for "ignored"/archived tags, emoji-stripping opt-in, pseudo-archived areas. Revisit only if real usage surfaces a need. (The leading-symbol-significant rule already protects emoji-prefixed archival tags for free — v0.6.0.)
