# The agent daemon (`things-agentd`) — async ops, stable automation identity, and the watch host

**STATUS: β1 (the permission deputy) IMPLEMENTED 2026-08-19 at the maintainer's direction — see §3a. The remaining phases (α watch engine, β async-op contract, γ watch hosted, δ polish) stay PROPOSED and await explicit ratification before any build.** This document is the durable home for the design so it survives context compaction. Companion queue items live in [../up-next.md](../up-next.md); the v1.0 sequencing pin lives in [../roadmap.md](../roadmap.md).

## 1. Why — three problems, one architecture

Three independently-discovered problems converge on a single resident-process design:

1. **Caller timeout caps.** Agent harnesses hard-cap shell commands (observed: ~30s in the maintainer's other agent's environment) while legitimate GUI-drive invocations run 7–130s (drive + verify). `things op-result <op-id>` (shipped 2026-08-19, #503) solves *recovery* — a killed caller can fetch the verdict later — but not *delivery*: the op itself still dies with the process on a SIGKILL mid-drive, and a multi-leg composite can be severed between legs.
2. **TCC grant churn.** macOS attaches Automation/Accessibility grants to the *responsible process's code signature* (Phase-21a doctrine, [setup.md](../setup.md) hardening ladder). When the CLI runs under an agent harness, the harness is the responsible process — and harnesses update near-daily (Codex re-prompts "would like to access…" after every update). Grants can never be durable while the automation source is a moving target.
3. **`things watch` needs residency.** The change-watch feature (v1.0 gate) wants a long-running process with DB read access, a WAL-wake trigger loop, and disciplined lifecycle — exactly the process the first two problems already demand.

One signed, launchd-supervised helper — the **agent daemon** — solves all three: it executes ops asynchronously on behalf of thin CLI callers (SIGKILL of the caller is irrelevant), it is the stable responsible process for all AppleEvents/AX (grants attach to *its* signature, once), and it hosts the watch loop.

## 2. Architecture

```
 agent harness (Claude/Codex/...)          launchd (user domain)
        │                                        │ owns lifecycle
        ▼                                        ▼
  things CLI  ── spool + UNIX socket ──►  things-agentd  ──►  osascript / AX / URL
  (thin client; validates, enqueues,      (signed, stable       (TCC grants attach
   prints accepted/synchronous result)     bundle identity)       HERE, once)
```

- **The engine does not move.** The entire existing write pipeline (guards → lock → dispatch → verify → audit) and read layer remain library code, runnable **in-process exactly as today**. The daemon is a *host* for that engine, not a rewrite. `config agent-enabled false` (the kill switch) restores pure in-process behavior permanently. This is the single most important QA property: everything already certified stays certified on the in-process path; the daemon adds a transport/lifecycle layer that is tested separately and thinly.
- **IPC**: a spool directory (`~/.local/state/things-api/spool/`) for op handoff + a same-uid UNIX socket for status/streaming. The CLI enqueues a request file (the full validated op + options + opId), pokes the daemon (`launchctl kickstart` / socket), and either waits (sync mode) or returns immediately (async mode).
- **launchd LaunchAgent** (`com.pixelcog.things-agentd`, user domain): on-demand start, idle exit after N minutes (no perpetual daemon unless a watch is active), crash → relaunch. No detached/orphan processes anywhere — launchd owns the lifecycle, which honors the repo's harness-reaping doctrine in spirit: every process has a supervisor and a knowable state.
- **Async contract** (the caller-facing change):
  - `--timeout <s>` flag ∥ `THINGS_OP_TIMEOUT` env ∥ harness-detected defaults (Claude Code / Codex mark their shells with identifiable env vars; detection sets the *default* only, never overrides an explicit value).
  - Budget is consulted **up front**: if the op's expected cost (per-op-class estimates from the trace baselines) exceeds the budget, the CLI validates fully, writes the audit **intent** record, enqueues, and returns a structured `accepted` result (`{kind:"accepted", opId, hint:"things op-result <opId>"}`, exit 0) within a second. Deterministic: the caller knows at t=0 whether the result is final or a claim ticket. No "timed out but secretly continuing".
  - Sync path (budget sufficient, or agent disabled/unavailable): identical to today.
  - `op-result` (already shipped) is the retrieval half; it gains a `--wait [s]` option to block on the socket for completion within the caller's budget.
- **Op execution in the daemon**: same pipeline, same mutation lock (the pidfile lock already serializes across processes), same audit/trace ledgers (worker-side entries tagged with the daemon pid so a timeline interleaves cleanly). In-flight ops carry a lease (opId + pid in the spool entry); a daemon crash → launchd restart → dead-lease detection marks the op `verify-failed` with an honest "daemon restarted mid-op — re-read state" diagnosis, never silence. Composites run entirely inside one daemon op = SIGKILL-immune end-to-end (and the queued composite-scoped lock lands naturally here).

## 3. Signing and the TCC migration

- **Do we need a paid Apple Developer account?** Only for *distribution*. The two tiers:
  - **Personal (sufficient for the maintainer's machines, $0):** a persistent **self-signed code-signing certificate** minted once (`things agent setup` creates it in the login keychain) and used to sign the daemon on every rebuild. TCC identity follows the certificate — grants survive rebuilds and npm-link churn. **Ad-hoc signing is NOT acceptable** (identity changes per build → the churn problem returns; this is the plan's sharpest edge, stated twice deliberately).
  - **Distribution (later, if ever):** shipping a runnable signed daemon to other users' machines wants Developer ID + notarization = paid Apple Developer Program (~$99/yr). Not needed for phase β; the npm package ships **source + a build-and-sign script**, and every user's `things agent setup` mints their own local cert (bring-your-own-identity). Revisit Developer ID only if a prebuilt-binary distribution channel becomes worth it.
- **Secrets hygiene (public repo):** no certificate, key, or Apple credential ever enters the repository — the personal cert lives only in the login keychain; if CI signing is ever wanted, the standard GitHub Actions encrypted-secrets pattern applies (base64 p12 secret, imported into a throwaway keychain per run). The repo carries only the *scripts* and documentation.
- **Grant ceremony (one-time per machine):** Accessibility + Automation (→ Things3, → System Events) + the group-container read for the daemon identity. `things agent doctor` reports each grant's state prompt-free (the `things onboard` item in up-next is the natural shared machinery — the daemon becomes its primary beneficiary). setup.md's hardening ladder gains the daemon as the recommended rung above per-host grants.
- **launchd environment hygiene:** LaunchAgents inherit no user shell environment — the daemon must resolve node/binary/DB paths absolutely (plist-embedded), and the "signed single-binary `things`" idea from the July hardening notes is the natural hardening step here (a compiled binary removes the node-path fragility entirely; keep it as an option, not a prerequisite).

## 3a. β1 — the permission deputy (`things-deputy`), implemented 2026-08-19

The maintainer re-scoped the first build slice mid-plan: **before** the op-hosting daemon, ship a *deliberately dumb privileged broker* — "just a proxy for issuing AppleScript commands and reading the Things SQLite database," logic stays in the CLI, opt-in via config with env/flag overrides. That slice is now implemented (deputy/, src/deputy/, `things deputy`); [deputy/README.md](../../deputy/README.md) is the operational doc.

**What β1 delivers vs. what remains β:**

| | β1 deputy (shipped) | still β (proposed) |
|---|---|---|
| TCC churn (reads + AppleEvents + AX + container files) | **solved** — grants attach to the signed deputy | — |
| Mid-step orphan bounding | deputy owns each osascript child and kills it at its deadline even if the caller died | — |
| Async `accepted` contract, spool/lease, `op-result --wait` | not included | yes |
| Composite ops SIGKILL-immune end-to-end | no — the CLI still orchestrates steps; a killed caller abandons the op *between* steps (op-result reports intent-only, as today) | yes |
| Watch residency | no | γ |

**Key implementation facts (details in deputy/README.md and src/deputy/):** wire protocol v1 (JSON lines, UNIX socket, per-request token, same-UID peer check); verbs `hello`/`sql`/`osascript`/`read-file`/`locate` only; read-only SQLite with ATTACH denied; fixed osascript argv shapes + a `do shell script` refusal lint; routing decided once per process at activation (enabled-but-unreachable → DIRECT with one stderr notice, never a mid-op transport switch); a DatabaseSync-shaped facade keeps the entire read layer untouched (the sync bridge is a worker thread + Atomics.wait); the async client carries vector/ui dispatch so watchdogs and signal handlers keep running. Skew: protocol mismatch deactivates; package-version mismatch on matching protocol kickstarts once then proceeds with a notice (dumb verbs are skew-safe by construction — this is precisely why the broker shape was chosen).

**EDR reality (discovered during certification):** the maintainer's managed workstation runs Cylance, which auto-quarantines every freshly built `things-deputy` (`execution_control`, score −1000 — logged 2026-08-19 22:09, hash `1a367e6e…c1025c`). Local execution of the live broker is therefore blocked until IT excludes the build path or (better) allow-lists the persistent signing certificate. Consequences: the live-broker suite is opt-in (`THINGS_DEPUTY_LIVE=1`) and runs on CI's clean `deputy-macos` hosted runner; the real-TCC validation (grants surviving a rebuild under the ceremony cert) must happen on an unmanaged Mac (the maintainer's M1) or post-exclusion.

## 3b. The reader split (`things-reader`) — durable, OS-scoped file reads (2026-08-21)

The live grant ceremony falsified a β1 assumption: **`kTCCServiceSystemPolicyAppData` grants are allow-once-per-process** (pid + boot_uuid-pinned; three prompts across three deputy instances on the maintainer's host; the reason his terminal never prompts is that Ghostty holds Full Disk Access). A headless helper cannot ride that class, and the only unsandboxed durable alternative is FDA — which the maintainer rejected as over-broad ("I cannot scope some permanent grant to a narrowly scoped directory?"). He can — via the one mechanism macOS offers: **App Sandbox + powerbox selection + app-scoped security bookmark**, VM-certified end-to-end by **SANDBOX1** ([../lab/sandbox1-scoped-reader.md](../lab/sandbox1-scoped-reader.md)): durable across processes, reboots, and re-signed rebuilds; scoped to exactly the granted directory; OS-enforced (the sandbox denies everything else outright, promptlessly).

So the deputy is now a PAIR:

| | **things-reader** (sandboxed .app) | **things-deputy** (unsandboxed) |
|---|---|---|
| verbs | `hello` / `sql` / `read-file` / `locate` | all (files as interim fallback) + `osascript` / `shortcuts` |
| privilege | security-scoped bookmark to the Things group container, minted once by `things deputy grant` (NSOpenPanel presented BY the sandboxed process — that is what makes it durable) | TCC Automation/Accessibility grants (durable classes) |
| state | its sandbox container (`~/Library/Containers/com.pixelcog.things-reader/Data`): bookmark, token, socket, log | `~/.local/state/things-api/deputy/` |
| packaging | minimal LSUIElement .app (secinit refuses bare executables) signed with a REAL chain (amfid refuses ad-hoc on sandboxed code) | bare Mach-O, same identity |

Routing (src/deputy/routing.ts): file verbs ride the reader when present AND granted, else the deputy (whose file access consent-stalls per process — acceptable only as interim), else direct. Automation verbs ride the deputy only. A present-but-ungranted reader is skipped with `status` pointing at the ceremony. The reader's handshake carries `granted` explicitly, and an ungranted reader refuses file verbs with `not-granted` naming the ceremony — never a prompt, never a stall (its class has no prompts). The FDA path remains documented as a fallback for hosts that reject the ceremony, no longer as the recommendation.

## 4. New failure surface — and the debug/QA strategy (the maintainer's headline concern)

New states the daemon introduces, each with its mitigation:

| Failure state | Mitigation |
|---|---|
| daemon not installed / not running | CLI detects → **sync fallback** (runs in-process, today's behavior) + a one-line notice; `agent doctor` says why |
| CLI↔daemon **version skew** (real daily risk: the primary checkout is npm-linked live source) | handshake carries both versions; on mismatch the CLI restarts the daemon (or falls back sync) — never executes across skew |
| spool entry stuck / claimed-but-dead | lease (opId+pid) + dead-pid steal, reusing the proven `lock.ts` atomic-rename pattern; stuck ops surface in `agent doctor` and `op-result` as honest diagnoses |
| daemon SIGKILLed mid-drive | launchd restarts; the in-flight lease marks the op failed-with-diagnosis; the per-step osascript checkpoint architecture (TRACE1) bounds the orphan window to one step, unchanged |
| grants missing **on the daemon** (fresh machine, revoked, cert rotated) | prompt-free detection in `agent doctor` + the SESSGATE-style preflight refusal naming the ceremony command |
| socket dead / spool unwritable | CLI sync fallback + notice |

**Testing strategy (the key insight — the daemon must not fork the test matrix):**
- All engine tests (2,800+) keep running **in-process** — the daemon never touches engine semantics.
- The daemon layer gets its own thin suites: spool/lease/handshake/skew **unit tests** (seams, no launchd), plus **one** VM cert suite for the transport (install daemon in a golden clone, run a representative op set through the async path, verify identical audit/DB outcomes vs the sync path — a diff-the-two-paths harness, cheap and decisive).
- The lab e2e stays primarily on the in-process path (as today); the agent-transport cert rides release preflights.
- **Debuggability:** the dev-mode trace gains daemon-side entries in the same per-invocation files (opId-correlated); `things agent status` (running/version/uptime/spool depth/last op) and `things agent doctor` (grants, socket, skew) are day-one commands; every abnormal daemon event also lands in the audit ledger so `op-result` tells the whole story.

## 5. `things watch` — design of record (transcribed + reshaped for the daemon)

Established analysis (2026-08-15 session, pre-compaction) — the evidence-backed design:

- **Snapshot-diff is the only correct mechanism, and it is cheap.** All shortcuts are closed by evidence: `userModificationDate` misses whole change families (the umd-SILENT class: reorders, checklist writes, tag rename/delete, template writes — [reference/timestamps.md](../reference/timestamps.md) §2), `TMTombstone` covers only template lineage (decisions.md 2026-07-26 DON'T-BUILD), the Syncrony change-log is an ephemeral undocumented push buffer, WAL parsing is fantasy. Scale is a non-problem: the production DB is ~12MB / ~22k task rows; a full normalized snapshot is a few MB, a keyed diff is milliseconds.
- **Read safety:** read-only SQLite connections cannot corrupt; WAL gives snapshot isolation. The one real gotcha: a long-held read transaction pins the WAL — so **every diff pass is a short open-read-close transaction**, never held between wakes.
- **Four layers**, each independently testable:
  1. **Snapshot primitive** — a scoped read (one project / one view / whole library) producing a uuid-keyed normalized entity map of reportable fields: status, title, notes-hash, when/deadline/reminder, parent FKs, index/todayIndex, tags, checklist state. Rides the existing read layer (Today membership law, repeat decoding) — never a parallel implementation.
  2. **Pure diff** — `diff(before, after) → events[]`: `added | removed | completed | canceled | modified{fields} | reordered` (one drag rewrites many sibling indexes → collapse to a single `reordered` per parent). Exhaustively golden-testable; all timestamps/ordering evidence encodes here as "reportable vs derived-noise" field policy.
  3. **Baseline persistence → `things changes --since-baseline`** (final name TBD) — persist a snapshot, diff against it later, roll it forward. Restart-proof, zero long-running-process concerns, poll-friendly; most of the user value ships here.
  4. **The watch loop** — wake on `main.sqlite-wal` mtime (FSEvents) + debounce + `PRAGMA data_version` check + slow-poll fallback; scoped (`--project <ref>`, `--today`); NDJSON events; `--once`/`--until <condition>` for agent wait-steps. **Semantics are level-based, not edge-based** (disclosed): events are transitions between consecutive consistent snapshots — intermediate states coalesce; an item created and trashed between wakes never appears.
- **Reshaped by this plan:** layers 1–3 are daemon-independent and build **first** (phase α); layer 4 **hosts in the daemon** (phase γ), which retires every long-running-process concern (lifecycle, restart continuity, the no-detached rail) and opens an MCP watch surface later. Behavior when Things isn't running: the DB is frozen — the watcher reports nothing, correctly (doctor's sync-health signals disclose staleness).
- **Open maintainer calls (carried over, still unanswered):** (a) does `modified` report all reportable fields with a per-event field list (recommended) or opt-in granularity flags; (b) is `changes` a first-class sibling command (recommended) or a watch-internal detail; (c) whether whole-project-completion is a first-class terminal event; (d) how undo-driven reversals read in the stream (plain field-changes-back is the honest default).

## 6. Phase plan (each phase independently shippable, gated, and ratified before build)

| Phase | Contents | Acceptance gate |
|---|---|---|
| **α — watch engine (in-process)** | snapshot primitive + pure diff + baseline persistence + `things changes`; skill/MCP read exposure | golden diff-suite (fixture goldens for every event class + coalescing cases); live-clone cell: scripted mutations → expected event stream; zero write-path changes |
| **β1 — permission deputy** (SHIPPED 2026-08-19, §3a) | dumb privileged broker (sql/osascript/read-file/locate) + launchd install + signing scripts + routing with direct fallback + `things deputy status/install/restart/uninstall` | mock-broker suites (all platforms) + live-binary suite on CI macOS; REMAINING GATE: real-TCC churn test (grants survive a rebuild under the ceremony cert) on an EDR-free Mac |
| **β — daemon core** | spool/lease + async contract (`--timeout`/env/`accepted`) + `op-result --wait` + composite ops hosted whole (rides the β1 deputy's identity and transport) | transport-diff harness (async path ≡ sync path outcomes on a representative op set, in-VM); skew/lease/fallback unit suites |
| **γ — watch hosted** | layer-4 loop in the daemon; `things watch` CLI (NDJSON, scope flags, `--once/--until`); baseline continuity across daemon restarts | event-stream cert in a clone (mutations while watching); restart-continuity cell; idle-exit + relaunch behavior |
| **δ — polish** | harness-detected timeout defaults; MCP async/watch exposure; resident AX-driver option inside the daemon (subsumes the deferred per-step spawn overhead idea); `things onboard` integration | per-item; no gate binds the earlier phases |

Sequencing rationale: α first because it is pure, independently valuable, and starts the v1.0 field-mileage clock on watch's engine immediately; β second because it kills the two live operational pains (harness caps, TCC churn); γ is where they converge. The roadmap's "watch ships first" gate is satisfied across α+γ.

## 7. Contingencies and open risks

- **Ad-hoc-signing trap** (stated again): every rebuild must re-sign with the *persistent* cert or TCC churn silently returns. `agent doctor` should verify the running daemon's signature matches the ceremony cert.
- **npm-distribution shape**: an .app/LaunchAgent cannot ride a plain npm tarball as a signed artifact; the package ships source + build script, `agent setup` builds/signs locally. Acceptable for the single-consumer alpha; revisit at v1.0.
- **launchd quirks**: no shell env (absolute paths in the plist), user-domain-only, console-session availability for AX (the daemon needs an Aqua session context to drive AX — a locked screen still gates dialog-class ops exactly as SESSGATE does today; the daemon does not change that law).
- **Version skew** is the daily-life risk on the dev machine — the handshake is not optional polish, it is core (build it in β, first).
- **Spool idempotency**: opId is already threaded through every write; the spool keys on it, so a re-enqueue of the same opId is detected exactly like today's idempotent resubmission.
- **Security posture**: same-uid socket + spool perms 0700; the daemon executes only ops the library vocabulary can express (no arbitrary shell); local single-user machine.
- **What this plan does NOT change**: prod-write rails, the guard/verify machinery, the lab doctrine, the ALPHA-CONTRACT freedom (the async result kinds and agent commands are alpha vocabulary like everything else).
