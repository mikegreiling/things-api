#!/usr/bin/env python3
"""VOPAT2 PR 2 — WHAT ONE MOVE COST, read back off the drive's own trace.

The next decision about `area reorder` — Mike's fold-all-then-one-drag ladder
(up-next, 2026-09-03) — has to be priced by MODEL at the field's constants,
because the lab is ~25x optimistic on exactly the term being compared. So the
drive emits a `sidebar-move-cost` record and this prints it, beside the
per-census and per-settle detail, and then prices the same move at the field's
MEASURED rates: 18.6 ms per AX round-trip (SBCHV1 §4) and 115 ms per row
realized (VOPAT1 §0).

The two field rates are not additive in general — the round-trip rate was
derived by dividing a sweep's wall time by its call count, and VOPAT1 showed the
realization term is what that division was actually measuring — so BOTH
estimates are printed and named, and the campaign doc quotes the row-realized
one as the estimate and the round-trip one as the pessimistic bound.

usage: vopat2pr2-trace.py <trace.jsonl>
"""
import json
import sys

FIELD_MS_PER_CALL = 18.6
FIELD_MS_PER_ROW_REALIZED = 115.0


def main(argv):
    try:
        records = [json.loads(line) for line in open(argv[0]) if line.strip()]
    except Exception as exc:  # noqa: BLE001 - the cell reports rather than raises
        print("    no trace: %s" % exc)
        return 0

    cost = None
    censuses = []
    settles = []
    dispatches = []
    for rec in records:
        phase = rec.get("phase")
        if phase == "sidebar-move-cost":
            cost = rec
        elif phase == "sidebar-census":
            censuses.append(rec)
        elif phase == "ui-settle":
            settles.append(rec)
        elif phase == "ui-dispatch" and rec.get("event") == "end":
            dispatches.append(rec)

    if censuses:
        print("    censuses:")
        for c in censuses:
            print(
                "      %-14s ok=%-5s esc=%-5s rows=%-4s realized=%-4s calls=%-5s areas=%-3s %sms%s"
                % (
                    c.get("source"),
                    c.get("ok"),
                    c.get("escalated"),
                    c.get("rows", "-"),
                    c.get("realized", "-"),
                    c.get("axCalls", "-"),
                    c.get("areasMapped", "-"),
                    c.get("durationMs", "-"),
                    "  miss=%s" % c.get("miss") if c.get("miss") else "",
                )
            )
    if settles:
        print("    settles:")
        for s in settles:
            print(
                "      %-38s ok=%-5s %s"
                % (
                    (s.get("what") or "")[:38],
                    s.get("ok"),
                    (
                        "lat=%sms fired=%s" % (s.get("latencyMs"), s.get("fired"))
                        if s.get("ok")
                        else "reason=%s waited=%sms seen=%s"
                        % (s.get("reason"), s.get("waitedMs"), s.get("seen"))
                    ),
                )
            )
    if dispatches:
        by_primitive = {}
        for d in dispatches:
            key = d.get("primitive")
            entry = by_primitive.setdefault(key, [0, 0])
            entry[0] += 1
            entry[1] += d.get("durationMs") or 0
        print(
            "    dispatches: %s"
            % ", ".join(
                "%s x%d (%dms)" % (k, v[0], v[1]) for k, v in sorted(by_primitive.items())
            )
        )

    if cost is None:
        print("    NO sidebar-move-cost record (the drive did not reach its epilogue)")
        return 0

    tally_calls = cost.get("axCalls") or 0
    tally_rows = cost.get("rowsRealized") or 0
    gestures = cost.get("gestures") or {}
    settle_tally = cost.get("settles") or {}
    print(
        "    MOVE COST  elapsed=%sms  censuses=%s (sparse %s / sweep %s, %s escalation(s))"
        % (
            cost.get("elapsedMs"),
            cost.get("censuses"),
            cost.get("sparse"),
            cost.get("sweeps"),
            cost.get("escalations"),
        )
    )
    print(
        "               round-trips=%d  rows realized=%d  rows=%s  sparse=%s  observer=%s"
        % (tally_calls, tally_rows, cost.get("rows"), cost.get("sparseEnabled"), cost.get("observer"))
    )
    print(
        "               gestures: drag=%s chevron=%s scroll=%s visibility=%s   settles: observed=%s missed=%s timer=%s"
        % (
            gestures.get("drag"),
            gestures.get("chevron"),
            gestures.get("scroll"),
            gestures.get("visibility"),
            settle_tally.get("observed"),
            settle_tally.get("missed"),
            settle_tally.get("timer"),
        )
    )
    per_census_calls = tally_calls / cost["censuses"] if cost.get("censuses") else 0
    per_census_rows = tally_rows / cost["censuses"] if cost.get("censuses") else 0
    print(
        "               per census: %.0f round-trips, %.1f rows realized"
        % (per_census_calls, per_census_rows)
    )
    print(
        "    FIELD PREDICTION (this move's own counts at the M1's measured rates)"
    )
    print(
        "               by rows realized (%.0f ms/row):   %.1f s of reads"
        % (FIELD_MS_PER_ROW_REALIZED, tally_rows * FIELD_MS_PER_ROW_REALIZED / 1000)
    )
    print(
        "               by round-trips  (%.1f ms/call):  %.1f s of reads  [pessimistic bound]"
        % (FIELD_MS_PER_CALL, tally_calls * FIELD_MS_PER_CALL / 1000)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
