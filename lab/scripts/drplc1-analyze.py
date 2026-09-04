#!/usr/bin/env python3
"""DRPLC1 — read the mid-drag censuses and say which layout law the build obeys.

    drplc1-analyze.py census <census.json>
    drplc1-analyze.py lift   <liftread.json | liftmove.json>
    drplc1-analyze.py shippedaim <census.json> <source-area>

COLLAPSE law (AXDRAG1-a, measured on 3.22.11): lifting the source removes its
whole group from the table, and every row below shifts UP by the group span.
PLACEHOLDER law: the slot stays open — rows below keep their pre-drag y, so the
static drop-Y correction in planDrop() over-corrects by exactly one span.
"""

import json
import sys


def load(path):
    with open(path) as fh:
        return json.load(fh)


def show_census(c, label=""):
    if not c.get("ok"):
        print("  %scensus FAILED: %s" % (label, c.get("why")))
        return
    vp = c["viewport"]
    print(
        "  %sviewport y=%.0f h=%.0f  scroll=%s  rows=%d  bottom=%.1f"
        % (label, vp["y"], vp["h"], c.get("scroll"), c["count"], c["bottom"] or -1)
    )


def areas(c):
    return [r for r in c["rows"] if r.get("area")]


def cmd_census(path):
    c = load(path)
    show_census(c)
    if not c.get("ok"):
        return
    ar = areas(c)
    print("  area rows (%d):" % len(ar))
    prev = None
    for r in ar:
        pitch = "" if prev is None else "  pitch=%.1f" % (r["y"] - prev)
        print("    %-16s y=%7.1f h=%4.1f%s" % (r["area"], r["y"], r["h"], pitch))
        prev = r["y"]
    tail = c["rows"][-3:]
    print("  last 3 table rows:")
    for r in tail:
        print(
            "    y=%7.1f h=%4.1f area=%-16s text=%r"
            % (r["y"], r["h"], r["area"], r["text"][:32])
        )


def index_by_area(c):
    return {r["area"]: r for r in c["rows"] if r.get("area")}


def cmd_lift(path):
    d = load(path)
    if not d.get("ok"):
        print("  lift FAILED: %s" % d.get("why"))
        return
    before, after = d["before"], d["after"]
    print("  source=%s grab=(%d,%d)" % (d["source"], d["grab"]["x"], d["grab"]["y"]))
    show_census(before, "before: ")
    for i, m in enumerate(d["mid"]):
        show_census(m, "mid[%d]: " % i)
    show_census(after, "after:  ")
    if not before.get("ok"):
        return

    ba = index_by_area(before)
    src = ba.get(d["source"])
    if src is None:
        print("  source row absent from the before-census — cannot compute")
        return
    # The group span the driver would compute: next area row's top - source top.
    ordered = areas(before)
    span = None
    for i, r in enumerate(ordered):
        if r["area"] == d["source"] and i + 1 < len(ordered):
            span = ordered[i + 1]["y"] - r["y"]
            break
    print("  source y=%.1f h=%.1f  computed group span=%s" % (src["y"], src["h"], span))

    for i, m in enumerate(d["mid"]):
        if not m.get("ok"):
            continue
        ma = index_by_area(m)
        print("  --- mid[%d]: rows %d -> %d (delta %+d), bottom %.1f -> %.1f (%+.1f)"
              % (i, before["count"], m["count"], m["count"] - before["count"],
                 before["bottom"] or 0, m["bottom"] or 0,
                 (m["bottom"] or 0) - (before["bottom"] or 0)))
        print("      source row present mid-drag: %s" % ("YES" if d["source"] in ma else "no"))
        shifts = []
        for r in ordered:
            if r["area"] == d["source"]:
                continue
            live = ma.get(r["area"])
            if live is None:
                print("      %-16s static y=%7.1f  -> ABSENT mid-drag" % (r["area"], r["y"]))
                continue
            dy = live["y"] - r["y"]
            below = r["y"] > src["y"]
            if below:
                shifts.append(dy)
            print("      %-16s static y=%7.1f live y=%7.1f  dy=%+7.1f %s"
                  % (r["area"], r["y"], live["y"], dy, "(below source)" if below else ""))
        if shifts:
            lo, hi = min(shifts), max(shifts)
            mean = sum(shifts) / len(shifts)
            print("      rows BELOW the source: dy min=%+.1f max=%+.1f mean=%+.1f (n=%d)"
                  % (lo, hi, mean, len(shifts)))
            verdict = "INDETERMINATE"
            if span:
                # A row below the source sits at `static - span + gap`, where
                # `gap` is whatever the app left in the lifted group's place.
                # gap == 0 is the old collapse law; gap == span is a full
                # placeholder; anything between is a landing gap of that size.
                gap = mean + span
                if abs(gap) <= 4:
                    verdict = "COLLAPSE (rows shifted up by ~one group span; gap %.0f pt)" % gap
                elif abs(gap - span) <= 4:
                    verdict = "PLACEHOLDER (the slot stayed open — rows did NOT move)"
                else:
                    verdict = (
                        "LANDING GAP of ~%.0f pt replaces the %.0f pt group "
                        "(rows below shift %+.0f, not %+.0f)" % (gap, span, mean, -span)
                    )
                print("      derived landing gap: %.1f pt (span %.1f, shift %+.1f)"
                      % (gap, span, mean))
            print("      LAW: %s" % verdict)
        # What the shipped planner would aim at, vs the live truth.
        st_bottom = before["bottom"] or 0
        live_bottom = m["bottom"] or 0
        if span:
            static_aim = st_bottom + 4 - span   # boundaryBelowLast()-ish, minus the span
            print("      to-last: static-corrected aim=%.1f vs LIVE table bottom=%.1f "
                  "(live-vs-static delta %+.1f)" % (static_aim, live_bottom, live_bottom - static_aim))
            last_live = None
            for r in areas(m):
                if last_live is None or r["y"] > last_live["y"]:
                    last_live = r
            if last_live:
                mid_of_last = last_live["y"] + last_live["h"] / 2
                where = ("ABOVE the last area row" if static_aim < last_live["y"]
                         else "the TOP half of the last area row -> inserts ABOVE it"
                         if static_aim < mid_of_last
                         else "the BOTTOM half of the last area row -> inserts BELOW it"
                         if static_aim < last_live["y"] + last_live["h"]
                         else "BELOW the last area row -> to-last")
                print("      last area row live y=%.1f h=%.1f; the static aim lands in %s"
                      % (last_live["y"], last_live["h"], where))


