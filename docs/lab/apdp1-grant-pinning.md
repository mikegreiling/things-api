# APDP1 — the app-data grant is keyed to the RESPONSIBLE APP, not to the accessing pid

**Golden:** `things-lab-golden-v4` · Things **3.23** (32300036) · macOS **15.7.7 Sequoia** (24G720) · guest clock pinned **2026-07-05** · probed **2026-08-25**. ONE disposable clone (`apdp1`), destroyed at the end. Drivers: [`lab/scripts/research-apdp1.sh`](../../lab/scripts/research-apdp1.sh) (phase 1, cells c0–c6) and [`lab/scripts/research-apdp1b.sh`](../../lab/scripts/research-apdp1b.sh) (phase 2, stages A/B/C, run twice against the same clone). Things itself is never launched: the campaign only opens its container file.

## Question

`things setup`'s read leg provokes the "would like to access data from other apps" modal (`kTCCServiceSystemPolicyAppData`) with a deliberate `open(2)`, and macOS parks that syscall in the kernel until someone answers the dialog — so the ceremony's wait is **UNBOUNDED**. Bounding it means provoking from a **child process** the ceremony can give up on, which is only sound if the grant belongs to the **responsible app** (the terminal at the top of the attribution chain) rather than to the **pid that made the call**. The measurement on record ([decisions.md](../design/decisions.md) 2026-08-21, [sandbox1](sandbox1-scoped-reader.md)) said "allow-once-per-process, pid + boot_uuid-pinned" but never separated a child pid from its responsible parent: all three of its data points were *separate launches of a launchd-hosted deputy*, which are separate responsible processes as well as separate pids.

## Verdict — RESPONSIBLE-APP-INSTANCE-pinned

**The grant is keyed to the responsible app's bundle id, pinned to that app INSTANCE (pid + pid_version + boot_uuid). The pid that opens the file is irrelevant** — a child provokes it, and the parent, its siblings, its grandchildren, and shells in other windows of the same app all read clean afterwards. Quitting and relaunching the app re-arms the prompt. The earlier "pid-pinned" phrasing was not wrong about the *durability* (the row is still per-instance and dies with the app), only about *which* pid it is pinned to — and that distinction is exactly what the bounded child needs.

| Cell | What ran | Modal? | Result |
|---|---|---|---|
| c0 | control: the same open from an **ssh**-descended process | no | `ok` in 8 ms — sshd holds FDA in the golden, which is why every cell below runs under Terminal instead |
| **c1** | child #1 of the Terminal shell | **YES** | `ok` after **11.703 s** (the wait was ours: the AX drive pressed Allow) |
| **c2** | SIBLING child #2, same shell, new pid | **no** | `ok` in **8 ms** |
| **c3** | the PARENT SHELL itself (`read` builtin — bash does the `open(2)`) | no | `ok` in 31 ms |
| **c4** | a GRANDCHILD (`bash -c` → python) | no | `ok` in 9 ms |
| **c5** | a shell in a SECOND Terminal WINDOW (same app instance, its own `login`/`zsh` lineage) | no | `ok` in 11 ms |
| **c6** | a shell in a **RELAUNCHED** Terminal (app killed, new instance) | **YES** | `ok` after **11.232 s** — a fresh dialog |

### Raw evidence

The attribution chain every cell ran under (phase-1 `parent.log`) — the accessing process is python, four levels below the app:

```
=== PARENT1 pid=712 ppid=707 ts=1783252807 ===
  712   707 /bin/bash
  707   705 -zsh
  705   703 login
  703     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
    1     0 /sbin/launchd
```

The dialog, owned by **`UserNotificationCenter`** (not by Terminal and not by the requester), while c1's child sat blocked:

```
=== PROC UserNotificationCenter (com.apple.UserNotificationCenter) pid=779 windows=2 ===
    role=AXStaticText | val=“Terminal” would like to access data from other apps.
    role=AXButton | ttl=Don’t Allow | @[397,309 112x30]
    role=AXButton | ttl=Allow | @[515,309 112x30]
[c1] blocked pid=775  program path = …/Python3.framework/…/Python
  PID  PPID STAT COMMAND
  775   712 S+   …/Python /Users/admin/labh/apdp1/tryopen.py c1 …/main.sqlite
```

The cell results, verbatim (note the pids and the elapsed times — the two 11 s waits are the two dialogs):

```
{"label": "c1", "pid": 775,  "ppid": 712,  "ok": true, "head": "SQLite format 3", "elapsedSec": 11.703}
{"label": "c2", "pid": 859,  "ppid": 712,  "ok": true, "head": "SQLite format 3", "elapsedSec": 0.008}
{"label": "c3", "pid": 712,               "ok": true, "detail": "ok",             "elapsedSec": 0.031}
{"label": "c4", "pid": 930,  "ppid": 712,  "ok": true, "head": "SQLite format 3", "elapsedSec": 0.009}
{"label": "c5", "pid": 1030, "ppid": 982,  "ok": true, "head": "SQLite format 3", "elapsedSec": 0.011}
{"label": "c6", "pid": 1157, "ppid": 1105, "ok": true, "head": "SQLite format 3", "elapsedSec": 11.232}
```

