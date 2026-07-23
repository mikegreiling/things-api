# SYNCLAT — do programmatic writes trigger a Things Cloud push?

Run `things-run-synclat-20260723-130618` (`lab/scripts/research-synclat.sh`), prompted by Mike's live observation (2026-07-23): an agent-created to-do (`things` CLI = `open -g things:///add`, filed into Someday of a work area, long note) appeared in the desktop GUI instantly but did **not** reach his phone for a couple of minutes, and the Things Cloud settings panel showed the last sync **15-20 min prior** — while a manual GUI-created to-do advanced the panel timestamp the moment editing finished. Working hypothesis: **GUI edits push immediately; URL-scheme / AppleScript writes ride only the periodic sync timer.**

**Rig.** Two NAT-networked clones of `things-lab-golden-v1` (A = writer, B = observer), both booted **concurrently** with a live GUI, both signed into ONE throwaway Things Cloud account (mail.tm + random password, no Apple ID; creds in the gitignored run dir, account burned afterward). Clock **PINNED to 2026-07-05** (not NTP-realtime) — verified this run that under the pinned clock the trial is valid ("13 days left"), TLS to `cloud.culturedcode.com` returns 200, and account creation + `BSSyncronyMetadata` populate + two-clone sync all work, sidestepping the golden's ~2026-07-18 real-date trial expiry entirely.

**Signals.** (1) **A push signal** — the `BSSyncronyMetadata` last-sync-ATTEMPT double (the same value `doctor`'s sync-health section decodes; nearest-to-now, excluding the ~now+31yr lease sentinel). Its key was account-specific (`KgDieoLhfTENjtYqU1sCxX` here, not SYNC2's `GryCJ44xPcJG6go5KeTZp1`) — reconfirming SYNC2's one-account caveat; the value-based nearest-to-now heuristic is the robust reader. The pinned clock ticks at real rate, so signal deltas == real elapsed seconds. (2) **B arrival** — the written title appearing in clone B's sqlite (end-to-end ground truth). Measurement axis = **host wall-clock**.

## Headline verdict — the hypothesis is FALSIFIED