def cmd_shippedaim(path, source):
    """The PRE-DRPLC1 driver's to-last aim, in its own arithmetic.

    boundaryBelowLast(rows) - sourceGroupSpan(source), i.e. the trailing spacer's
    centre (or the last row's bottom plus half a median spacer) minus the source
    group's span. Prints "none" when the source row is outside the visible band,
    where the shipped driver would have pre-scrolled first.
    """
    c = load(path)
    if not c.get("ok"):
        print("none")
        return
    rows = sorted(c["rows"], key=lambda r: r["y"])
    ar = areas(c)
    src = next((r for r in ar if r["area"] == source), None)
    if src is None or not rows:
        print("none")
        return
    vp = c["viewport"]
    if not (vp["y"] + 6 <= src["y"] + src["h"] / 2 <= vp["y"] + vp["h"] - 6):
        print("none")
        return
    modal = max(set(r["h"] for r in rows), key=lambda h: [r["h"] for r in rows].count(h))
    spacers = sorted(r["h"] for r in rows if r["h"] < modal - 1)
    last = rows[-1]
    if last["h"] < modal - 1:
        boundary = last["y"] + last["h"] / 2
    else:
        med = spacers[len(spacers) // 2] if spacers else last["h"] / 2
        boundary = last["y"] + last["h"] + med / 2
    # sourceGroupSpan: next area row's top - source row's top (pitch fallback)
    idx = [r["area"] for r in ar].index(source)
    if idx + 1 < len(ar):
        span = ar[idx + 1]["y"] - src["y"]
    else:
        deltas = sorted(ar[i + 1]["y"] - ar[i]["y"] for i in range(len(ar) - 1))
        span = deltas[len(deltas) // 2] if deltas else modal
    print(int(round(boundary - span)))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    verb, path = sys.argv[1], sys.argv[2]
    if verb == "census":
        cmd_census(path)
    elif verb == "lift":
        cmd_lift(path)
    elif verb == "shippedaim":
        cmd_shippedaim(path, sys.argv[3])
    else:
        print("unknown verb %s" % verb)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