And the TCC row itself says it outright. The user `TCC.db` held **zero** `kTCCServiceSystemPolicyAppData` rows at baseline; after c1 it held exactly one, whose `client` is the app's bundle id and whose `pid` is **Terminal's** (703), not the requester's (775):

```
service = kTCCServiceSystemPolicyAppData      service = kTCCServiceSystemPolicyAppData
 client = com.apple.Terminal                   client = com.apple.Terminal
client_type = 0        (bundle id)            client_type = 0
auth_value = 5         (allow-once class)     auth_value = 5
auth_reason = 2                               auth_reason = 2
pid = 703              ← Terminal, not 775    pid = 1082             ← the RELAUNCHED Terminal
pid_version = 1823                            pid_version = 2706
boot_uuid = 6BAF44BA-…                        boot_uuid = 6BAF44BA-…
        (after c1)                                    (after c6)
```

One row, rewritten in place: c6's answer re-pinned the same client row to the new app instance. `pid_version` is the kernel's per-pid generation counter, which is what makes the pinning safe against pid reuse — the same guarantee the shipped marker gets from `pid` + `ps -o lstart` ([`src/session-grant.ts`](../../src/session-grant.ts)).

## Phase 2 — the three things a BOUNDED child has to survive

Run twice against the same clone; stages A and B produced identical verdicts on both passes.

**Stage A — the ceremony gives up and SIGKILLs the blocked child.** The dialog **survives its requester's death** (`modal STILL up after the requester died: YES`), the killed child is reaped (`REAPED`, shell reports `Killed: 9`, rc=137), and **a late Allow still lands the grant on the app**: the row moved to the current Terminal instance (`pid=1348 pidver=3370`) and the next sibling read clean (`{"label": "k2", … "ok": true, "elapsedSec": 0.008}`) with no second dialog. So a bounded wait that expires loses nothing but the wait — the human's answer still counts, and the next run witnesses it.

**Stage B — the human answers Don't Allow.** The requester gets `EPERM`:

```
{"label": "d1", … "ok": false, "errno": 1, "msg": "[Errno 1] Operation not permitted: …/main.sqlite", "elapsedSec": 11.765}
```

the row flips to `auth=0` pinned to that app instance (`client=com.apple.Terminal auth=0 pid=1516 pidver=3751`), and **every later attempt in that same app instance fails instantly and silently** — no second dialog, ever: `d2` 7 ms, `d3` (after a pause) 9 ms, both `errno 1`. The refusal is **not** durable across instances, though: the next Terminal launch was asked again (stage A of the second pass prompted normally with that `auth=0` row still on disk). Unlike Automation, a Don't Allow here costs the user a relaunch, not the machine.

**Stage C — does SIGTERM reap a child stalled in a TCC-held `open(2)`?** Yes: `REAPED-BY-SIGTERM`, `SIGTERM was enough`. The implementation still uses SIGKILL (nothing in that child needs to unwind), but a `execFileSync` default-signal timeout would also have worked.

## Rig notes (reusable)

- **Never measure this over ssh.** The golden grants FDA to `sshd-keygen-wrapper`, so every ssh-descended process reads the container without a dialog (cell c0) and masks the class entirely — the same trap SANDBOX1 recorded from the other side. The cells therefore run inside **Terminal.app**, launched with `open -a Terminal <file>.command` from the ssh session, which needs no Automation grant and puts a real responsible app at the top of the chain (and mirrors the maintainer's own host, where the responsible app is Ghostty).
- **The dialog belongs to `UserNotificationCenter`**, so a Things-scoped AX dump cannot see it. [`axsys.jxa`](../../lab/scripts/research-apdp1.sh) enumerates `NSWorkspace.runningApplications` and walks every process that has a window; `press Allow` AXPresses the first button with that exact title (falling back to a `CGEventPost` click at its frame). AXPress on the TCC dialog works under the AXVM1 grant — no synthetic-HID fallback was needed in any cell.
- **`defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false`** before the relaunch cells, so "a new app instance" does not silently mean "the old windows restored".
- The provoking process must be handed a **concrete** DB path: globbing the container directory is itself a gated operation, and would move the provocation to a different syscall.

## Consequence — shipped in the same change

`things setup`'s read leg now provokes the modal from a **bounded child** ([`src/direct-setup.ts`](../../src/direct-setup.ts) `openContainerDefault`): `execFileSync(process.execPath, ["-e", <one open(2)>, path], { timeout, killSignal: "SIGKILL" })`, 60 s by default and injectable. Three outcomes, all measured above:

- the child exits 0 → the grant is witnessed for the host app instance, exactly as before;
- the deadline passes → `ContainerOpenTimedOut`, and the leg reports **pending** with copy that sends the human back to the dialog that is still on screen (stage A: answering it later still works);
- the child fails → **pending**, naming the relaunch as the way to be asked again (stage B).

The doctrine's floor is unchanged: this is still the sub-FDA, dies-with-the-app tier, and direct mode still floors on FDA or the helpers ([permissions-doctrine.md](../design/permissions-doctrine.md) Article III).
