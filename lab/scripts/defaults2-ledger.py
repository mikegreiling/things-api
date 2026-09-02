#!/usr/bin/env python3
"""THE PRE-FILL LEDGER of one traced drive (DEFAULTS2).

What the verify-by-read hop CONFIRMED, what it MISSED, which setters were
therefore skipped, which setters ran anyway, and the drive's hop / round-trip /
element totals — the three numbers RDLAT2's cost law says must be reported
separately and never collapsed into one.

Reads a `THINGS_API_TRACE=1 THINGS_API_AX_COUNT=1` jsonl file; prints nothing
but a summary, so a cell can pipe it straight into the report.
"""
import json
import sys

SETTERS = {
    "select-popup", "set-group-number", "set-row-field", "set-value", "set-datetime",
    "ensure-checkbox", "converge-weekdays", "select-next-occurrence", "key",
}


def main(path: str) -> int:
    hops = ax = el = 0
    confirmed: list[str] = []
    missed: list[str] = []
    skipped: list[str] = []
    drove: list[str] = []
    settle: list[str] = []
    why = None
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        phase = rec.get("phase")
        if phase == "ui-dispatch" and rec.get("event") == "end":
            hops += 1
            ax += rec.get("axOps") or 0
            el += rec.get("axElems") or 0
            if rec.get("primitive") in SETTERS:
                drove.append("%s (%s)" % (rec.get("label"), rec.get("primitive")))
        elif phase == "ui-prefill":
            if rec.get("event") == "verify":
                confirmed = rec.get("confirmed") or []
                missed = rec.get("missed") or []
                why = rec.get("why")
            elif rec.get("event") == "skip":
                skipped.append("%s [%s]" % (rec.get("label"), rec.get("key")))
        elif phase == "ui-settle" and rec.get("skipped"):
            settle.append("%s: %s" % (rec.get("what"), rec.get("skipped")))
    print("hops=%d  ax-round-trips=%d  elements=%d" % (hops, ax, el))
    print("confirmed: %s" % (", ".join(confirmed) if confirmed else "(none)"))
    print("missed:    %s" % (", ".join(missed) if missed else "(none)"))
    if why is not None:
        print("verify why: %s" % why)
    print("skipped:   %s" % ("; ".join(skipped) if skipped else "(none)"))
    print("drove:     %s" % ("; ".join(drove) if drove else "(none)"))
    print("settles skipped: %s" % ("; ".join(settle) if settle else "(none)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
