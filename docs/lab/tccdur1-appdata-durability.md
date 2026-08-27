# TCCDUR1 — the app-data grant is instance-pinned for a DEVELOPER-ID app too; signing class is not the axis

**Golden:** `things-lab-golden-v4` · Things **3.23** (32300036) · macOS **15.7.7 Sequoia** (24G720) · probed **2026-08-27**. ONE disposable clone (`tccdur1`), destroyed at the end. Driver: [`lab/scripts/research-tccdur1.sh`](../../lab/scripts/research-tccdur1.sh) (phases `boot` · `devid` · `reboot` · `launchd` · `helper` · `terminal` · `down`), probe bundle sources in [`lab/scripts/tccdur1-probe/`](../../lab/scripts/tccdur1-probe/). Things itself is never launched: the campaign only opens its container file, so the guest clock is NOT pinned (see §Rig notes). Beep sentinel on for every stage: **0 beeps**, four clean asserts.

## Question

Two measurements were in tension, and the architecture of the reader/deputy pair rests on which one generalizes.

- **[APDP1](apdp1-grant-pinning.md)** (this same golden, macOS 15.7.7, responsible app = the **Apple-platform-signed** `Terminal.app`) measured `kTCCServiceSystemPolicyAppData` as **responsible-app-INSTANCE-pinned**: quit + relaunch re-armed the prompt and rewrote the single TCC row to the new `pid`/`pid_version`.
- A **field observation** on the maintainer's M1 (macOS **15.4.1**, responsible app = a **Developer-ID-signed** third-party app, `com.openai.codex`) saw the grant **SURVIVE an ordinary quit and relaunch**, and reset cleanly with `tccutil reset SystemPolicyAppData com.openai.codex`.

Three axes could explain the difference: **macOS minor version** (15.4.1 vs 15.7.7 — *not testable here*, every golden is 15.7.7), **signing class** (Apple platform vs Developer ID — testable, and the discriminator this campaign was built for), and **responsible-instance subtleties** (a persistent process quietly carrying responsibility across what looked like a restart).

## Verdict — signing class is NOT the axis; the class is instance-pinned for every identity measured

**A Developer-ID-signed, LSUIElement `.app` reading the Things container with its own code behaves exactly like Terminal did.** First read prompts; every later read in that same app instance is clean; an *ordinary* quit (`exit 0`) and relaunch prompts again; a `SIGKILL` and relaunch prompts again; a **reboot** prompts again; a **launchd-hosted** instance of the same signed binary prompts on **every** `launchctl kickstart -k`. The row is always `auth_value = 5`, `auth_reason = 2`, `client_type = 0`, pinned to `pid` + `pid_version` + `boot_uuid`, and it is **rewritten in place** on each new answer. The shipped `com.pixelcog.things-api-helper` bundle behaves identically, and an APDP1 Terminal control re-run **in the same clone** reproduces APDP1 exactly.

So on current macOS the answer to *"could the reader's file-picker/bookmark onboarding be replaced by an Allow/Deny app-data prompt?"* is **no** — and it closes the safe way: nothing has to change.

