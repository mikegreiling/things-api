#!/usr/bin/env python3
"""VOPAT2 PR 2 — does the DATABASE's arithmetic predict the sidebar's ordinals?

VOPAT1 §8 R1 specified predicting every area row's ordinal from the database
alone: a fixed number of built-in rows, then per area (in `TMArea."index", uuid`
order) an optional spacer, the area's own row, and — unless the area is folded —
one row per project the app renders under it. The folded set is
`collapsedAreaUUIDs` in the group-container preferences (SBCOL1 §3).

This cell FITS the model's two build-dependent terms (`headerRows`,
`spacerPerSection`) against a real sweep and then reports whether the fitted
model reproduces the sweep's ordinals EXACTLY. A model that needs a different
fit per state, or that cannot reproduce the folded state because the preference
lags the live sidebar, is a model the driver must not depend on — which is the
question the campaign was told to answer plainly rather than hide behind the
full-sweep fallback.

usage: vopat2pr2-dbmodel.py <sweep.json> <db-areas.txt> <titles-pipe> <collapsed-uuids>
       db-areas.txt lines: <uuid>:<title>:<project-count>
"""
import json
import sys


def seg_match(text, title):
    segs = (text or "").split("|")
    return title in segs or (title + ".") in segs


def predict(header_rows, spacer_per_section, areas, collapsed):
    out, cursor = [], header_rows
    for uuid, _title, projects in areas:
        if spacer_per_section:
            cursor += 1
        out.append(cursor)
        cursor += 1
        if uuid not in collapsed:
            cursor += projects
    return out


def main(argv):
    snap = json.load(open(argv[0]))
    areas = []
    for line in open(argv[1]):
        line = line.strip()
        if not line:
            continue
        uuid, title, count = line.rsplit(":", 2)
        areas.append((uuid, title, int(count)))
    titles = [t for t in argv[2].split("|") if t]
    collapsed = set(t for t in (argv[3] if len(argv) > 3 else "").split() if t)

    rows = [r for r in snap.get("rows", []) if r.get("y") is not None]
    rows.sort(key=lambda r: r["y"])
    observed, want = [], 0
    for i, row in enumerate(rows):
        if want >= len(titles):
            break
        if seg_match(row.get("text", ""), titles[want]):
            observed.append(i)
            want += 1

    print("  rows=%d  areas=%d  collapsed=%d" % (len(rows), len(areas), len(collapsed)))
    print("  observed ordinals: %s" % observed)
    if len(observed) != len(areas):
        print("  CANNOT FIT: the sweep found %d of %d areas" % (len(observed), len(areas)))
        return 0

    best = None
    for spacer in (False, True):
        for header in range(0, 40):
            got = predict(header, spacer, areas, collapsed)
            hits = sum(1 for a, b in zip(got, observed) if a == b)
            if best is None or hits > best[0]:
                best = (hits, header, spacer, got)
    hits, header, spacer, got = best
    print(
        "  best fit: headerRows=%d spacerPerSection=%s -> %d/%d ordinals exact"
        % (header, spacer, hits, len(observed))
    )
    print("  predicted ordinals: %s" % got)
    if hits == len(observed):
        print("  VERDICT: the DB model reproduces the sidebar EXACTLY in this state")
    else:
        deltas = [b - a for a, b in zip(got, observed)]
        print("  VERDICT: MISMATCH — observed minus predicted = %s" % deltas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
