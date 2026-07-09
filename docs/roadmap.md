# things-api roadmap & parked work

Durable plan (survives context compaction). Written 2026-07-09. Everything shipped through v0.6.0 lives in CHANGELOG / the living docs; this file tracks what is DECIDED-BUT-UNBUILT, PARKED, or awaiting Mike. Update as items land.

## ⟹ RESUME HERE (post-compaction order)

1. ~~Publish v0.6.0 to npm~~ — **DONE 2026-07-09**: tagged `v0.6.0`, published to `latest`, bin path intact, `npx things-api@0.6.0 --version` smoke green. (Publish gotcha for next time: `prepublishOnly` outlives a TOTP window — pre-run check+build, then `npm publish --ignore-scripts --otp=<code>`.)
2. ~~§A Shortcuts onboarding~~ — **LANDED 2026-07-09** (signed-file distribution + `things setup shortcuts` + doctor availability); still open: real-hardware import validation (Mike) + wiring the Shortcuts write vector (§A list below).
3. ~~§B availability layer~~ — **LANDED 2026-07-09** (see §B).
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

### Distribution plan — SUPERSEDED 2026-07-09: signed `.shortcut` files in the repo (no iCloud links, no manual rebuild)

The SX probe series (research-sx*.sh) proved a fully-programmatic pipeline: the six proxies' action blobs were EXTRACTED from the golden's `~/Library/Shortcuts/Shortcuts.sqlite` (`ZSHORTCUTACTIONS.ZDATA`, verbatim `WFWorkflowActions` bplists), wrapped as old-format `.shortcut` plists (host python), and signed on Mike's Mac with `shortcuts sign --mode anyone` → **six signed, importable files in `lab/shortcuts/`** (~23 KB each). SX4 confirmed a clone presents the real "Add Shortcut" import sheet for the signed file (signature ACCEPTED; screenshot `lab/artifacts/things-run-sx4-20260709-165726/sx4-import-sheet.png`). Advantages over iCloud links: versioned in git, no Apple-hosted mutable/immutable-snapshot semantics, no manual rebuild sitting, updates are re-extract + re-sign + commit.

Landed 2026-07-09 (§A/§B PR): signed files ship in the npm package (top-level `shortcuts/`, in `files`); **`things setup shortcuts`** opens each missing proxy's install sheet + prints consent instructions (`--check` passive); **`things doctor`** reports `url scheme:` (on-disk `uriSchemeEnabled`) and `shortcuts:` (proxy presence); the `feature-disabled` classifier keys on the on-disk state (Phase 21b correction). Sign-time gotchas (banked): the signer sandbox can't write to `/Volumes/*` — sign to `/tmp` and move; harmless `debugDescription` ObjC noise on stderr even on success.

Still open for §A:
1. **Import validation on real hardware** — Mike double-clicks one signed file, confirms Add Shortcut → it runs. (VM click automation is blocked: TCC.db is SIP-read-only even with FDA, so no AX consent; a VNC-synthetic-click arm is the lab fix — §E½.)
2. **Wire the Shortcuts write vector** into the pipeline (`heading.create`, dated-reminder clear): `VectorId "shortcuts"`, matrix entries from S-campaign evidence, `shortcuts run` executor, remediation strings pointing at `things setup shortcuts`.

### Bulk edits (Mike's question)
All proxies are single-item by design (Find Items → one → act), which is CORRECT for us: per-item verification is the whole point of the pipeline. A bulk case ("tag 500 items matching 'drive'") is served by `things batch` iterating single mutations, each guarded+verified — we do NOT want a bulk Shortcuts action (loses verification, and triggers the scary "allow large edits" consent). Conclusion: the "allow Shortcuts to edit large amounts of data" setting is MOOT for our design; doctor need not flag it. (uriSchemeEnabled still gets surfaced — §B.)

---

## §B. Availability / environment layer — LANDED 2026-07-09

Shipped in the §A/§B PR: `src/write/availability.ts` (`readUrlSchemeEnabled` — plist bytes read by the node process, parsed via `plutil` on stdin, so no new TCC file-access shape; `readShortcutProxies` vs the six expected names); doctor `availability` report section + CLI lines; `feature-disabled` classifier keys on the on-disk state (silent-noop OR timeout on url-scheme with `uriSchemeEnabled=0`), never the token. The "allow large edits" setting is deliberately NOT flagged (moot, §A bulk note).

## §C. e2e reorder coverage (small)
The guest e2e smoke (lab/scripts/e2e-write-smoke.sh) has NO reorder steps. Add smoke steps for the shipped scopes: inbox, someday (to-dos + area-less projects), headings, projects (bounce). One VM run; wire into `lab:regress`.

