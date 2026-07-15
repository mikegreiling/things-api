# things-api roadmap & parked work

Durable plan (survives context compaction). Written 2026-07-09. Everything shipped through v0.6.0 lives in CHANGELOG / the living docs; this file tracks what is DECIDED-BUT-UNBUILT, PARKED, or awaiting Mike. Update as items land.

## ⟹ RESUME HERE (post-compaction order)

**2026-07-12: the live pick list moved to [docs/up-next.md](up-next.md)** — decisions Mike owes, VM campaigns (batchable), human-required sittings, calendar-pinned work (macOS 27 beta ~late July, iOS 27 GA ~Sept 14), small unblocked items. Everything below in this section is DONE history. v0.8.0 shipped 2026-07-12 (PRs #73–#85: Shortcuts write vector live-validated, reversible/guarded undo + checklist intents + reversibility matrix, trash-cascade fix + oddity 6½, projects sidebar mirror, upcoming window, hidden-item hints, --when validation, capabilities undo column).


1. ~~Publish v0.6.0 to npm~~ — **DONE 2026-07-09**: tagged `v0.6.0`, published to `latest`, bin path intact, `npx things-api@0.6.0 --version` smoke green. (Publish gotcha for next time: `prepublishOnly` outlives a TOTP window — pre-run check+build, then `npm publish --ignore-scripts --otp=<code>`.)
2. ~~§A Shortcuts onboarding~~ — **LANDED 2026-07-09** (signed-file distribution + `things setup shortcuts` + doctor availability); real-hardware import validation **DONE 2026-07-10**; ~~wiring the Shortcuts write vector~~ **DONE 2026-07-11** (§A.2).
3. ~~§B availability layer~~ — **LANDED 2026-07-09** (see §B).
4. ~~§C e2e reorder coverage~~ + ~~§D project-schedule vector~~ — **DONE 2026-07-09** (e2e GREEN 106 steps; §D document-only).
5. ~~§F comprehensive reference compendium~~ — **LANDED 2026-07-09** (docs/reference/).

Post-queue (2026-07-09, Mike): TUI restyle **SHIPPED**; hardening (§G) **SHIPPED**; Apple-Intelligence memo **DONE**. Open threads: Mike re-imports the repaired `find-items` (§A.1, one click + one Always-Allow), ~~Shortcuts write-vector wiring (§A.2)~~ **DONE 2026-07-11 (needs Mike's live smoke-test)**, UI-vector/VNC feasibility probe (§E½ — first VNC click demonstrated 2026-07-10, SX6), macOS 27 public-beta regression VM (~late July), iOS 27 GA runbook execution (~Sept).

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
1. ~~Import validation on real hardware~~ — **DONE 2026-07-10**: signed-file import+run validated on Mike's Mac; iCloud-free distribution works. BUT the retest exposed that `things-proxy-find-items` was mis-built (echoes input, doesn't search — S01 confound corrected; product-impact NONE, it's diagnostic-only). ~~VM repair campaign~~ — **DONE 2026-07-10 (SX5/SX6)**: filter repaired (`Property="title"`, Operator 4 "is" — case-insensitive, case-fold-proven in a clone) and the repaired signed asset re-shipped in `shortcuts/` + import-validated in a fresh clone; the malformed-predicate crash is a REAL reproducible app bug (oddities §7 C4, four `.ips`). **Programmatic proxy authoring is UNLOCKED** (novel-paths #18): compose `WFWorkflowActions` in Python, wrap + `shortcuts sign` — no golden GUI sitting; the App Intents vocabulary comes from the ThingsCommon framework's `Metadata.appintents` (predicate identifiers MUST come from there — unknown ones crash the app). Remaining from this thread: Mike re-imports the repaired `find-items` on real hardware (one Add-Shortcut click + one Always-Allow on first run; the old copy should be removed first). Full evidence: s-campaign-results.md "VM repair campaign results (SX5 + SX6)".
2. ~~**Wire the Shortcuts write vector** into the pipeline (`heading.create`, dated-reminder clear)~~ — **DONE 2026-07-11** (branch `mg/shortcuts-write-vector`, per [design/shortcuts-write-vector-plan.md](design/shortcuts-write-vector-plan.md)). `VectorId "shortcuts"` + `CompiledInvocation` kind `"shortcuts-run"` ({shortcut, input}); `src/write/vectors/shortcuts.ts` runs `shortcuts run <name> --input-path <tmp> --output-path <tmp>` (25s timeout, per-run temp files, always cleaned up) through an injectable runner seam. Two ops shipped: `heading.create` (`things heading add`, `create_heading` MCP; proxy `things-proxy-create-heading`, input `{title, project:<uuid>}`) and `todo.clear-dated-reminder` (`things todo clear-reminder`, `clear_reminder` MCP; proxy `things-proxy-set-detail`, input `{id, detail:"Reminder Time", value:""}`). A missing proxy pre-checks (via `readShortcutProxies`) as `blocked:environment` with a `things setup shortcuts` remediation; a first-run timeout classifies as consent-needed ("run once, Always Allow"). `heading.create` records undo:unsupported (AppleScript heading delete is dead, −1728). Single-item permanent delete stays OUT (delete-class consent, no Always-Allow). **Executor is seam-tested only — live end-to-end proof deferred** (Mike smoke-test post-review, or a VM sitting once the lab runner gains a Shortcuts arm, probe-backlog §C). Proxies can also be authored programmatically now (see §A.1) if the golden-resident set ever changes.

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

For Mike's dedicated-Mac ("mini in a closet") hosted scenario: System Events AX automation can drive everything stamped "conclusively UI-only" — repeating to-do/project creation and rule edits (dead on ALL four programmatic surfaces), sidebar/area ordering (P6), to-do↔project convert, and a heading-create fallback. Requirements: Accessibility TCC grant (one-time), auto-login unlocked GUI session; **AX element press does NOT require Things frontmost and steals no focus (AXVM1) → far below the VNC path's tier 3+**, opt-in, dedicated-machine-only vector. Fragile across app updates — but the VM lab is the regression harness that certifies AX paths per Things version.

Lab findings (SX4 → **corrected by AXVM1, 2026-07-14**): ~~stock VMs can't self-grant Accessibility (TCC.db is SIP-protected read-only even with FDA — "attempt to write a readonly database"), so in-VM AX is blocked.~~ SX4's "readonly database" is real but it was a **direct-write** result — the SYSTEM `TCC.db` is SIP-protected. The **user-path grant** (System Settings toggle → `tccd`) is NOT blocked: **AXVM1 granted Accessibility to `sshd-keygen-wrapper` in a stock guest with SIP enabled and drove a real transform (Items ▸ Repeat ▸ Pause) by element name over SSH** (grant persists across reboot). So **in-VM AX is NOT blocked** — see [lab/axvm1-accessibility.md](lab/axvm1-accessibility.md). **The lab arm is now TWO paths:** (1) VNC synthetic input — `tart run --vnc-experimental` exposes a standard RFB server; synthetic mouse/keyboard events arrive as hardware-level input, bypassing TCC entirely (**first demo 2026-07-10, SX6**: vncdotool clicked a Shortcuts import sheet's "Add Shortcut" button; capture-then-click, deterministic layout, `lab/scripts/research-sx6.sh` is the template); and (2) **System Events AX after the one-time user-path grant** — lower-disruption (no frontmost, no focus steal) and lock-tolerant, addressed by element name + `things:///show?id=` handles. The recoveryOS SIP-disable image (`tart run --recovery`, `csrutil disable`, direct `TCC.db` INSERT) is now an unneeded fallback, not the only path.

**Build status (2026-07-15):** `area.reorder-sidebar` SHIPPED + lab-certified (AXDRAG2, PR pending merge) — sidebar area order (P6/O13) is closed. **Decided from that build (Mike, 2026-07-15):** (1) **rung 2 (scroll-while-held) SHELVED** — the production ladder stays rung 1 + rung 3 permanently for now; held-scroll code stays behind the `THINGS_UI_DRAG_LADDER=held-scroll` lab knob. The oddities §9 AX-mirror blanking bug means sustained drag+scroll blinds the closed-loop verification the doctrine requires; revisit only if Cultured Code fixes the mirror bug, a non-relaunch heal is found, or a certified travel cap with real margin lands (reasoning + revisit conditions also in design/ax-initiative.md build item 3 and docs/lab/axdrag2-reorder-certification.md). (2) **`tag.reorder` ABANDONED BY DECISION** (not blocked): risky/potentially destructive (silent re-parent hazard, unverifiable row identity — nameless positional rows + ubiquitous `TMTag."index"` ties, AXDRAG1-e / AXDRAG2-d) for little actual utility. The TAGORD1 probes (docs/lab/taglab-probes.md) settled the ordering semantics for KNOWLEDGE only and do not reopen it; unblockers (a name handle or a validated Tags-window tie-break oracle) remain the bar if ever reopened.

### Appliance-mode VM — PINNED as a future deployment option (Mike, 2026-07-15; NOT NOW)

An alternative to running the MCP server directly on the host mac-mini: a **long-lived Things VM on a dedicated host**, cloud-synced to Mike's Things account, running the MCP server with **port-forwarding** out of the guest. This is deliberately parked, not scheduled — the current deployment target stays the **host mac-mini with a one-time AX grant + always-allow setup**.

**Benefits already evidenced:**
- **AX grant is provable in a VM** (AXVM1 — the user-path Accessibility grant works in a stock SIP-on guest and persists across reboot).
- **Frozen locale + text-size** kills the entire works-on-my-system fragility class (the English-pin doctrine and AX-frame geometry both become environment-controlled, not host-dependent).
- **The foreground-bound HID-tap tier becomes invisible** — the guest owns its own console session, so mouse-synthesis ops (`kCGHIDEventTap`) that are foreground+unlocked-only on a shared host run freely because nothing else competes for that console.
- **Tart snapshot/rollback** gives cheap disaster recovery and a clean per-version regression baseline.

**Open questions gating it (must be answered before adopting):**
- **MASVM1 probe (unrun):** can an Apple-ID / Mac App Store sign-in inside a Sequoia guest license a **non-trial** Things (the lab golden is a trial/standalone build)? This is the load-bearing unknown.
- **Real clock required** — cloud sync needs a true clock; the lab's clock-pinning trick is incompatible with a sync-live appliance.
- **Things update management** inside a long-lived guest (how/when to take the app update, recertify AX paths per the things-update-runbook).
- **Footprint:** ~40–60 GB disk + 4–8 GB RAM for a persistent guest.

Decision: **NOT NOW.** Reassess if the host-mini path hits a wall or once MASVM1 resolves the licensing question.

## §E. Headings doctrine — DECIDED 2026-07-09: no flatten mode

**Decision: headings are ALWAYS first-class. There is NO flatten/dual-mode.** Rationale (supersedes gaps.md §0's flatten-by-default plan):
- The original case for flattening was "headings barely work without Shortcuts + their index makes flat reads incoherent." Both premises are now FALSE: AppleScript unblocked rename/archive/delete/reorder + placement (P10/P11), leaving only heading CREATE-in-existing-project Shortcuts-gated; and we HID `index`/`todayIndex` (v0.6.0), so the incoherence argument is gone entirely.
- **Reads**: always heading-aware — free (SQLite; project-view already groups by heading). No second flat shape to build or maintain.
- **Writes**: naturally capability-gated. Placement/rename/archive/delete/reorder work now. Only `heading.create` (in an existing project) reports `unsupported` with a "run `things setup shortcuts`" remediation when Shortcuts isn't configured — exactly the `allow-experimental` pattern.
- **No silent clobbering**: the O06 "reorder rips headed children out" stays a guard, never a silent flatten. Silence is what created that hazard class.
- **Maintenance burden avoided**: a flatten/dual-mode would mean two read shapes, index-reconciliation, mode config, and a whole class of "which mode am I in" bugs — for the sake of one create op. Not worth it.

~~Only remaining heading work: wire `heading.create` behind the Shortcuts vector (§A).~~ **DONE 2026-07-11** (§A.2): `heading.create` ships behind the Shortcuts vector (`things heading add`), capability-gated on the installed proxies.

**HX sweep addendum (2026-07-09)**: every non-Shortcuts create/relocate escape hatch is now probed-dead — TJSON top-level heading and project-update items append are silently ignored; AS `move`/`duplicate` on a resolved heading are refused (301/−1717); TJSON update `list-id` no-ops. TJSON DOES create headings inside a NEW project (HX0) — wiring that into `project.add` is a live small win. Full table: [lab/heading-research.md](lab/heading-research.md).

## §G. Hardening for the anticipated Things-update (Mike, 2026-07-09) — LANDED except the audit

CC correspondence suggests repeat-handling changes and a likely major release alongside macOS 27. Shipped 2026-07-09: **[lab/things-update-runbook.md](lab/things-update-runbook.md)** (the full recertification sequence + version-pinning guidance + standing-defenses table), strict repeat-rule version decoding (`rrv` gate), and the doctor `repeats:` undecodable-template canary. Remaining: the **op×vector suite-completeness audit** (every shipped op must appear in a recurring suite) — folded into §F below.

**Apple-Intelligence research — DONE 2026-07-09**: [design/apple-intelligence-research.md](design/apple-intelligence-research.md). Headlines: App Intents is the only hook (SiriKit deprecated at WWDC26); generic LLM agents CANNOT invoke App Intents directly (two orthogonal caller classes; MCP shipped only inside Xcode 27); **`shortcuts run` remains the sanctioned generic-agent bridge — our proxy/MCP architecture is already the right shape**. Queued probes: macOS 27 public-beta regression VM (July), App Intents Testing Framework as a headless invoke channel (needs Xcode 27), full runbook execution at iOS 27 GA (~Sept 14) when Things likely ships its App Intents 2.0 release (task management is a system-defined schema domain).

## §F. Comprehensive reference compendium — LANDED 2026-07-09
`docs/reference/` now exists: **[README](reference/README.md)** (the probe-id/campaign index over all evidence; the living rollups — capability-matrix + oddities — stay primary), **[novel-paths.md](reference/novel-paths.md)** (21 lab-discovered undocumented capabilities), **[suite-audit.md](reference/suite-audit.md)** (op catalog × recurring coverage — the §G leftover; the 7 uncovered op kinds got e2e steps in the same change). Remaining §F-adjacent: probe the "probably dead" unprobed cells as they surface (tracked in probe-backlog: hidden lists as reorder specifiers, area'd someday projects, entity-typed set-detail Parent, P5 non-empty heading delete).

## §H. TUI polish backlog

**Stateful display preferences (parked by Mike, 2026-07-10; scope grown 2026-07-12).** The composite views grew show/hide toggles (`--show-later`, `--show-logged`; defaults hidden, mirroring the GUI's toggle-off state), and PRs #89/#93 added the limit-knob family (`--limit`, `--area-limit`, `--project-limit`, `--all`). Revisit when there's bandwidth: user-configurable defaults for these flags (a config file, env vars, or even reading Things' own plists for the user's in-app show-later preference — with the caveat that plist-driven defaults could confuse agents whose output changes without any flag changing). Decide config surface + precedence then. Additional knobs triaged into this same pass (discussed 2026-07-12, TTY-only, never affecting `--json`/MCP):
- `limitMode: fixed | fit | none` — `fit` sizes default limits to the terminal via `process.stdout.rows` with sane clamps. Deliberately NOT the default (determinism beats cleverness: same command must produce same output across window sizes, screenshots, tmux panes); `fixed` (today's behavior) stays default.
- `pager: auto | never` — git-style auto-paging through `less -FRX` when stdout is a TTY; `-F` keeps small outputs inline. The strongest "fit the window" answer since nothing is ever truncated.
- Global `--plain` / `--pretty` override pair (the `--color=never/always` tradition): ONE switch for all TTY chrome (view headers, colors, hints) in both directions. Force-ON matters for `things today | less -R`. Decided 2026-07-12 NOT to ship a one-off `--no-header` (piping already suppresses headers; see PR #94); project/area show preambles are content, not chrome — they never suppress.

**Width-handling polish pass — SHIPPED 2026-07-13** (PR mg/width-aware-tty; option 1 chosen). GUI-parity single-line truncation for list rows: titles overflow with `…` and tags fold from the end into a dim `#…`, TTY-only via `process.stdout.columns` (or `THINGS_WIDTH`), with a single DERIVED floor (`MIN_FIT_WIDTH` = worst-case row furniture + a 16-col title) replacing the mooted ~60-col clamp. Hanging-indent (option 2) rejected as specced (goes stale on resize). Doctrine + the GUI-measured collapse oracle: [design/width-aware-tty.md](design/width-aware-tty.md). Only the right-pinned deadline gutter remains deferred (phase 2). Full titles remain one `things show <id>` away.

**Parked idea (2026-07-12): a `things ui` interactive subcommand** — full-screen scrolling/interactive browsing built on the same read library, if browsing ever earns it. The non-interactive, composable, pipe-friendly contract of the list commands is a core product property (half the consumer base is agents) and interactivity must never creep into them; a separate subcommand is the only acceptable shape.

Font-test observations already banked (Mike's terminal, 2026-07-10): `◑` renders visibly oversized next to `◔`/`◕` (dropped — pie is now under-half/over-half only); `U+1F5CE 🗎` is tofu (missing glyph); `⎘`/`❏`/`▤` render but are hard to discern at cell size; `⍾` doesn't read as a bell (replaced by `◷`).

**Cross-terminal glyph audit (flagged by Mike, 2026-07-10).** The CLI's glyph language (`src/cli/glyphs.ts` — checkbox marks ✓ × ~, pie quarters ◔ ◑ ◕ ◉, chips ‹›, ★/⏾/≡) was chosen on one macOS font stack; audit how it renders across terminal emulators and fonts before treating it as settled. Matrix: Terminal.app, iTerm2, Ghostty, kitty, VS Code terminal, Warp × SF Mono, Menlo, JetBrains Mono, a Nerd Font — plus a CJK-wide (`ambiguous=double`) config and a `NO_COLOR`/piped pass. Watch for: tofu on `⏾` (U+23FE, Unicode 9) and the pie quarters, double-width drift of ambiguous-width glyphs breaking column alignment, and dim-on-light-theme legibility. Every glyph is a constant in `glyphs.ts`, so retuning is a one-file change.

## §I. Surface the reversibility matrix — LANDED 2026-07-12 (PR #85)

`things capabilities` now renders a per-op `undo:` line (`reversible` / `reversible-with-loss` / `conditional` / `irreversible` + the honest-caveat note), and the same data rides the `--json` envelope and MCP capabilities tool as an additive `undo` field, sourced from `REVERSIBILITY` and locked by a capabilities↔matrix cross-check test.

## §J. CLI grammar — consolidated (branch `mg/cli-grammar`); Phase 2 parked

The read-side routing sugar (bare noun, `show`/`open` keyword rewrites, loose reference routers) is now ONE resolver + ONE precedence chain, specified in [design/cli-grammar.md](design/cli-grammar.md). Shipped in the same change: `things show projects|areas|tags` (show accepts every list-view name; open still only the seven URL ids, plurals rejected with a fix), a TTY normalized-form echo (`≡ things area show …`), and `meta.resolvedCommand` on routed-read `--json`.

**Phase 2 — parked (specified, not built):** resource-scoped closed-enum verbs, gh-style — `things project <ref> add-heading <title>`, `things project <ref> add-todo <title>`. Fixed slots (position 2 = ref, position 3 = verb from a closed enum), flags for everything else. This is the honest ergonomic home for heading creation (headings are subordinate resources); `things heading create` stays for type-consistency. The closed enum is the discipline that keeps it from drifting into the free-form write grammar that is a deliberate non-goal. Spec: [design/cli-grammar.md](design/cli-grammar.md) § Phase 2.

## Shelved indefinitely (Mike, item 4)
First-class support for "ignored"/archived tags, emoji-stripping opt-in, pseudo-archived areas. Revisit only if real usage surfaces a need. (The leading-symbol-significant rule already protects emoji-prefixed archival tags for free — v0.6.0.)
