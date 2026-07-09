# L5 sitting — build cards

Step-by-step cards for the resumed L5 sitting ([golden-runbook §5](golden-runbook.md)): ~30–45 min of Mike driving the **golden** VM GUI. Everything here was pre-written so the sitting needs zero doc-spelunking. **Scheduling forcer: the golden's trial window closes ~2026-07-18 — if the sitting slips past it, the golden rebuild runbook comes first.**

State going in (from the 2026-07-03 sitting): §5.1 is DONE (Shortcuts first-run + Allow Running Scripts). All four proxies exist in **draft** state with picker-bound/static entity fields. The three mutation proxies need **restructuring to Find→act chains** — the Items/Project fields are app-entity parameters and never take raw string variables; only a `Find Items` action's output binds into them.

## Card 0 — boot + connect (host terminal, ~3 min)

```sh
source lab/scripts/env.sh          # sets TART_HOME
tart run things-lab-golden-v1 &    # windowed, or --no-graphics + Screen Sharing
IP=$(tart ip things-lab-golden-v1) # retry until it answers
```

- **Airgap + pin BEFORE any app launches**: `lab/scripts/vmssh` (or the runbook §1 alias) → `sudo route -n delete default; sudo systemsetup -setusingnetworktime off; sudo date 070512002026`.
- Connect: Screen Sharing → `vnc://$IP`, admin/admin (or use the Tart window).
- Sanity: Shortcuts → Settings → Advanced → **Allow Running Scripts** still checked.

## Card 1 — restructure `things-proxy-create-heading` (~8 min)

Input contract: `{"title": …, "project": …}`. Open the draft in the Shortcuts editor; target state, actions in order:

1. **Get Dictionary from** *Shortcut Input* (should already exist).
2. **Find Items** (Things): click *Show More* → **Type = Project**; filter **Name** *is* → insert the dictionary value for key `project` (Get Value for Key); **Limit 1**.
3. **Create Heading**: **Title** ← dictionary value for key `title`; **Project** ← step 2's output ("Items" magic variable) via the Gesture Appendix below — this is the field that must STOP being picker-bound.
4. Ensure the last action's result is the shortcut output (add **Stop and Output** if the editor demands an explicit one).

While the Find Items filter list is open: **note whether ID is offered as a filter field** (upgrades addressing from name to uuid in a v2). Don't switch to it this sitting — the staged S-suite addresses by name.

## Card 2 — restructure `things-proxy-edit-title` (~5 min)

Input contract: `{"find": …, "title": …}`.

1. **Get Dictionary from** *Shortcut Input*.
2. **Find Items**: **Name** *is* ← dictionary `find`, **Limit 1** (no Type filter — it must find headings too; if the filter UI *forces* a type, note what types exist — a Heading type here is itself a finding).
3. **Set Title of** ← step 2's output **to** ← dictionary `title`.
4. Output the result.

## Card 3 — restructure `things-proxy-delete-items` (~5 min)

Input contract: `{"find": …}`.

1. **Get Dictionary from** *Shortcut Input*.
2. **Find Items**: **Name** *is* ← dictionary `find`, **Limit 1**.
3. **Delete** ← step 2's output. **Leave any "immediately delete" toggle OFF** (Trash, not hard delete — but note the toggle's existence/wording: a Shortcuts hard-delete would close the permanent-delete wish-list gap).
4. Output the result.

## Card 4 — verify `things-proxy-find-items` (~2 min)

Built ✓ on 2026-07-03 (`{"search": …}` bound, no filters/sort). Just open it and confirm the binding survived; the S-campaign inspects its structured output for identifiers.

**Abort criterion (from §5.2):** if even Find-chained output refuses to bind into an entity field, stop restructuring — that finding means parameterized proxies are infeasible; headings stay UI-only, and the campaign shrinks to the read probe.

## Card 5 — action-catalog observation sweep (~5 min, high value)

With Shortcuts open anyway: add a scratch shortcut, insert each Things action once, expand *Show More*, and note (screenshots welcome — they land in session notes) the full parameter list of: **Add To-Do**, **Add Project**, **Edit** (whatever edit actions exist), **Create Heading**, **Find Items**, and anything unexpected. Specifically hunting: repeat parameters (documented absent — confirm), tags fields, reminder fields, attachment/convert/move actions, heading rename/move/delete verbs. Delete the scratch shortcut afterwards. This scopes the S-campaign beyond the four proxies.

## Card 6 — consent absorption (§5.3, scripted + Allow clicks, ~5 min)

Run each proxy once over SSH so macOS's per-shortcut consents fire; click **Allow** on each prompt in Screen Sharing. Driver: `lab/scripts/l5-consent-absorb.sh` (creates a sacrificial `L5-CONSENT-PROJ`, runs all four proxies against it, trashes it, exports signed `.shortcut` copies to `lab/shortcuts/`). Residue: one trashed project — recorded in metadata; probe assertions tolerate it.

## Card 7 — freeze (§5.4, scripted, ~3 min)

`lab/scripts/l5-freeze.sh`: quits Shortcuts + Things, verifies `shortcuts list` shows all four proxies, truncates `~/things-lab/events.ndjson`, reminds which `golden-v1-metadata.json` fields to update (`humanLayersDone` += L5, consent residue note), and stops the VM. Golden is never booted again — the S-campaign runs in clones.

## Gesture Appendix — binding a magic variable into an entity field (§5.2a)

First gesture that works, use everywhere:

1. Click the field → look at the very top of the popover, above the entity list (empty row = variable slot); scroll up for a "Select Variable" entry.
2. Right-click (ctrl-click) the blue field chip → "Select Variable" / "Insert Variable".
3. Click the Find Items action so its result token is visible, then drag the "Items" pill onto the entity field below.
