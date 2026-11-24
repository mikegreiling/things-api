# UIFIX1 census tools

The read-only AX census behind [docs/lab/uifix1-repeat-bar-and-picker.md](../../../docs/lab/uifix1-repeat-bar-and-picker.md). Run on a DIRECT-arm golden clone (the AXVM1 grant lets the ssh shell read AX), never on a host.

Ship every file in this directory to the guest's home directory and the shipped CLI to `~/things-lab/` (as `lab/scripts/stage5-rc-run.sh` lays it out), then `bash ~/cen.sh`. `g.sh` is sourced by the others: it sets the two lab escapes, wraps the CLI as `things`, and adds read-only DB helpers.

- `cx.jxa` — dumps windows, content-table rows, or a menu-bar menu with its submenus.
- `bar.jxa` — finds the project header's `Repeat …` element. It can also press or click it.
- `pop.jxa` — presses or clicks one item of the open repeat popover.
- `clk.jxa` — clicks a content-table element or a popover item by its exact description.
- `lbl.sh` — samples the `Items ▸ Repeat` toggle's title by name.
- `hfix.sh` — seeds a synthetic project with two headings.
- `cen.sh` — the whole census pass.

The census presses nothing it does not dismiss. It does open the repeat popover, the heading's `…` popover and the Move… picker, and it pauses a series through the popover. All fixtures are synthetic.
