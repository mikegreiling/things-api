#!/usr/bin/env python3
"""THE QUADRANT LEDGER of one traced drive (DEFAULTS3).

A drive's OPTIONAL MACHINERY is what this campaign is about, so the ledger's
first job is to prove WHICH QUADRANT the drive actually ran in — never to trust
the environment the cell believes it set:

  observer  armed / unavailable (with the reason), from `phase:"ui-observer"`
  prefill   the verify-by-read hop's own record, from `phase:"ui-prefill"`

and then the two things the DEFAULTS3 defect lived between: the dialog-shape
probe's verdict, and the hop trail with each hop's wall time and the number of
controls whose content it realized.

Reads a `THINGS_API_TRACE=1` jsonl file. Prints a summary only, so a cell can
pipe it straight into the report.
"""
import json
import sys


def main(path: str) -> int:
    observer = "(not armed — this recipe has no settle to serve)"
    prefill = "(no verify hop — reliance off, or nothing nominated)"
    shape = "(no probe)"
    hops: list[str] = []
    failed = None
    elems = 0
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        phase = rec.get("phase")
        if phase == "ui-observer":
            ev = rec.get("event")
            why = rec.get("why")
            observer = ev if why is None else "%s (%s)" % (ev, why)
        elif phase == "ui-prefill" and rec.get("event") == "verify":
            prefill = "confirmed=[%s] missed=[%s]%s" % (
                ",".join(rec.get("confirmed") or []),
                ",".join(rec.get("missed") or []),
                "" if rec.get("why") is None else " why=%s" % rec.get("why"),
            )
        elif phase == "dialog-shape" and rec.get("event") == "probe":
            shape = "%s (axElems=%s)" % (rec.get("shape"), rec.get("axElems"))
        elif phase == "ui-dispatch" and rec.get("event") == "end":
            el = rec.get("axElems") or 0
            elems += el
            hops.append(
                "%s %sms%s%s"
                % (
                    rec.get("primitive"),
                    rec.get("durationMs"),
                    "" if el == 0 else "/e%d" % el,
                    "" if rec.get("ok", True) else " !FAILED",
                )
            )
            if rec.get("ok") is False:
                failed = "%s (%s)" % (rec.get("label"), rec.get("primitive"))
    print("observer: %s" % observer)
    print("prefill:  %s" % prefill)
    print("shape:    %s" % shape)
    print("hops(%d, %d elements): %s" % (len(hops), elems, " -> ".join(hops)))
    if failed is not None:
        print("FAILED AT: %s — the refusal text is in the drive log" % failed)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