| Axis | Measured here | Verdict |
|---|---|---|
| Signing class (Apple platform vs **Developer ID**) | identical behavior, both `auth_value 5`, both re-prompt | **NOT the axis** |
| Requester code (app's **own** code vs a spawned child) | identical (in-process SQLite read and a python child both provoke once, then both read clean) | not the axis — re-confirms APDP1 |
| Ordinary quit vs SIGKILL | identical — both re-arm the prompt | not the axis |
| Launch host (`open -a` app vs **launchd** agent) | identical per-instance prompting; launchd just makes instances cheap to create | not the axis |
| Reboot | re-arms (row survives on disk, `boot_uuid` no longer matches) | expected |
| **macOS minor version** | **UNTESTED — every golden is 15.7.7** | the only axis left standing |

## The stage-by-stage TCC column table

Every row below is the complete `kTCCServiceSystemPolicyAppData` state of the user `TCC.db` at that moment (`sqlite3 -line SELECT *`, read over the golden's sshd FDA). `—` = no AppData row exists at all.

| Stage | What just happened | `client` | `type` | `auth` | `reason` | `pid` | `pid_version` | `boot_uuid` |
|---|---|---|---|---|---|---|---|---|
| `00-baseline` | clone booted, nothing run | — | | | | | | |
| `b1-while-modal` | probe app blocked, **dialog on screen** | — | | | | | | |
| `b01-after-b1` | Allow pressed | `com.pixelcog.tccdur1-probe` | 0 | **5** | 2 | 788 | 2033 | `A0B90205…` |
| `b02-after-siblings` | sibling + child reads (no dialog) | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | 788 | 2033 | `A0B90205…` |
| `b03-after-graceful-quit` | app exited 0 | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **788 (dead)** | 2033 | `A0B90205…` |
| `b4-while-modal` | relaunched app blocked, **dialog again** | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | 788 (dead) | 2033 | `A0B90205…` |
| `b04-after-b4-relaunch` | Allow pressed | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **1008** | **2552** | `A0B90205…` |
| `b05-after-sigkill` | `pkill -9` | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | 1008 (dead) | 2552 | `A0B90205…` |
| `b06-after-b5-relaunch` | relaunched, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **1131** | **2833** | `A0B90205…` |
| `r01-post-reboot` | guest rebooted | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | 1131 (dead) | 2833 | `A0B90205…` (stale) |
| `r02-after-r1` | relaunched, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **640** | **1668** | **`346239C1…`** |
| `l00-baseline` | `tccutil reset` + LaunchAgent bootstrapped | — | | | | | | |
| `l01-after-l1` | launchd instance #1, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | 819 | 2103 | `346239C1…` |
| `l02-after-restart1` | `kickstart -k` #1, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **957** | **2414** | `346239C1…` |
| `l03-after-restart2` | `kickstart -k` #2, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **1056** | **2634** | `346239C1…` |
| `l04-after-restart3` | `kickstart -k` #3, **prompted**, Allow | `com.pixelcog.tccdur1-probe` | 0 | 5 | 2 | **1153** | **2850** | `346239C1…` |
| `a01-after-a1` | **shipped helper**, first read, Allow | `com.pixelcog.things-api-helper` | 0 | 5 | 2 | 1317 | 3236 | `346239C1…` |
| `a02-after-quit` | deputy SIGTERM'd (drains, exits 0) | `com.pixelcog.things-api-helper` | 0 | 5 | 2 | 1317 (dead) | 3236 | `346239C1…` |
| `a03-after-relaunch` | relaunched, **prompted**, Allow | `com.pixelcog.things-api-helper` | 0 | 5 | 2 | **1494** | **3625** | `346239C1…` |
| `t01-after-t1` | **Terminal control**, first read, Allow | `com.apple.Terminal` | 0 | 5 | 2 | 2758 | 6441 | `346239C1…` |
| `t02-after-t2` | Terminal quit + relaunched, **prompted**, Allow | `com.apple.Terminal` | 0 | 5 | 2 | **2931** | **6803** | `346239C1…` |

Two structural facts the table makes plain, both new relative to APDP1:

1. **The row is written on the ANSWER, not on the ask.** `b1-while-modal` and `l1-while-modal` were captured with the dialog standing on screen and the requester blocked in the kernel — and the AppData row count is **zero**. Nothing in TCC records that a question was asked.
2. **The row OUTLIVES its grant.** After a graceful quit, a SIGKILL, and a full reboot the row is still on disk, unchanged, naming a dead pid (and after the reboot, a stale `boot_uuid`). It is inert: the very next read prompts. A row's existence is therefore **not** evidence of a live grant — only the `(pid, pid_version, boot_uuid)` triple matching a live process is.

## Cell detail

### Stage B — Developer-ID app, its OWN code doing a real SQLite content read

The subject is `TCCDUR1 Probe.app` (`com.pixelcog.tccdur1-probe`, `LSUIElement`, hardened runtime, **Developer ID Application** + secure timestamp — the same identity and options `scripts/build-helpers.sh` uses), launched **directly as an app** with `open -a`, never through launchd. Its main executable opens the container `main.sqlite` with `sqlite3_open_v2(…, SQLITE_OPEN_READONLY, …)` and runs `PRAGMA schema_version` — a real content read; a metadata stat does not prompt.

| Cell | What ran | Modal? | Result |
|---|---|---|---|
| **b1** | first in-process read, app instance #1 (pid 788) | **YES** — *"“TCCDUR1 Probe” would like to access data from other apps."* | `ok`, `schemaVersion 107`, **12.249 s** (the wait was ours: the AX drive pressed Allow) |
| b2 | sibling in-process read, same instance | no | `ok` in **4 ms** |
| b3-child | a spawned **python child** (pid 964, ppid 788) does the `open(2)` | no | `ok` in **8 ms** (child), 136 ms round trip |
| **b4** | first read after an **ORDINARY QUIT** (`exit 0`) + relaunch (pid 1008) | **YES** | `ok` after **12.099 s** — a fresh dialog |
| **b5** | first read after **SIGKILL** + relaunch (pid 1131) | **YES** | `ok` after **12.083 s** — a fresh dialog |

b2/b3-child re-confirm APDP1's responsible-app law under a new signing class: **the pid that opens the file is irrelevant**, the app instance is what holds the grant. b4 is the campaign's whole point — the maintainer's M1 saw this cell come back clean; here it prompts.

`launchctl procinfo` on every instance reported `responsible pid` = its own pid, i.e. the app is its own responsible process under `open -a`, exactly as intended.

### Stage R — reboot

The clone was rebooted with a live grant on record. The row survived the reboot on disk with the pre-reboot `boot_uuid`; the first read after relaunch **prompted** (12.978 s) and rewrote the row with the new boot's UUID. Reboot durability: **none**.

### Stage L — launchd-hosted, the same signed binary

A user LaunchAgent whose `ProgramArguments[0]` is the bundle's own main executable (so the code identity and bundle id are unchanged). `launchctl procinfo` reports `responsible pid` = self and `responsible path` = the bundle executable, so launchd hosting does not hand responsibility to launchd.

| Cell | What ran | Modal? | Result |
|---|---|---|---|
| **l1** | launchd instance #1 (pid 819), first read | **YES** | `ok` after **14.815 s** |
| l2 | sibling read, same instance | no | `ok` in **6 ms** |
| **l3-r1** | after `launchctl kickstart -k` (pid 957) | **YES** | `ok` after **12.120 s** |
| **l3-r2** | after `kickstart -k` (pid 1056) | **YES** | `ok` after **12.507 s** |
| **l3-r3** | after `kickstart -k` (pid 1153) | **YES** | `ok` after **12.159 s** |

This is the 2026-08-21 host observation ("three launchd-hosted deputy launches each prompted") reproduced with column evidence: three restarts, three prompts, three rewrites of the one row. A headless helper cannot ride this class — it would ask the user once per launch, forever, and each ask blocks the read in the kernel until answered.

### Stage A — the SHIPPED helper bundle

`Things API Helper.app` (`com.pixelcog.things-api-helper`) launched with `open -a`, driven over its own UNIX socket. The deputy no longer serves file verbs at all (they live on the sandboxed reader), so the provocation rides its `osascript` verb: the deputy spawns `/usr/bin/osascript` as a child, and the script does `open for access` + `read … for 16` on the container DB. The child is Apple-signed; its **responsible app is the Developer-ID helper bundle that spawned it**, and TCC names the helper.

| Cell | What ran | Modal? | Result |
|---|---|---|---|
| **a1** | first read, helper instance #1 (pid 1317) | **YES** — *"“Things API Helper” would like to access data from other apps."* | `SQLite format 3 `, **13.436 s** |
| a2 | second read, same instance | no | same bytes in **51 ms** |
| **a3** | after SIGTERM (the deputy's graceful drain, exit 0) + relaunch (pid 1494) | **YES** | same bytes after **13.645 s** |

### Stage T — the APDP1 control, in the SAME clone

| Cell | What ran | Modal? | Result |
|---|---|---|---|
| **t1** | Terminal-hosted child read, Terminal pid 2758 | **YES** — *"“Terminal” would like to access data from other apps."* | `SQLite format 3`, **13.797 s** |
| **t2** | Terminal killed + relaunched (pid 2931) | **YES** | `SQLite format 3`, **13.925 s** |

APDP1 c1/c6 reproduce exactly. The control matters: it rules out "something about this clone" as the reason the Developer-ID cells prompted.

## `auth_value` semantics — 5 is the instance class, and nothing in this matrix ever landed 2

Every AppData grant issued in this campaign — three identities, eleven Allows — landed `auth_value = 5`, `auth_reason = 2`, with `pid`, `pid_version` and `boot_uuid` populated. For contrast, the same clone's TCC databases carry **durable** grants for other services and every one of them is `auth_value = 2` with those instance columns empty: `kTCCServiceAppleEvents | /usr/libexec/sshd-keygen-wrapper | auth=2`, `kTCCServiceAccessibility | /usr/libexec/sshd-keygen-wrapper | auth=2`, `kTCCServiceScreenCapture | … | auth=2`, the whole `kTCCServiceLiverpool` set at `auth=2`, and denials at `auth=0`.

**The discriminator is therefore readable in one query, and it is the single cheapest thing the maintainer can run on his own M1:**

```sh
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT client, auth_value, auth_reason, pid, pid_version, boot_uuid
     FROM access WHERE service='kTCCServiceSystemPolicyAppData';"
```

`auth_value 2` with empty instance columns would mean 15.4.1 issues this class **durably** and Apple tightened it later — the version axis, confirmed. `auth_value 5` with a populated `pid` would mean the M1 grant was the same instance-scoped row measured here, and the "survived a quit and relaunch" observation has a mundane explanation instead: the responsible app instance never actually died (a menu-bar/`LSUIElement` process, a login-item respawn, or a helper still holding responsibility across what looked like a restart — the tmux law from the other side).

## Rig notes (reusable)

- **The guest clock is deliberately NOT pinned in this campaign.** Every other driver pins to the golden's `pinnedDate` because of the trial wall; this one never launches Things, so the wall is irrelevant, and the probe bundles are signed by a Developer ID certificate with `notBefore = 2026-08-20` and a secure timestamp in 2026-08. That is *after* both the 2026-07-05 pin and the clone's own RTC (which boots to 2026-07-11). Measured, and reassuring: `codesign --verify` returns **valid on disk / satisfies its Designated Requirement** under both clocks — signature validity is evaluated against the embedded secure timestamp, not the wall clock. What a past clock *does* change is nothing that matters here. Separately, `spctl -a` **rejects** the bundle (`source=Unnotarized Developer ID`) and it launches anyway: Gatekeeper assessment gates *quarantined* apps, and an `scp`-delivered bundle carries no `com.apple.quarantine` xattr.
- **TCC dialogs QUEUE, and one survives its requester's death** (APDP1 stage A, from the other side). This campaign's first stage-T pass killed a Terminal while its child was blocked; the dialog stayed on screen, and the *next* cell's `press Allow` answered the **stale** dialog instead of its own. The symptom is maximally deceptive: the TCC row updates (naming the old instance's pid), the driver reports "modal answered", and the new requester is still blocked in the kernel. Every phase now calls `drain_dialogs` — press Allow until an AX census finds no Allow button — before it resets and starts. Generalized: **an AX census taken before your own cell can be answering someone else's question.**
- **A shell redirect creates the result file EMPTY at cell start**, so a host-side `test -f` poll declares a still-blocked cell finished-with-no-result. The same first stage-T pass shipped two bogus `modal=NO` verdicts that way. Cells write through a temp and `mv`, and every poll is `test -s`.
- **`LC_ALL=C` on any awk that touches a TCC dump** — the `csreq` column is a binary blob and a UTF-8 awk aborts mid-file with `towc: multibyte conversion failure`.
- The dialog belongs to **`UserNotificationCenter`**, never to the requester or its responsible app, so a per-app AX dump cannot see it — [`axsys.jxa`](../../lab/scripts/tccdur1-probe/axsys.jxa) (lifted from APDP1) walks every process that has a window. AXPress on the TCC dialog works under the AXVM1 grant; no synthetic-HID fallback was needed in any cell.
- The provoking process is handed a **concrete** DB path from a file; globbing the container directory is itself a gated operation and would move the provocation to a different syscall (APDP1).
- `sudo launchctl procinfo <pid>` is the cheap attribution oracle — it prints `responsible pid`, `responsible unique pid` and (for launchd-hosted processes) `responsible path`. Capture it for the app instance at every launch; it is what proves the responsible process is the one you think it is.

## Architecture recommendation

The maintainer's note keeps two decisions apart, and so does this section.

### Decision 1 — authorization mechanism: KEEP the security-scoped bookmark; do NOT adopt an app-data prompt

**Recommendation: no change.** The App Data prompt is the nicer UX — one Allow/Don't Allow instead of a folder picker with wrong-selection recovery — and that motivation is real and unchanged. But on macOS 15.7.7 the grant it produces cannot carry the reader's job, and the failure is not marginal: the grant dies with the process instance. Against the note's decision criteria, measured:

| Criterion (maintainer's wording) | Measured |
|---|---|
| reliably **attributable** | **YES** — the row names the responsible app's bundle id; a child four levels down provokes it and the app is charged |
| **durable across lifecycle events** | **NO** — dies on ordinary quit, on SIGKILL, on reboot, and on every launchd restart |
| **reacquirable** | YES — `tccutil reset` clears it and the next content read re-prompts |
| **host-independent** | YES *while the instance lives* — any client reaching a live granted helper reads clean |
| acceptable in **scope** | **NO** — see blast radius below |

Two standing counterpoints hold regardless of the verdict, and both would still apply even if a future macOS made this class durable:

- **A sandboxed process cannot receive the app-data prompt at all.** SANDBOX1 cell (e) measured it: without resolving its bookmark, the sandboxed reader's container access is denied by the sandbox **immediately** — errno 1, no prompt, no stall. The sandbox refuses before TCC is ever consulted. So "replace the picker with an Allow/Deny prompt" is not a swap of one dialog for another; it means **unsandboxing the reader**, and the sandbox is the thing that makes the reader's scope OS-enforced rather than promise-enforced.
- **Blast radius.** `kTCCServiceSystemPolicyAppData` is not directory-scoped. It authorizes the responsible app against *other apps' container data* as a class, where the bookmark authorizes exactly one directory the user picked and the sandbox denies everything else outright. Trading a per-directory, OS-enforced grant for a broad one to save a folder-picker step is the wrong direction for a helper whose entire reason to exist is least privilege.

The honest caveat, stated plainly: **this campaign cannot test macOS 15.4.1.** Every golden is 15.7.7. If the M1's row turns out to be `auth_value 2`, the class *was* durable on that build and Apple tightened it — which would make adopting it a bet on a behavior Apple has already walked back, i.e. worse than the verdict above, not better. The one-query check in §`auth_value` semantics settles which story is true for the cost of a paste.

### Decision 2 — process architecture: keep reader and deputy SEPARATE

**Recommendation: no change, and this campaign supplies no argument for merging.** The strongest case for a merge was always "one process, one durable grant, less machinery". That case required the durable app-data grant, and it does not exist here. What the measurements leave is the status quo ante:

- The reader is **sandboxed** and holds a bookmark to exactly one directory; the deputy is **unsandboxed** and holds Automation + Accessibility. Merging means one process holding broad app-data (or FDA) *plus* the authority to drive any app and synthesize input — the union of every grant, in one address space, reachable through one socket.
- The two also cannot share a sandbox posture: the deputy's job (AppleEvents to arbitrary targets, `AXIsProcessTrusted`, spawning `osascript`/`shortcuts`) is exactly what the reader's sandbox exists to forbid. A merged process is necessarily the unsandboxed one, which means the file leg loses its OS-enforced scoping — the reader's whole point.
- Operational simplicity does not outweigh that here, because the pair's operational cost is already paid: one bundle, one installer, one `things helpers` surface, one version line (#517).

Revisit only if a future macOS is measured to issue a **durable, directory-scoped** grant to an unsandboxed signed identity. Neither half of that has been observed.

### What would change the answer

1. A `SELECT … FROM access WHERE service='kTCCServiceSystemPolicyAppData'` on the M1 returning `auth_value = 2` with empty `pid`/`boot_uuid` — that is a real version difference and worth a follow-up campaign the moment a 15.4.x golden exists.
2. Apple documenting or shipping a directory-scoped, durable app-data grant for unsandboxed helpers. There is no sign of one.

Until then the shipped design is correct as it stands, and the file-picker ceremony stays.
