# things-api roadmap — long-horizon open strategy

Durable, survives context compaction. This file holds only what is DECIDED-BUT-UNBUILT at a long horizon or STRATEGICALLY PARKED. The short-horizon queue is [docs/up-next.md](up-next.md); settled rulings live in [docs/design/decisions.md](design/decisions.md). Everything already shipped lives in CHANGELOG + the living docs — landed sections are DELETED here, never struck.

**One-home rule:** an open item lives in exactly one of {up-next, roadmap}. Roadmap does not restate up-next items — including the disruptiveness-deployment-profiles item and the Apple-Intelligence / macOS-27 calendar items, which home in up-next.

## v1.0 checklist — the release that flips the contract from alpha to stable

The whole contract is ALPHA until v1.0 (break freely, no compat machinery — [design/decisions.md](design/decisions.md), AGENTS.md Conventions). Shipping v1.0 is the moment that discipline reverses. The gate:

- **ALPHA-CONTRACT teardown.** `grep -rn ALPHA-CONTRACT` finds every signpost (AGENTS.md Conventions, [design/architecture.md](design/architecture.md) § Alpha contract, and any others); DELETE them all as part of the release — the doctrine exists so the "break freely" point never has to be re-argued, and it must not outlive the alpha.
- **Compatibility covenant ACTIVATION.** [docs/contract.md](contract.md) already documents the covenant that begins at v1.0 (envelope grammar, the promises, the error-code registry, the one-word-one-meaning glossary). At v1.0 it stops being a future promise and starts binding: from here, breaking changes need the covenant's discipline.
- **Error-code freeze.** The `ErrorCode` union in `src/contracts.ts` (the compiler-enforced registry) is frozen at v1.0 — additions stay possible, removals/renames become breaking.
- **Entity-vs-shaper programmatic-contract ruling.** Settle what the *programmatic* TS contract promises about entity shapes vs the emission-time shaping layer (the read-shape doctrine draws the wire boundary; the library-return boundary needs its own explicit v1.0 promise) before the covenant binds.
- **CC report send** (the oddities package) — held until v1.0; the submission itself is an up-next needs-human item, but v1.0 is its release gate.
- **`things watch` ships first** (maintainer gate, 2026-08-11): the change-watch command is a v1.0 prerequisite — built, field-used, and stable before the contract freezes. **Design of record + phasing: [design/agent-daemon.md](design/agent-daemon.md)** (ratified direction 2026-08-19): phase α builds the watch ENGINE in-process (`things changes` first), phase γ hosts the watch loop in the agent daemon — the gate is satisfied across α+γ.

## Agent daemon (`things-agentd`) — PROPOSED, plan awaiting ratification

One resident signed launchd helper solving three converged problems: agent-harness timeout caps (async op contract + `accepted` results), TCC grant churn (the daemon becomes the stable responsible process — grants attach to its persistent signing identity, surviving harness updates), and `things watch` residency. Full design, signing/secrets posture (paid Developer ID needed only for distribution; a persistent self-signed cert suffices personally), failure-surface + QA strategy (the engine stays in-process-testable; the daemon is a transport host with a sync fallback and kill switch), and the α→δ phase plan: **[design/agent-daemon.md](design/agent-daemon.md)**. Next step: maintainer ratifies the phase plan (post-compaction), then phase α.
- **Field mileage** (maintainer, 2026-08-11): v1.0 is deliberately unhurried — the pre-1.0 period keeps producing design corrections (the deadlines view, the Today-order field bugs), and the contract freezes only after the surface has been driven hard for a while longer.

## Cloud-account probes — durable account LIVE; only on-hardware residuals remain

