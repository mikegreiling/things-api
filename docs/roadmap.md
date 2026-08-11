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
- **`things watch` ships first** (maintainer gate, 2026-08-11): the change-watch command (up-next feature item) is a v1.0 prerequisite — it must be built, field-used, and stable before the contract freezes.
- **Field mileage** (maintainer, 2026-08-11): v1.0 is deliberately unhurried — the pre-1.0 period keeps producing design corrections (the deadlines view, the Today-order field bugs), and the contract freezes only after the surface has been driven hard for a while longer.

## Cloud-account probes — blocked on a live Things Cloud account

SYNC2 characterized the sync model on a throwaway account (3-way per-attribute merge, `BSSyncronyMetadata` populating 0→11 rows on attach) but a durable account is needed to go further: the real last-sync-signal taxonomy, on-hardware push/pull cadence, and any sender-side behavior the VM can't reproduce (the SYNCLAT residue). Parked until an account is available. Evidence: [docs/lab/headless-research.md](lab/headless-research.md) (SYNC2).

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