**Every tested write vector triggers a prompt sender-side Things Cloud push (~2-3 s).** The URL-scheme path Mike used (`open -g things:///add`, byte-identical to the CLI's `todo add`, `src/write/vectors/url-scheme.ts`) pushes just as promptly as a GUI edit, and the pushed item genuinely reaches the server (proven: clone B pulled it down). Destination (today/someday/into-project), note size (1.2 KB), and app foreground/background state make **no** difference.

### Arms × signals

Idle baseline first: with **no writes**, A's push signal stayed **flat for ~16-20 min** (observed across the run) — there is **no periodic idle heartbeat**. So the advances below are *write-triggered*, not a coincidental periodic sync. (This also explains Mike's "15-20 min prior" panel on its own: an idle machine's last sync legitimately ages 15-20 min when nothing local changes.)

| Arm | Things state | A push signal | Notes |
|---|---|---|---|
| **GUI create** (VNC "+" → type → commit) | foreground | advanced by **≤ +11.6 s** | first poll sample was +11.6 s (SSH/subprocess overhead); true latency likely lower |
| **URL add** `when=someday` | foreground | **+2.3 s** | **item PROVEN on server** — clone B pulled it after B synced |
| **URL add** `when=someday` | background (Finder frontmost) | **+2.6 s** | foreground/background irrelevant |
| **URL add** `when=today` | background | **+2.3 s** | destination irrelevant |
| **URL add** into project + `when=someday` + 1.2 KB note | background | **+2.3 s** | **Mike's exact case** — still pushes promptly |
| **AppleScript** `make new to do` | background | **+2.6 s** | pre-launched Things → stayed background, no focus steal |
| **Shortcuts** `things-proxy-create-heading` | background | **not measured** | `shortcuts run` hung on an in-clone consent re-prompt (rc=142); skipped per brief. Very likely pushes too (it is another local write processed by Things) but not asserted without evidence |
| **Cold-idle URL add** (Things backgrounded + idle **~20 min**, then URL add) | background | **≤ +14 s** (overhead-inflated; true latency lower) | tests the "cold sync connection" hypothesis (Mike's long-idle-Mac condition) — **still pushes promptly**, cold-connection NOT reproduced |

**Mechanism.** Things syncs **on change** (event-driven), not on a short fixed timer: any local mutation — via GUI, URL scheme, or AppleScript — makes Things' sync engine attempt an upload within a couple of seconds. There is no idle heartbeat to wait for.

## Where the minutes-of-latency actually comes from — the RECEIVER

The sender pushes immediately; **the delay is on the receiver's pull.** Idle clone B **never naturally pulled** A's writes during observation (flat for 5 min+ across two windows) — it synced *only* when it had a local change of its own to push (a full sync pushes local + pulls server). This is the VM-without-APNs behavior: **APNs push notifications are unavailable in the VM** (SYNC2: "Application not properly entitled for push notifications … push-triggered sync degrades to polling"), so the receiver has no push-wake and its idle poll interval is very long.

Consequence: **the VM cannot measure the real-phone receiver latency** (a real iPhone gets an APNs push-wake the VM lacks). But the symptom Mike saw — "invisible on mobile for minutes" — is fully consistent with a **receiver-pull delay**, NOT a sender no-push. His phone (like idle B) simply hadn't pulled yet.

## Settings-panel "Last Updated" == the BSSyncronyMetadata attempt signal

After a foreground sync, A's Things Cloud settings panel read **"Last Updated: Today, 12:25 PM"** and the `BSSyncronyMetadata` last-attempt signal read the same **12:25:00**. Opening the panel (which foregrounds Things) itself triggers a sync that refreshes both together. **So `doctor` can report the last-attempt timestamp as the panel's "last updated" honestly** — they are the same value.

## Reconciling with Mike's observation (the open discrepancy)

Mike saw a *sender-side* GUI-vs-URL difference (panel advanced for the GUI edit, stayed stale 15-20 min for the CLI/URL write). The lab does **not** reproduce that: both push promptly. Candidate explanations for the real-machine difference, none reproduced here:

1. **Cold sync connection** (was the leading candidate — **not reproduced**). Hypothesis: Things holds a persistent sync connection that pushes instantly while "hot"; on Mike's long-idle Mac it may have idle-dropped so a URL write must reconnect first. **Tested and falsified in the VM:** after ~20 min of idle + backgrounded Things (no sync the entire time), a URL write STILL pushed within ≤14 s. So the fresh-login-hot-connection theory does not explain the discrepancy either — the sender pushes promptly even cold-idle.
2. **Receiver-only symptom.** "Didn't reach the phone for minutes" is receiver-pull-bound regardless of sender timing (reproduced: idle B doesn't pull).
3. **Account/device scale, network, or APNs state** on a long-lived multi-device account vs. a fresh two-clone account.

## Mitigation ranking — MOOT

Because programmatic writes **already** push promptly, **no sync-nudge is needed** for the sender. There is also **no "Sync Now" menu item** to drive (UIC1 File/Items/app-menu dumps carry none), so no AX trigger exists anyway. Foregrounding Things (`activate`) does trigger a sync, but it is unnecessary and steals focus (disruption tier 2). If a future **on-hardware** repro confirms a genuine sender no-push under a cold connection, candidate nudges to test then, cheapest first: a benign background URL invocation (`things:///show?id=`, tier 0-1), a no-op-adjacent AppleScript read (`count of areas`, tier 0), then `activate` (tier 2, last resort) — none tested here because the premise did not hold in the lab.

**No oddity filed** — the finding is the *opposite* of a no-push bug.

## Product implication (for the §6 build item)

The "post-write sync nudge" build (up-next §6 SYNCLAT step 2) is **not justified by these results** — the sender already pushes. The real lever, if agent-created items must appear on mobile faster, is on the **receiver**, which the sender cannot force. Recommended documentation for the skill/contracts references: *"URL-scheme / AppleScript writes DO trigger an immediate Things Cloud push (~2-3 s to the server), same as a GUI edit; latency before an item appears on another device is that device's pull/APNs-wake cadence, not a sender-side delay."* Before building any nudge, get an **on-hardware** repro of Mike's sender-side stale-panel observation (cold-connection hypothesis) — the fresh-login lab could not reproduce it.

## Reproduce

```
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-synclat.sh
```

Requires `vncdotool` (host pip is externally-managed → throwaway venv) + `sshpass`. Provisions its own disposable account and tears down both clones on exit. Per-arm sampling is driven by the per-run `poll.sh` (emitted alongside). See the arm sequence in the script header. **Lab-infra note:** under concurrent background `sshpass` load the host occasionally throws `sshpass: failed to change user ID: operation not permitted` — a transient; retry the call (the run-dir helpers wrap a short retry).