## §D. AppleScript project-schedule vector — DECIDED 2026-07-09: document-only
P14-A3 found `schedule to do id <PROJECT>` SUCCEEDS via AppleScript (projects inherit the `to do` class). Decision: **do not wire it** — URL `update-project?when=` is validated, shipped, and sufficient; a second vector for the same op adds compile/matrix surface with zero new capability. The capability-matrix's project-update row carries the P14-A3 note as the durable record; §F's novel-paths list will include it.

## §E½. UI-scripting ("ui") write vector — NEW candidate (Mike, 2026-07-09)

For Mike's dedicated-Mac ("mini in a closet") hosted scenario: System Events AX automation can drive everything stamped "conclusively UI-only" — repeating to-do/project creation and rule edits (dead on ALL four programmatic surfaces), sidebar/area ordering (P6), to-do↔project convert, and a heading-create fallback. Requirements: Accessibility TCC grant (one-time), auto-login unlocked GUI session, Things frontmost during ops → tier 3+, opt-in, dedicated-machine-only vector. Fragile across app updates — but the VM lab is the regression harness that certifies AX paths per Things version.

Lab findings so far (SX4): stock VMs can't self-grant Accessibility (TCC.db is SIP-protected read-only even with FDA — "attempt to write a readonly database"), so in-VM AX is blocked. **The lab arm is VNC synthetic input**: `tart run --vnc-experimental` exposes a standard RFB server; synthetic mouse/keyboard events arrive as hardware-level input, bypassing TCC entirely. That same arm would automate consent-prompt clicks (even the per-run delete-class prompts) in probes. Feasibility probe queued: drive `File → New Repeating To-Do` end-to-end via VNC clicks in a clone, verify an `rt1_recurrenceRule` row lands. Alternative: a SIP-disabled derived VM image (boot recovery via `tart run --recovery`, `csrutil disable`) makes TCC.db writable → real AX scripting in-VM.

## §E. Headings doctrine — DECIDED 2026-07-09: no flatten mode

**Decision: headings are ALWAYS first-class. There is NO flatten/dual-mode.** Rationale (supersedes gaps.md §0's flatten-by-default plan):
- The original case for flattening was "headings barely work without Shortcuts + their index makes flat reads incoherent." Both premises are now FALSE: AppleScript unblocked rename/archive/delete/reorder + placement (P10/P11), leaving only heading CREATE-in-existing-project Shortcuts-gated; and we HID `index`/`todayIndex` (v0.6.0), so the incoherence argument is gone entirely.
- **Reads**: always heading-aware — free (SQLite; project-view already groups by heading). No second flat shape to build or maintain.
- **Writes**: naturally capability-gated. Placement/rename/archive/delete/reorder work now. Only `heading.create` (in an existing project) reports `unsupported` with a "run `things setup shortcuts`" remediation when Shortcuts isn't configured — exactly the `allow-experimental` pattern.
- **No silent clobbering**: the O06 "reorder rips headed children out" stays a guard, never a silent flatten. Silence is what created that hazard class.
- **Maintenance burden avoided**: a flatten/dual-mode would mean two read shapes, index-reconciliation, mode config, and a whole class of "which mode am I in" bugs — for the sake of one create op. Not worth it.

Only remaining heading work: wire `heading.create` behind the Shortcuts vector (§A). Update gaps.md §0 to record this decision when §A lands.

**HX sweep addendum (2026-07-09)**: every non-Shortcuts create/relocate escape hatch is now probed-dead — TJSON top-level heading and project-update items append are silently ignored; AS `move`/`duplicate` on a resolved heading are refused (301/−1717); TJSON update `list-id` no-ops. TJSON DOES create headings inside a NEW project (HX0) — wiring that into `project.add` is a live small win. Full table: [lab/heading-research.md](lab/heading-research.md).

## §F. Comprehensive reference compendium (Mike's "reference book")
Goal: by project end, EVERYTHING probed is documented in one navigable place. Consolidate the per-campaign lab docs (a/o/p/r/e/u/x/s-suite results, phase21b, scf/scf2, P7–P14, heading-research) into a `docs/reference/` compendium: the full op×vector×verdict matrix with evidence ids, the crash/erratic catalog (oddities §7), and the "novel working paths" list. Leave no stone: any op we hand-waved as "probably dead" without a probe gets one. Track open probe candidates here as they arise.

## Shelved indefinitely (Mike, item 4)
First-class support for "ignored"/archived tags, emoji-stripping opt-in, pseudo-archived areas. Revisit only if real usage surfaces a need. (The leading-symbol-significant rule already protects emoji-prefixed archival tags for free — v0.6.0.)
