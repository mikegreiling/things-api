# APDG1 — which container touches the app-data class actually gates, and the shipped verb that ignored it

**Probed under:** `things-lab-golden-v4` · Things 3.23 (build 32300036) · macOS 15.7.7 · pinned clock 2026-07-05 · one clone, airgapped · 2026-08-31
**Driver:** [`lab/scripts/research-apdg1.sh`](../../lab/scripts/research-apdg1.sh) (+ [`lab/scripts/apdg1-axsys.jxa`](../../lab/scripts/apdg1-axsys.jxa), [`lab/guest/standin-reader.mjs`](../../lab/guest/standin-reader.mjs))
**Issue:** [#664](https://github.com/mikegreiling/things-api/issues/664) · **Beeps:** 0 across 8 stage marks

## The report

`things rescue relaunch --yes --dangerously-force-quit --json`, run from a CLI hosted under an app with no Full Disk Access, put the macOS **"access data from other apps"** modal on screen — outside any ceremony, which [Article I](../design/permissions-doctrine.md) makes a constitutional bug — and then **produced no output at all** before the caller's wait elapsed. Things had already relaunched by then, so the verb's own job was done; only the report never arrived.

**The field machine has the helpers installed and granted.** That is what makes this a *routing bypass* rather than a missing degradation path: reads on that machine are authorized, the reader holds a durable bookmark over the container, and the code went to the container anyway — on the host's own lineage, which holds nothing.

## The rig, and the one thing it had to solve

Every measured cell runs inside its **own fresh Terminal.app instance**. An ssh-descended process in a clone inherits `sshd-keygen-wrapper`'s FDA ([APDP1](apdp1-grant-pinning.md) header; SANDBOX1 probe-fidelity note) — which is precisely the standing that *hides* this bug — and a denial is pinned to the app instance ([APDP1](apdp1-grant-pinning.md), [TCCDUR1](tccdur1-appdata-durability.md)), so a reused instance would answer the next cell's question for it.

Modelling a **helpers household** in a clone was the new problem: the shipped reader is a Developer-ID-signed, App-Sandboxed bundle holding a security-scoped bookmark, and a disposable clone has no signing identity and nobody to answer the grant panel. [`lab/guest/standin-reader.mjs`](../../lab/guest/standin-reader.mjs) stands in for **exactly one property** of it — it holds the container access and clients reach it over the rendezvous instead of touching the container themselves. Started over ssh, *it* inherits the FDA; the client, launched from Terminal, holds nothing; `THINGS_API_READER_DIR` + `THINGS_API_HELPERS=true` join them. That split is the field's. It is **not** the reader (no sandbox, no bookmark, no signature, no launchd) and proves nothing about the reader's own security properties — what it makes testable is the **client** side: does our code route the touch, or reach past it. Confirmed live before any cell ran: `doctor` reported `"read":{"mode":"helpers"}`.

Two builds shipped side by side into the same clone — `app-pre` from `origin/main`, `app-fix` from the branch — so every A/B is one clone, one Terminal, one macOS.

## The cells

| cell | build | helpers | host | modal | elapsed | what the schema step said |
|---|---|---|---|---|---|---|
| c0 | pre | – | ssh (**has FDA**) | – | – | the database opened and reads as the shape this version expects |
| **h0** | pre | serving | Terminal (**nothing**) | **NO** | <1 s | `doctor`: WAL mtime **read successfully**, `2026-07-05T12:00:42Z`, "write activity is fresh" |
| **h1** | pre | serving | Terminal (**nothing**) | **YES** | 30 s | "the Things database could not be found" + a **false** drift warning |
| **h2** | fix | serving | Terminal (**nothing**) | **NO** | 6 s | **the database opened and reads as the shape this version expects** |
| h3 | fix | serving | Terminal (**nothing**) | NO | <1 s | `doctor`: clean, WAL line intact |
| n1 | pre | none | Terminal (**nothing**) | **YES** | 27 s | "could not be found" + the same false warning |
| n2 | pre | none | Terminal, **same instance as n1** | NO | 5 s | post-deny fast-fail, no re-ask |
| n3 | fix | none | Terminal (**nothing**) | NO | 5 s | "the database was not checked — Terminal cannot open the Things data folder — no app-data grant has been witnessed on this machine" |
| n4 | fix | none | Terminal (**nothing**) | NO | 0 s | `rescue status` — prompt-free, as it always was |
| c6 | fix | – | ssh (**has FDA**) | – | – | the database opened and reads as the shape this version expects |

TCC rows, user database: **0** app-data rows at baseline, **0** after h0, **1** after h1 — `kTCCServiceSystemPolicyAppData | com.apple.Terminal | client_type=0 | auth_value=0 | auth_reason=2`, a recorded refusal — and **no further rows for the rest of the run**. Every modal was DENIED; nothing was ever granted.

## §1 — The provoking call, and the parked syscall

The modal is raised by the **directory enumeration**, not by the database open:

```
role=AXStaticText | val=“Terminal” would like to access data from other apps. | @[401,209 222x34]
role=AXButton | ttl=Don’t Allow | @[397,309 112x30]
role=AXButton | ttl=Allow      | @[515,309 112x30]
```

It belongs to `UserNotificationCenter` (`com.apple.UserNotificationCenter`), not to Terminal — a system modal in no application's own tree, exactly as [`rescue status`](../../src/rescue.ts) describes that class. The requester is the node process; the **responsible** process is Terminal four levels up (`responsible pid = 1023` for requester pid 1036), consistent with APDP1.

The call is `globSync(CONTAINER_GLOB, { cwd: home })` in [`src/db/locate.ts`](../../src/db/locate.ts) — reached from `rescue relaunch` rung 5 via `realSchemaStatus()` → `locateThingsDb()`. Proof that it is the glob and not `openConnection()`: after the deny, the pre-fix ladder reports **"the Things database could not be found"**. An EPERM'd enumeration comes back **empty rather than throwing**, so the locate never found a path to open — and the code then misreported a permission wall as a missing database, and warned that the schema had drifted on the strength of it.

**The syscall parks.** While the modal stood, the requester sat in `STAT S+` inside the glob and the verb had produced nothing; it returned only after the button was pressed. h1 took 30 s of which ~20 s was our own dialog-answering delay, against 6 s for the same verb with the fix. This is [TCCDUR1](tccdur1-appdata-durability.md)'s parked-syscall law reaching a shipped surface: **with nobody at the screen the command does not fail, it waits** — which is the whole of the report's "produced no structured result".

## §2 — THE LAW: the app-data class gates *enumeration and open*, not `stat`

This is the finding worth keeping, and it went the opposite way to the standing suspicion.

**h0 and h1 ran in identical instances — same clone, same helpers configuration, same Terminal with no grant and no prior row — and disagreed.** h0 (`doctor`) performs a bare `statSync` on `<db>-wal` in `sync-health`; it returned the **real mtime**, with **no dialog and no EPERM**, and wrote **no TCC row**. h1, one verb over, enumerated the container and was stopped dead.

> **`kTCCServiceSystemPolicyAppData` is operation-shaped, not path-shaped.** Enumerating a directory inside another app's group container, or opening a file there, is gated. Asking for **metadata on a path you already hold** is not — `stat(2)` traverses (which needs only `+x` on the parents) and answers. Measured macOS 15.7.7.

Two consequences, both acted on:

- **The queued residual is answered NO.** `sync-health`'s direct `statSync` was never a prompt vector, in the very configuration it was queued about. It is deliberately left **ungated**, with the measurement recorded at the call site.
- **An over-cautious gate is a real regression.** Gating it was tried first and **reverted** on this evidence: h3 under the gated build lost the WAL line that h0 had, on exactly the machines that have the helpers and no FDA — the shape #664 was reported from. A dialog that does not happen is not worth a signal that does. (The same applies to the write pipeline's launch-readiness `stat`, also left alone.)

The generalizable rule: **do not gate on suspicion of a consent class — measure which operation it hooks.** The cost of guessing runs in both directions.

## §3 — The fix, and what it restores

`realSchemaStatus()` now asks `readCapability()` before anything, and then:

1. **helpers serving** → `deputyDbPath()` + the deputy db facade. The container is never touched by this process, and the check **runs in full**. (h2: *"the database opened and reads as the shape this version expects"*, from a host holding nothing — the point of the helpers, finally true here.)
2. **this process's own standing covers its syscalls** (`direct-fda`, a live `session-grant`, an explicit path) → open locally, exactly as before. (c0 ≡ c6.)
3. **neither** → skip, and say so on the ladder. (n3.)

`directContainerAccessAllowed()` names the distinction that was missing: `readAllowed()` asks *whether a read is authorized*, this asks *whether **this process** may issue the syscall*. `helpers` answers **yes** to the first and **no** to the second, and collapsing them is what made a fully-onboarded machine prompt.

Two smaller corrections ride along, both visible in the table: an unchecked database no longer produces the drift warning (only a check that **ran** can fail — the #629 "unset default rendered as a measurement" mistake), and the core ladder — quit, TERM, KILL, relaunch — is now provably free of any container access, which is why n3/h2 complete in 5–6 s with the dialog never entering the picture.

## §4 — What is NOT claimed

- The stand-in reader proves nothing about the **shipped** reader's security properties. It models the client-side split only.
- `stat`'s ungated status is measured on **macOS 15.7.7**. It is an Apple implementation detail with no contract, and it belongs in the [assumption register](../reference/assumption-register.md) as a re-checkable, not in anyone's head as a permanent fact.
- Nothing here was ever **granted**. Every modal was denied, so the post-grant behaviors (APDP1's sibling-reads-clean, TCCDUR1's re-prompt matrix) are untouched and stand as they were measured.
