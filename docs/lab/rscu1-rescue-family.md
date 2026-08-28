# RSCU1 — certifying `things rescue`: the headless way out of a wedged Things

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS 15.7.7 · dbv 27 · pinned clock **2026-07-05** (trial wall 2026-07-18, never rolled) · one disposable clone, the golden never booted · both lab escapes exported · beep sentinel default-on · production CLI built from the branch and shipped into the guest (`things 0.19.4`) · fixtures fully synthetic (`RSCU1-*`).

Occasioned by [#640](https://github.com/mikegreiling/things-api/issues/640). The surface under test is the three-verb `rescue` family: `status` (free, read-only), `dismiss` (two keys), `relaunch` (two keys, nuclear).

## 0. What was under test

A dialog left standing in Things takes the app's whole automation surface down with it, silently: top-level scripting collections read empty ([oddities §25](../things-app-oddities.md) / [MODALX1](modalx1-open-sheet-matrix.md)), Things Cloud sync is held ([§24](../things-app-oddities.md)), and one form of the dialog — the detached editor opened while the app is backgrounded — resisted every dismissal this project had ([§26](../things-app-oddities.md) / [DRVLAT1 §5](drvlat1-drive-latency.md)). `ui-state` reported all of it and acted on none of it; the remaining recourse was a screen-sharing session and a human hand.

Six cells, in the order they ran. **Zero beeps on every cell** (one on a discarded first pass — see §7).

---

## 1. `status` — the census, the lock, and the dialog we must not touch

Five screens, one command, and the standing requirement that it change nothing (sheet count asserted either side of every invocation).

| cell | screen | what `rescue status` reported |
| --- | --- | --- |
| S1 | nothing open | `no dialog is open in Things` · `stacked: 0` · lock: `no change is holding the lock` |
| S2 | one attached Repeat sheet | `repeat (attached; cb:2 pu:1 bt:2 gp:1 tf:0)` · `stacked: 1` · the sync-gate warning · `next: things rescue dismiss` — **sheets 1 before, 1 after** |
| S3 | a stacked PAIR | `an unrecognized dialog is open in Things (attached), on top of 1 more` · `other (attached; cb:0 pu:0 bt:2 gp:0 tf:0)` · `stacked: 2` · `next: … not one this command recognizes … run things rescue relaunch` |
| S4 | lock held, holder ALIVE, 20 minutes old | `pid 1671 has held it for 20m 1s — far longer than any change takes; that process may be hung, and killing it releases the lock` |
| S5 | the same lockfile, holder killed | `pid 1671 holds it but is no longer running — the next change takes it` |

Exit code **0** in every case, including the ones reporting a wedged machine: a wedged machine is a reported state, not a command failure.

**S3 is the one that took work to stage, and the staging is the finding.** MODALX1 §6 measured that nothing *inside* the app can raise a second sheet and that the URL scheme is the only path in — but only with `uriSchemeEnabled` **off**, so the app raises its own consent alert as a nested `AXSheet` child. That flip is read at **launch**: written under a running app with a sheet already standing it does nothing, and the first pass of this cell duly recorded a "stack" of one. The app must be quit, flipped, and restarted onto it (MODALX1's own `resetapp`), and the URL must carry the auth token. With that, `stacked: 2` reproduces reliably.

**The lock cells needed the same care about the rig rather than the product.** A holder backgrounded in one `lab_ssh` invocation and asked about in the next is reaped between them, and reads as dead in *both* halves — which is exactly what the first pass recorded. Both halves now run inside ONE ssh invocation that `wait`s on the holder it starts (harness law: nothing is ever orphaned), and the two states separate cleanly. The five-minute suspect threshold behaves as designed in both directions: the "may be hung" sentence appears for a 20-minute live holder and for no one else.

## 2. `dismiss` — proven Cancel, and the release it buys

The headline pairing, on one attached Repeat sheet, through the shipped CLI:

```
sheet standing:
  db says present:  1
  exists to do id:  true
  count to dos:     0            <- the emptied top-level collection (oddities §25)
  delete ->         30:72: execution error: Things3 got an error:
                    Can't get to do id "5ccs6EEvY3pcYKKbGeJhge". (-1728)
  row still there:  1            <- the delete did nothing

things rescue dismiss --dangerously-dismiss-dialog
  dismissed: the dialog was closed and no dialog is open in Things
  dialogs still open: 0          exit 0      sheets: 1 -> 0

sheet gone, the IDENTICAL call:
  count to dos:     30           <- the collection is back
  delete ->         (no error)
  row now trashed:  1            <- it landed
```

That is #620's "ghost clone" opened and closed inside one cell, with `rescue dismiss` as the thing that closes it. Nothing else in the run touched the deletee, and the seed carried no repeat rule either side (`rt1_recurrenceRule IS NULL` = 1 throughout).

**The other `dismiss` cells:**

| cell | result |
| --- | --- |
| nothing open | `no-dialog: … nothing was stranded and nothing was pressed` · exit **0** · no change-history record (a no-op is not an action) |
| no `--dangerously-dismiss-dialog` | `refused` · exit **4** · **sheets still 1** — the refusal pressed nothing |
| a stacked pair, top = the URL consent alert | `refused: the dialog in front is not one this command recognizes, and it will not press buttons on a dialog it cannot identify` · exit **4** · **sheets still 2** · names `rescue relaunch` |
| the same stack, then `rescue relaunch --yes` | cleared to **0** |

**An honest limit, worth stating plainly.** The one-level-at-a-time law (dismiss the top, re-census, report how many remain) is exercised by the code path and locked by unit test, but it could **not** be demonstrated live here — because the only second sheet the app can be made to stack is the URL consent alert, which the census identifies as `other`, and which `dismiss` therefore refuses by design. On this app, in this version, a real stack is a `relaunch` case. That is a conservative outcome rather than a gap: the alternative is pressing an unknown button on an unidentified dialog.

## 3. `wedge` — the screen that will not answer

System Events under `SIGSTOP` with a Repeat sheet standing (FGRD2's rig law), so every Accessibility read blocks until its own Apple-event budget expires.

```
rescue status:  nothing about the screen could be established — did not answer in
                time: whether Things is running
                unproven: … whether Things is running
                next: … if it keeps happening `things rescue relaunch` …

rescue dismiss: refused: the window state could not be established (did not answer
                in time: whether Things is running), so there is no way to know
                which dialog a Cancel would land on — nothing was pressed
                exit 4

elapsed for both, frozen:  4,313 ms
sheets after:              1      <- the refusal pressed nothing
thawed, same sheet:        dismissed, sheets 0
```

The refusal is the point: an unverifiable screen is not a screen to click on, and the command says which read failed rather than reporting a clean screen or clicking blind.

## 4. `relaunch` — the ladder, and both gates

| cell | result |
| --- | --- |
| no `--yes`, sheet standing | `refused` · exit **4** · pid unchanged (2257 → 2257) |
| `--yes` under `profile = workstation` | `refused: this machine is configured as a workstation, where someone may be sitting in front of the dialog this would destroy` · exit **4** · pid unchanged · names `--dangerously-force-quit` |
| `--yes` under `profile = dedicated-server` | `relaunched` · exit **0** · pid 2257 → 2522 · **sheets 0** · a write lands · schema reads as expected |

The ladder's own account, from the attached-sheet case:

```
before: Things is frontmost; the Repeat dialog is open (attached)
asked Things to quit — it did not answer
sent SIGTERM to pid 2257
the process ended
Things was started in the background
the database opened and reads as the shape this version expects
after: Finder is frontmost; no dialog is open in Things
```

## 5. The §26 cell — reproduce, fail honestly, cure

The detached editor staged exactly as DRVLAT1's `bgpress` path stages it: reveal without foregrounding, hand the screen to Finder, AXPress `Items ▸ Repeat…`. It materialised on the first attempt (`attached sheet = false`, `detached window = 1`), and the shipped census identified it correctly.

```
rescue status
  screen:   Finder is frontmost; the Repeat dialog is open (detached)
  dialog:   repeat (detached; cb:2 pu:1 bt:2 gp:1 tf:0)
  next:     `things rescue dismiss` closes the dialog in front …
  next:     this dialog is the detached kind, which has been measured to ignore
            every way of closing it — expect `things rescue dismiss` to report
            that it is still there, and use `things rescue relaunch`

rescue dismiss --dangerously-dismiss-dialog
  still-open: Cancel was pressed, both by the button and at its position on
              screen, and the dialog is still open — this is the detached kind
              of dialog, which has been measured to ignore every way of closing it
  note:       its Cancel button did not close it, so the button was clicked at
              its own position
  next:       `things rescue relaunch` ends Things and starts it again — it is
              the only thing measured to clear this
  exit 3      detached window still 1

(for the record, both historical rungs re-run against the same live dialog)
  Escape           -> still 1
  activate+Cancel  -> still 1

rescue relaunch --yes
  before: Things is frontmost; the Repeat dialog is open (detached)
  asked Things to quit
  it quit on its own
  Things was started in the background
  the database opened and reads as the shape this version expects
  after: Finder is frontmost; no dialog is open in Things
  exit 0      pid 2596 -> 2692      detached window 0      sheets 0
  a write lands: ok todo.add (verified)
```

Three things this establishes.

1. **`dismiss` fails honestly against §26.** It runs both rungs — the button's own `AXPress`, then a synthesized click at the button's AX-resolved frame — verifies by re-census rather than by the press's return value, and reports `still-open` with the reason and the remedy. It never claims a dismissal it cannot see, which is the property that matters: the press *reports success* against this dialog.
2. **`relaunch` cures it**, and is still the only thing that does. §26 stands unamended.
3. **New, and mildly surprising: the two dialog forms differ in whether they block the scripting `quit`.** With the **attached** sheet standing (§4), `tell application "Things3" to quit` did not answer and the ladder escalated to SIGTERM. Against the **detached** editor, the same call succeeded and the app quit on its own — no signal needed. So the detached editor, which resists every *dismissal*, does not resist a *quit*; and the attached sheet, which its own Cancel closes instantly, is the one that blocks the graceful path. That asymmetry is why the ladder has all of its rungs, and neither rung would have been enough alone.

## 6. What the change history recorded

`rescue.dismiss` and `rescue.relaunch` records were written for every action, carrying the census before and after (role counts and kinds only — never a control's value, never a window title, since a stranded Repeat sheet is displaying the user's own to-do text). `rescue status` wrote nothing, in every cell, because it changes nothing.

Rescue records are deliberately excluded from `undo`: a closed dialog cannot be reopened with what was typed into it, and a relaunched app cannot be un-relaunched.

## 7. Beeps

**0 on every cell as recorded above** (status, dismiss, wedge, relaunch, detached).

One beep appeared on a **discarded first pass** of the status cell, attributed by the sentinel to `Things3` inside a single coarse mark that covered the whole cell. It did not reproduce on the re-run with per-phase marks (7 marks, 0 beeps), and it fell inside the rig's own Escape-based stack teardown rather than inside any `rescue` invocation — no `rescue` verb in that cell presses anything at all. Recorded rather than explained away; MODALX1 §7's discriminator (a keyboard chord sent through System Events to a sheet-blocked app beeps, and nothing else does) is consistent with a teardown Escape into the stacked consent alert.

## 8. Rig lessons (both cost a pass)

1. **`$?` after a pipe is the pipe's status, not the command's.** The first pass recorded `dismiss_exit=0` for a refusal that genuinely exits 4, because the exit code was read after `| tail -8`. The repo already has this rule for `npm run check`; it applies to every guest CLI invocation too. The driver now captures before it pipes (`clirc`), and the exit codes were separately re-verified in a bare guest script: `status` 0 · `dismiss` (no flag) **4** · `dismiss` (nothing open) 0 · `relaunch` (no `--yes`) **4**.
2. **A per-cell beep mark cannot attribute a beep.** One mark covering a two-minute cell tells you a beep happened somewhere in it. Per-phase marks are cheap (`mark` is one `date` call) and are what turn "1 beep, cause unknown" into an attributable line or, as here, a clean re-run.

## 9. What this campaign does NOT establish

- **Nothing about the maintainer's own Mac.** Every measurement is a clone with the AXVM1 grant and the lab escapes; the deputy transport, a real display session and a large actively-syncing database are all absent. The refusals and the ladder are structural and should carry, but the on-device confirmation is a separate step.
- **Not the sync-gate release.** `relaunch` reports that Things sends changes again once no dialog is standing, on the strength of the field-measured [oddities §24](../things-app-oddities.md). This clone has no Things Cloud account (`BSSyncronyMetadata` holds 0 rows until one is attached — MODALX1 §9), so the release itself was **not** observed here and nothing in this document should be read as if it were.
- **Not a real multi-level dismissal.** See §2: the only stackable second sheet is one `dismiss` refuses by design.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh setup
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh ship
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh status
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh dismiss
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh wedge
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh relaunch
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh detached
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-rscu1.sh teardown
```