The long-blocked SYNC2 campaign is UNBLOCKED and largely landed. A **durable throwaway Things Cloud account** was minted once and is kept alive for all future sync probes (creds + `BSSyncronyMetadata` coordinates in gitignored `lab/artifacts/sync-durable-account/`; **NO churn** — decisions.md 2026-08-13). Landed under golden-v2/3.22.12, evidence [docs/lab/sync2b-durable-account.md](lab/sync2b-durable-account.md):
- **SY-1** baseline convergence (both directions) + `BSSyncronyMetadata` taxonomy — a THIRD account confirms the last-sync key is account-specific, validating the shipped nearest-to-now reader.
- **SY-2 the `--preserve-modified` sync-safety GATE — the flag is SYNC-SAFE:** a hand-written past `umd` propagates to the peer AND survives the round-trip both directions (Things Cloud treats `umd` as ordinary per-attribute synced data; content rides the change-log independent of `umd`); the "UNSYNCED-only" caveat is retired across the `--help`/MCP/skill/`timestamps.md` copy.
- **SY-3 / SY-3b** cross-device repeating-instance reconvergence: two disconnected devices mint the **identical deterministic instance uuid** for the same occurrence, so reconvergence is a per-attribute **add/add 3-way merge on one shared row** (no duplicate/ghost) — `creationDate`/`umd` → **MAX**, `notes` → union. **Winner tiebreak RESOLVED** (SY-3b, [docs/lab/sync3-dedupe-tiebreak.md](lab/sync3-dedupe-tiebreak.md)): value-based, independent of reconnect order AND device (forced-opposite-order + zone-swap runs). Also the **SERDEL S5 zone residual RESOLVED** — a spawned occurrence stamps `creationDate` at occurrence-day midnight in the **spawning device's local zone**, so the surviving `MAX(creationDate)` is the later/western local midnight.

Remaining residuals (the account no longer gates them — they need real HARDWARE or are micro-follow-ups):
- **On-hardware push/pull cadence measurement** — the VM has no APNs push-wake, so real receiver latency cannot be reproduced in-VM; an on-hardware sitting, not an account gate. (The SYNCLAT sender-side stale-panel repro that used to ride this line is **PARKED INDEFINITELY, wait-and-see** — see [design/decisions.md](design/decisions.md) 2026-08-14; it has not recurred, revisit only if the maintainer observes it again.) Evidence: [docs/lab/synclat-results.md](lab/synclat-results.md).

## On-hardware certification — the final confirmation axis for the ui vector

Every ui-vector op is `lab-certified` in-VM against the pinned Things version; the remaining axis is the on-hardware `certified` confirmation. The runbook exists: [docs/lab/ui-certification-runbook.md](lab/ui-certification-runbook.md) §5. This is a standing sitting, not a blocked one — run it when the deployment target hardware is set up.

## Appliance-mode VM — a future deployment option (PINNED, not scheduled)

An alternative to running the MCP server directly on the host Mac-mini: a **long-lived Things VM on a dedicated host**, cloud-synced to Mike's account, running the MCP server with **port-forwarding** out of the guest. Deliberately parked — the current deployment target stays the **host Mac-mini with a one-time AX grant + always-allow setup**.

Benefits already evidenced: the AX grant is provable in a VM and persists across reboot (AXVM1); a frozen locale + text-size kills the works-on-my-system fragility class (English-pin doctrine + AX-frame geometry become environment-controlled); the foreground-bound HID-tap tier becomes invisible (the guest owns its own console session); Tart snapshot/rollback gives cheap disaster recovery + a clean per-version regression baseline.

Open questions gating adoption:
- **MASVM1 probe (UNRUN):** can an Apple-ID / Mac App Store sign-in inside a Sequoia guest license a **non-trial** Things (the lab golden is a trial/standalone build)? The load-bearing unknown.
- **Real clock required** — cloud sync needs a true clock; the lab's clock-pinning trick is incompatible with a sync-live appliance.
- **Things update management** inside a long-lived guest (how/when to take the app update, recertify AX paths per the things-update-runbook).
- **Footprint:** ~40–60 GB disk + 4–8 GB RAM for a persistent guest.

Decision: **NOT NOW.** Reassess if the host-mini path hits a wall or once MASVM1 resolves the licensing question.
