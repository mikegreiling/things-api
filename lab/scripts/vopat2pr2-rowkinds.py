#!/usr/bin/env python3
"""VOPAT2 PR 2 — what the sidebar's rows ARE, and where the predictors would look.

Three jobs, one file because they all read the same row list:

  (default)          summarize a `rowkinds` dump: how many rows of each kind,
                     whether row heights really are constant per kind (the
                     property the geometry-only spacer classification rests on),
                     and whether every area row is a SECTION START (the property
                     the cheap candidate set rests on).
  --ordinals         print the area-row ordinals a sweep snapshot exposes, as
                     the driver's carried prediction would supply them.
  --sections-equal   compare two sweep snapshots' per-section row counts — the
                     "was the disclosure state restored?" check, on ordinals
                     rather than on the y-keyed pairs SBCHV1 had to use.

Reads only the rig's own JSON. No app, no database.
"""
import json
import sys


def load(path):
    with open(path) as fh:
        return json.load(fh)


def rows_of(snap):
    rows = [r for r in snap.get("rows", []) if r.get("y") is not None]
    rows.sort(key=lambda r: r["y"])
    return rows


def seg_match(text, title):
    segs = (text or "").split("|")
    return title in segs or (title + ".") in segs


def area_ordinals(rows, titles):
    """The ordinals carrying area titles, in database order (AXDRAG3)."""
    out, want = [], 0
    for i, row in enumerate(rows):
        if want >= len(titles):
            break
        if seg_match(row.get("text", ""), titles[want]):
            out.append(i)
            want += 1
    return out


def modal_height(rows):
    counts = {}
    for r in rows:
        counts[round(r["h"] * 2) / 2] = counts.get(round(r["h"] * 2) / 2, 0) + 1
    if not counts:
        return None
    return max(sorted(counts), key=lambda h: (counts[h], h))


def section_starts(rows, modal):
    out = []
    for i, r in enumerate(rows):
        if modal is not None and r["h"] < modal - 1:
            continue
        prev = rows[i - 1] if i else None
        if prev is None or (modal is not None and prev["h"] < modal - 1):
            out.append(i)
    return out


def sections(rows, ords):
    """Row count per section: area row → next area row, last → the bottom."""
    return [(ords[i + 1] if i + 1 < len(ords) else len(rows)) - o for i, o in enumerate(ords)]


def main(argv):
    if argv and argv[0] == "--ordinals":
        snap = load(argv[1])
        titles = [t for t in argv[2].split("|") if t]
        print(",".join(str(i) for i in area_ordinals(rows_of(snap), titles)))
        return 0

    if argv and argv[0] == "--sections-equal":
        a, b = load(argv[1]), load(argv[2])
        titles = [t for t in argv[3].split("|") if t]
        ra, rb = rows_of(a), rows_of(b)
        oa, ob = area_ordinals(ra, titles), area_ordinals(rb, titles)
        sa = dict(zip(titles, sections(ra, oa)))
        sb = dict(zip(titles, sections(rb, ob)))
        # An area that MOVED changes its own section's row count only if the
        # sidebar changed; compare the multiset so a reorder is not a failure.
        same = sorted(sa.values()) == sorted(sb.values()) and len(ra) == len(rb)
        print("YES" if same else "NO (%s -> %s, rows %d -> %d)" % (sa, sb, len(ra), len(rb)))
        return 0

    dump = load(argv[0])
    titles = [t for t in argv[1].split("|") if t]
    rows = dump.get("rows", [])
    rows.sort(key=lambda r: (r.get("y") if r.get("y") is not None else 0))
    kinds = {}
    heights = {}
    for r in rows:
        k = r.get("kind", "?")
        kinds[k] = kinds.get(k, 0) + 1
        heights.setdefault(k, set()).add(round(r.get("h") or 0, 1))
    print("  rows: %d" % len(rows))
    for k in sorted(kinds):
        hs = sorted(heights[k])
        print(
            "    %-8s %3d   height(s) %-22s %s"
            % (k, kinds[k], ",".join(str(h) for h in hs), "CONSTANT" if len(hs) == 1 else "VARIES")
        )
    modal = modal_height([r for r in rows if r.get("h")])
    starts = section_starts(rows, modal)
    ords = area_ordinals(rows, titles)
    missed = [o for o in ords if o not in starts]
    print("  modal (entity) row height: %s" % modal)
    print("  section starts (geometry): %d — %s" % (len(starts), starts[:24]))
    print("  area rows (sweep):         %d — %s" % (len(ords), ords))
    print(
        "  every area row IS a section start? %s%s"
        % ("YES" if not missed else "NO", "" if not missed else "  missed=%s" % missed)
    )
    print("  section row counts: %s" % dict(zip(titles, sections(rows, ords))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
