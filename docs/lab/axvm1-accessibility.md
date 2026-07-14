# AXVM1 — Accessibility IS usable in Tart guests (the "SIP-blocked" claim, falsified)

**Verdict (2026-07-14):** the standing claim that Accessibility is *SIP-blocked / unusable in VMs* is **FALSE**. Accessibility UI-scripting via System Events works in a stock Tart guest, **with SIP still enabled**, after a one-time **user-path TCC grant** (the System Settings toggle, which drives `tccd` — not a direct DB write). This makes the **ui-vector lab-certifiable**: AX element-addressing-by-name is a real, regression-testable driving path alongside the VNC-coordinate path, and it is strictly *less* disruptive (see below).

Run: [`lab/scripts/research-axvm1.sh`](../../lab/scripts/research-axvm1.sh). ONE `--vnc-experimental` clone `things-run-axvm1-20260714-093254` (airgapped, clock-pinned 2026-07-05, Things 3.22.11 / macOS 15.7.7 / DB v26), driven adaptively. Discovery — no assertions; ground truth = the guest TCC.db rows + the Things DB deltas, corroborated by the screenshot sequence (`11`–`13`, `20-locked.png`) under the run's artifacts dir (gitignored).

## Where the original claim went wrong

Two true facts were conflated into one false conclusion:

1. **The golden has Accessibility NEVER GRANTED.** There is no `kTCCServiceAccessibility` row at all in a fresh clone, so a real AX op errors `-1719`. That is "not granted", **not** "cannot be granted".
2. **SX4's "readonly database" was a *direct-write* result.** A raw `INSERT` into the SYSTEM `TCC.db` (`/Library/Application Support/com.apple.TCC/TCC.db`) fails `attempt to write a readonly database (8)` because SIP protects that file. Reconfirmed here. But the **user-path grant does not write the file directly** — System Settings asks the privileged `tccd` daemon to do it, which SIP permits. That path was never tried.

A third trap seeded the confusion: **`tell application "System Events" to get name of first process` is NOT gated by Accessibility.** Process *enumeration* is a light operation and returns `exit 0` even with no grant. The real gate fires only on **UI-element access**:

```
tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1
→ "System Events got an error: osascript is not allowed assistive access. (-1719)"
```

Use a UI-element op (menu-bar / window read) as the discriminator, never `get name of first process`.

## The grant ladder (stopped at the first success — rung b)

