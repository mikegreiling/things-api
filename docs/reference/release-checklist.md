# Release checklist — the drill for cutting a version

The single doc a release agent reads. Everything below is the drill **as practiced** (v0.20.7 / PR [#693](https://github.com/mikegreiling/things-api/pull/693) is the current precedent for the mechanical shape; v0.20.0 / #650 for the minor-bump precedent), plus the field-shaped gate ruled on 2026-09-03. Read this instead of reverse-engineering a prior release PR.

**The gate, in one sentence.** No version is tagged until `npm run lab:regress` exits GREEN **and** every operation whose driver / vector / recipe / deputy-facing code changed in the batch has been run end-to-end at least once **through the deputy, using the normal CLI syntax** — with GUI-driven ops driven at least once on a **real display**. Authority: [AGENTS.md](../../AGENTS.md) § Conventions → *Release gate*; ruling recorded in [design/decisions.md](../design/decisions.md) (2026-09-03).

## What counts as "changed"

Mechanically — any diff in the batch under:

- `src/write/vectors/**` — every vector and every drive-shaped module in it (`ui-recipes.ts`, `ui-shape.ts`, `ui-prefill.ts`, `ui-observer.ts`, `ui-chord.ts`, `ui-drag.ts`, `ui-state.ts`, `ui-certification.ts`, `url-scheme.ts`, `applescript.ts`, `shortcuts.ts`, `registry.ts`)
- the operation catalog and the drivers around it (`src/write/operations.ts` and any `src/write/*.ts` compiling or verifying a leg)
- `src/deputy/**` (routing, protocol, the db facade), `deputy/**` (the Swift broker itself), `scripts/build-helpers.sh`
- `src/rescue.ts`
- **anything whose CHANGELOG entry says it alters a GUI drive** — this clause outranks the path list. A change outside every path above whose user-visible description is "the command now clicks / reads / waits differently" is IN.

The mechanical form, run against the previous tag:

```sh
git diff v<prev>..origin/main --stat -- \
  src/write/vectors/ src/write/operations.ts src/deputy/ deputy/ src/rescue.ts scripts/build-helpers.sh
```

Non-empty ⇒ every operation those files drive is on the Stage 5 list. When in doubt, include it: the cost of one extra routed CLI invocation is seconds, and the cost of the omission is a field-red release.

## Why (b) and (c) exist — what `lab:regress` cannot see

`lab:regress` is the behavioral net, and it is a real one (eight suites + the guest e2e). It has two blind spots that both shipped a broken release inside five weeks:

1. **The lab certifies DIRECT script execution; every real host routes through the deputy.** Lab guests export `THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1` and run the primitives in-process — no helper bundle, no broker. On a helpers-enabled host the same primitives are brokered by `things-deputy`, which **refuses** whole classes of script by design: `scriptGuard` in `deputy/src/server.swift` rejects any script containing `do shell script` / `do script`, because the deputy brokers GUI/AppleEvent scripts and never shell execution. v0.20.7's observer sidecar (#687) reached its socket through exactly that construct: green on every lab probe, refused on every real host. (Hotfix: branch `mg/observer-deputy-routing`, in flight as the 0.20.8 hotfix at the time this was written.)
2. **Headless clones cannot reproduce real-hardware rendering and latency.** v0.19.2's window/focus census opened with an unaddressed system-wide process-table enumeration plus a system-wide focused-element resolution. On the maintainer's host that stalled ~15 s per inspection and failed the drive with nothing typed ([#629](https://github.com/mikegreiling/things-api/issues/629)); timed individually against a standing sheet in a clone it returned in ~60–250 ms and **the stall did not reproduce headless at all** ([lab/fgrd2-census-hardening.md](../lab/fgrd2-census-hardening.md)).

Add the structural gap named in [suite-audit.md](suite-audit.md) § *ui-vector ops*: the GUI-driven op kinds are **not** in the recurring suites (the golden carries no Accessibility grant for headless driving), so their recurring safety net is per-Things-version certification, not `lab:regress`. A fully GREEN regress says nothing about whether a repeat drive, a convert, a heading chord or a sidebar drag still works. That is precisely what (b) and (c) cover.

Lab probes stay direct-execution **by design** — that is what they are for, and nothing here asks them to change. Certification of a *release* is the field-shaped run.

## The stages

### Stage 1 — inventory the batch and choose the version

- List every PR merged since the previous tag (`git log v<prev>..origin/main --oneline`); the release commit message names them all with one paragraph each.
- Run the changed-paths diff above and write down the **Stage 5 operation list** now, before any of the mechanical work.
- Pick the version per § *Version precedent* below and state the reasoning in the PR body.

### Stage 2 — `npm run check`, by exit code

```sh
npm ci && npm run check; echo "exit=$?"
```

Exit 0 or stop. Never grep piped output for this. Run `npm run fmt` before committing anything.

### Stage 3 — `npm run lab:regress`, GREEN, on a GUI host

```sh
npm run lab:regress; echo "exit=$?"
```

All eight suites plus the guest write-layer e2e, exit 0 (which also asserts zero alert beeps and clean teardown of every clone). A RED result **blocks the release** until reconciled per [lab/drift-runbook.md](../lab/drift-runbook.md) step 3 — the failure is as often suite drift as a real regression, and either way it is reconciled before the tag, never after. Record the run ids and the per-suite probe counts; they go in the PR body.

Budget ~22 min wall. Requires the host GUI session, `tart` + `sshpass`, and the active golden under `TART_HOME`.

### Stage 4 — packaging smoke

```sh
npm run smoke:pack
```

Packs the tarball, installs it into a scratch project, and proves the installed `things` bin works against a throwaway fixture DB — the `files` / `exports` / `bin` wiring no unit test can see. It also asserts a present `deputy/prebuilt` bundle survives packing with its executable bits intact.

Anything the batch newly *embeds* (a template literal shipped verbatim by `tsc`, a data file, a script body) is verified **from `dist`, out of an installed tarball** here — not from the source tree. v0.20.7's precedent: load the module from the installed copy, count its exports and the byte length of the embedded payload.

### Stage 5 — THE FIELD-SHAPED RC RUN (the gate)

> **WHO RUNS IT (ruling 2026-09-03): the MAINTAINER, on his own machine — or an agent ONLY under his explicit, time-boxed sanction for THIS run (`scripts/sanction-prod.sh <minutes> "<reason>"`, run from HIS terminal).** This stage writes to and GUI-drives the production Things app; no orchestrator or delegate may do that unattended, and a sanction for one release does not carry to the next. The orchestrator's job here is to prepare the RC, the exact command list, and the cleanup list, hand them to the maintainer, and record his transcript in the PR body. `.claude/hooks/prod-things-guard.sh` refuses the commands otherwise; do not work around a refusal. (2026-09-03: a delegate ran this stage unattended while the maintainer was using the machine — the reason this paragraph exists.)

The routed, real-CLI, real-display proof. Five steps; a failure at any of them means **no tag**.

**(i) Build the RC from merged `main` and record its digest.**

```sh
git fetch origin && git -C <checkout> log origin/main --oneline -1   # the exact commit under test
npm pack --pack-destination /tmp/rc
shasum -a 256 /tmp/rc/things-api-<version>.tgz
```

The RC is built from the merge commit that will carry the tag, not from a feature branch and not from a dirty tree.

**The RC tarball carries the PREVIOUS version string** — the bump is Stage 7, so `main` at Stage 5 is still `v<prev>` and `npm pack` writes `things-api-<prev>.tgz`. That is correct and stays that way (the RC must come from the merge commit, which cannot already hold the new number). Identify the RC by its **sha256** and a content fingerprint of the fix under test (e.g. `grep -c unsettled dist/write/vectors/ui.js`), never by its filename, and say so in the Stage 5(v) record; `things --version` inside the temp prefix will print `<prev>`, which is expected and not a failed install.

**(ii) Install it into a temp prefix on a helpers-enabled host.**

Today that host is the maintainer's Mac (a lab guest with the helpers installed is the automatable replacement, queued in [up-next.md](../up-next.md) as *"Helpers IN THE GUEST"*; the real-display half of the gate stays human regardless).

```sh
PFX=$(mktemp -d)
npm install -g --prefix "$PFX" /tmp/rc/things-api-<version>.tgz
"$PFX/bin/things" --version                     # prints the PREVIOUS version — see the note above; identify the RC by sha256 + fingerprint
"$PFX/bin/things" helpers status                # must show the deputy answering + onboarded
"$PFX/bin/things" doctor                        # routing line must say the helpers carry traffic
```

Routing must be **asserted, not assumed**: the helper bundle installed and onboarded (`things helpers setup` is the ceremony; `things helpers status` reports it), `helpers-enabled` at `auto` (installed-and-healthy ⇒ routed) or `true`, and no missing requisite named in `status`. A run that silently degraded to direct execution proves nothing this gate is asking about — that is the whole failure mode being closed. Do not pass `--no-helpers` / `THINGS_API_HELPERS=false` anywhere in this stage.

Note the global `things` on the maintainer's host is npm-linked to the repo checkout and runs live TS source; the gate deliberately uses the packed tarball in its own prefix instead, so what is certified is what will publish.

**(iii) Run every changed operation end-to-end, through the deputy, with the normal CLI syntax.**

For each operation on the Stage 1 list:

```sh
THINGS_API_TRACE=1 "$PFX/bin/things" <the ordinary command a caller would type> --op-id rc-<version>-<n>
"$PFX/bin/things" op-result rc-<version>-<n>
```

- **Normal CLI syntax only.** No `osascript`, no hand-built `things:///` URL, no lab escape, no direct invocation of a driver module. The point of the stage is that the field-shaped path is exercised; reaching around the CLI reproduces the very gap that shipped 0.20.7.
- **Synthetic content only.** Titles/notes/projects minted for this run, never anything from the maintainer's real data, and nothing that reads or writes the production database beyond the ordinary command's own target. This repo is public and a trace file may contain real titles and uuids: traces are LOCAL-ONLY and are never committed, pasted into a PR, or attached to an issue.
- **Read the outcome, don't infer it.** The command's own result (or `things op-result <op-id>` when the environment kills a long GUI drive) plus the trace's per-hop account are the evidence. A drive that "seemed to work" is not a pass; the recorded status is. (`--op-id` is refused on a variadic move/reorder — a multi-leg compound — so those ops are read from their own result.)
- **GUI-driven (ui-vector) ops are driven on a REAL DISPLAY** — the maintainer's host or the framebuffer/HID rig — with the app visible, unlocked, and not in a full-screen Space. Latency, rendering and focus behavior are the properties a headless clone cannot supply, and they are where both regressions lived.
- A deputy-facing change (`src/deputy/**`, `deputy/**`, `scripts/build-helpers.sh`) puts **one op of each vector class** on the list, not just the ops that changed: the broker sits under all of them.

**(iv) Clean up the synthetic rows — official CLI only.**

`things undo`, or the ordinary inverse / removal command the CLI already provides. Never direct SQLite, never a raw URL, never a hand-driven GUI fix-up. Leave the host as it was found; confirm the cleanup landed the same way the run itself was read.

**(v) Record the run in the release PR body.**

Versions (package RC, Things app build, macOS, helpers version), the host class (helpers-enabled real display / rig), the exact commands, and each outcome. This paragraph is the audit trail for the gate — a release PR without it has not passed the gate.

### Stage 6 — helpers version check

```sh
git diff v<prev>..origin/main --stat -- deputy/ scripts/build-helpers.sh
```

**Non-empty ⇒ STOP.** The helper bundle carries its OWN version line (`EXPECTED_HELPERS_VERSION` in `src/deputy/protocol.ts`), decoupled from the package version so an unchanged bundle is not churned. A touched `deputy/` or `build-helpers.sh` means that constant, the bundle build, and the reinstall path all need deciding before the tag — and every consumer who has the old bundle installed needs the skew notice to be accurate. Empty diff ⇒ state the unchanged helpers version in the PR body ("Helpers unchanged at 1.3.0 — empty `deputy/` + `scripts/build-helpers.sh` diff since v<prev>").

### Stage 7 — the release PR (the five-file bump)

Branch `mg/release-<version>` off latest `origin/main`, then exactly five files:

```sh
npm version <version> --no-git-tag-version   # package.json + package-lock.json
```

- `package.json` + `package-lock.json` — by `npm version --no-git-tag-version`, never by hand (the lock's two version fields must both move).
- `src/contracts.ts` — `PKG_VERSION = "<version>"`.
- `README.md` — the status line's `v<version>`.
- `CHANGELOG.md` — roll the accumulated `## Unreleased` content under `## <version> — <YYYY-MM-DD>` and leave a **fresh empty `## Unreleased`** above it. Content is not rewritten during the roll; it was written per-PR.

The commit/PR body is the release's own record: `chore(release): <version>`, one paragraph per landed PR, the version reasoning, the Stage 3 gate result (run ids + probe counts + `npm run check` exit 0), the Stage 5 field-shaped run, the Stage 6 helpers line, and any packaging verification. Reference issues as `Refs #N` — **never** `Fixes`/`Closes`/`Resolves`, which would auto-close an issue the reporter has not yet confirmed.

Push, open with `gh pr create`, let CI run.

### Stage 8 — merge, tag, watch the workflow

Squash-merge on green CI (standing policy — not a manual review threshold):

```sh
gh pr merge <N> --squash            # no --delete-branch, ever: the branch is part of the audit trail
```

**gh-merge-from-worktree quirks.** Run from an isolated worktree, `gh pr merge` can report an error *after the merge has already landed* — it tries to update the local branch / switch the checkout, which a linked worktree whose `main` is checked out elsewhere cannot do. Never re-run the merge on the strength of the error. Verify first:

```sh
gh pr view <N> --json state,mergedAt,mergeCommit
git fetch origin && git log origin/main --oneline -1
```

Then tag the **merge commit** with a lightweight tag and push it — `release.yml` triggers on `v*` tags and on nothing else:

```sh
git tag v<version> <merge-sha>
git push origin v<version>
```

The workflow verifies the tag matches `package.json`, re-runs `npm run check` + `build`, stamps the bundled skill's version, signs + notarizes + staples "Things API Helper.app", asserts the prebuilt helpers actually reach the tarball, publishes to npm via trusted publishing (OIDC provenance, no token), then cuts the GitHub Release from the tag's CHANGELOG section. Poll it in place:

```sh
gh run watch <run-id>     # or: gh run list --workflow=release.yml --limit 3
```

A missing signing secret fails the release **deliberately and loudly** in `build-helpers`; see [design/release-signing.md](../design/release-signing.md) § Troubleshooting.

### Stage 9 — notarization + published-package verification (the consumer drill)

After the workflow is green, verify the artifact a consumer actually gets:

```sh
npm view things-api version dist-tags
PFX2=$(mktemp -d)
npm install -g --prefix "$PFX2" things-api@<version>
"$PFX2/bin/things" --version
```

Then the notarization proof, on the bundle inside the published package (not the CI copy):

```sh
B="$PFX2/lib/node_modules/things-api/deputy/prebuilt/Things API Helper.app"
codesign --verify --deep --strict --verbose=2 "$B"
xcrun stapler validate "$B"
spctl --assess --type exec -vv "$B"     # Gatekeeper accepts it offline, from the stapled ticket alone
```

`spctl` accepting it with no network is the whole point of notarizing: a consumer installing the tarball gets a bundle launchd can start without a quarantine prompt. Finish with the same smoke the tarball drill used — the installed `things` answering against a throwaway fixture DB — then remove the temp prefixes.

### Stage 10 — close out

- Delete the landed items from [up-next.md](../up-next.md); update [roadmap.md](../roadmap.md), [capability-matrix.md](../capability-matrix.md) and [suite-audit.md](suite-audit.md) if the batch moved anything they track (usually done per-PR; check, don't assume).
- Leave GitHub issues OPEN unless the reporter has confirmed the fix. A merge is not confirmation; for a field bug the confirmation is the maintainer's own re-run on the machine that hit it.
- Leave the primary checkout on a clean, up-to-date `main` (the maintainer's live CLI is npm-linked to it).

## Version precedent

Under [ALPHA-CONTRACT](../../AGENTS.md) the whole surface is breakable until v1.0, so the version number carries exactly one signal:

- **MINOR** — the batch removes surface in a breaking way. Precedent: **0.20.0** (`things ui-state` deleted outright, no alias, no deprecation window) and **0.19.0** before it. New capabilities ride along in a minor when a removal is already forcing one; they do not force one by themselves.
- **PATCH** — everything else, including new commands, new flags, new MCP arguments, behavior fixes, and a refusal that replaces a silent wrong write. Precedent: **0.20.4** (the `area reorder` default flip), **0.20.5** (`THINGS_API_AX_COUNT`, an off-switch for new machinery), **0.20.7** (the §32 after-completion clamp — a refusal replacing a silent substitution on an existing flag combination, plus two new off-switches).
- **MAJOR** — reserved for v1.0, which is also when the ALPHA-CONTRACT doctrine is removed (`grep -rn ALPHA-CONTRACT`) and compatibility discipline begins. The v1.0 checklist lives in [roadmap.md](../roadmap.md).

State the reasoning in the release PR body either way — "PATCH per the repo's release precedent: no removals; X and Y are in the same class as <cited prior release>" — so the next release agent inherits the precedent rather than re-deriving it.