| Rung | What | Result |
|---|---|---|
| **AXVM1-a** inventory | `csrutil status`; SYSTEM+USER `TCC.db` rows; the baseline failure; responsible-process identity | SIP **enabled**. No AX rows at start. `PostEvent` is granted to `com.apple.screensharing.agent` (`auth_value=2`) — that is *why VNC synthetic HID already works*. The `-1719` error names **osascript** as the client, and the denied attempt **auto-creates a disabled row** `kTCCServiceAccessibility \| /usr/libexec/sshd-keygen-wrapper \| 1 \| 0` — i.e. the SSH-issued-osascript responsible process is the **sshd-keygen-wrapper**, and TCC pre-populates a **toggleable** list entry (no file-picker needed). |
| **AXVM1-b** user-path grant (VNC) | Open the Accessibility pane by URL (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`); flip the lone `sshd-keygen-wrapper` toggle; authenticate `admin`/`admin` at the *"Privacy & Security is trying to modify your system settings"* sheet | **WORKS.** `auth_value` flips **0 → 2**. Re-probing the real AX op over SSH now returns `Apple, Things, File, Edit, View, Items, Window, Help` and window title `Today`, both `exit 0`. **SIP stayed enabled the whole time.** |
| **AXVM1-c** direct seeding | Direct SYSTEM-`TCC.db` `INSERT` | Reconfirmed **read-only under SIP** (SX4). Not needed — (b) succeeded. The recoveryOS escalation (`tart run --recovery` → `csrutil disable` → `INSERT kTCCServiceAccessibility` with `auth_value=2,auth_reason=4,csreq=NULL` → reboot) is the documented fallback had (b) failed; **not exercised**. |
| **AXVM1-d** payoff smoke | See next section | **PASSES** (foreground, background, and under-lock). |
| **AXVM1-e** persistence | Reboot the guest, re-check | **Grant PERSISTS.** `auth_value=2` survived the reboot; AX over SSH works post-reboot. → bakeable into a golden v2 layer. |

## AXVM1-d — the payoff smoke (System Events, by NAME, over SSH)

Things' **list rows are NOT AX-addressable by title** (sparse custom rendering — `entire contents of row` comes back empty; this is exactly why UI2 used VNC coordinate clicks). But the **menu bar is fully AX-exposed**. So the working recipe selects the target with a **stable handle** (`things:///show?id=<uuid>` — verified by `Things3 → get name of selected to dos`) and then drives the **contextual menu by name**, zero coordinates:

```
open "things:///show?id=W3PZB9e7W6BEtKmEKP4deG"   # select LAB-REPEAT-DAILY template
osascript -e 'tell application "System Events" to tell process "Things3" \
  to click menu item "Pause" of menu 1 of menu item "Repeat" \
  of menu "Items" of menu bar item "Items" of menu bar 1'
```

Result: `rt1_instanceCreationPaused` **0 → 1** and `rt1_nextInstanceStartDate` cleared — identical semantics to UI2-c, but achieved via AX over SSH instead of VNC clicks. The `Items ▸ Repeat` submenu enumerates as **`Reschedule…`, `Pause`↔`Resume`, `Show Latest`** (matches UI2-c's *menu-surface* set — the Stop action UI2-i later found lives only in the open-card repeat-bar popover, not this menu; the submenu only materializes when a repeating item is selected).

- **BACKGROUND question — YES, and with NO focus steal.** With **Finder** activated frontmost (Things in the background), the AX press still flipped `paused` 0 → 1 **and frontmost stayed Finder**. AX menu-item pressing needs neither the app frontmost nor a coordinate, and does **not** raise the target. This is the decisive contrast with UI2-e, where *every* VNC drive path ends with Things frontmost + window visible (focus steal).
- **LOCK question — YES.** Under a genuine `sysadminctl -screenLock immediate` + `SACLockScreenImmediate` lock (lock screen captured in `20-locked.png`: *"Managed via Tart" / "Enter Password"*), the AX press **still worked** (`paused` 0 → 1). Contrast LOCK1 arm (f): a VNC coordinate click under lock hits the **lock screen**, never reaching Things. **This resolves the LOCK1 "AX-under-lock is unprobeable" open question** — it is probeable, and it works.

## What this changes for the ui-vector

The ui-vector now has **two** driving paths, and the AX path dominates for a headless host:

| | VNC synthetic HID (UI1/UI2) | **System Events AX (this campaign)** |
|---|---|---|
| Grant needed | none (PostEvent already granted) | one-time user-path Accessibility toggle (persists) |
| Addressing | absolute screen **coordinates** (re-read per resolution) | element **names** / stable handles |
| App must be frontmost | **yes** (menu bar belongs to frontmost app) | **no** |
| Focus steal | **yes** (most-disruptive tier) | **no** — target app stays in background |
| Works under lock | **no** (hits lock screen) | **yes** |
| List-row selection | works (coordinate click) | not by name (rows aren't AX-exposed) → use `things:///show?id=` |

Net: on a dedicated headless Mac the AX path is **lower-disruption** than VNC and **lock-tolerant** — the ui-vector is lab-certifiable per Things version by the VM harness. Row selection still needs the URL-scheme handle (or a coordinate click) because Things doesn't expose list rows to AX; the menu/transform half is pure by-name AX.

## Golden v2 layer (optional — recipe, not executed)

The grant persists across reboot, so it can be baked into a future golden. See the optional layer added to [golden-runbook.md](golden-runbook.md) ("L3-accessibility"). **Not built** — the current golden is unchanged; this campaign ran entirely in a disposable clone.
