#!/usr/bin/env python3
"""SIMFID guest driver (runs ON a disposable Tart clone).

For each headless case in the manifest: seed a KNOWN pre-state through the guest
things-api CLI (the same binary users run — url-scheme / applescript vectors
against the REAL app), snapshot the DB, drive the op, snapshot again. Emits
`cases/<id>.before.json` and `cases/<id>.after.json` in the EXACT keyed-rows
shape lab/simfid/snapshot.ts produces on the host, so the host ingest
(lab/simfid/ingest-clone.ts) can diff + normalize them with the same normalizer
the sim side uses.

Snapshots are TITLE-SCOPED to each case's declared objects, so the golden
seed's rows never leak into a case delta (every case seeds fully-synthetic,
`SF `-prefixed objects). Usage:

  python3 guest-driver.py --node <node-bin> --app <app-dir> --manifest <json> --out <dir>
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

TASK_COLUMNS = [
    "type", "status", "stopDate", "trashed", "title", "notes", "start",
    "startDate", "startBucket", "reminderTime", "deadline", "index", "todayIndex",
    "area", "project", "heading", "checklistItemsCount", "openChecklistItemsCount",
    "rt1_repeatingTemplate", "rt1_recurrenceRule", "rt1_instanceCreationCount",
    "rt1_instanceCreationStartDate", "rt1_nextInstanceStartDate",
    "rt1_afterCompletionReferenceDate", "creationDate", "userModificationDate",
]


def db_path():
    pat = os.path.expanduser(
        "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
        "ThingsData-*/Things Database.thingsdatabase/main.sqlite"
    )
    hits = glob.glob(pat)
    if not hits:
        raise RuntimeError("Things DB not found")
    return hits[0]


def canon_cell(col, val):
    if val is None:
        return None
    if isinstance(val, bytes):
        # Headless cases carry no rule blobs; mark defensively (won't match a
        # host canon, so keep such cases out of the headless manifest).
        return "rule:present" if col == "rt1_recurrenceRule" else f"blob:{len(val)}"
    return val


def snapshot(titles):
    """Dump the SIMFID tables, scoped to rows whose title (or referenced
    task/area title) is in `titles`, in the host DbSnapshot shape."""
    con = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    t = set(titles)
    snap = {"TMTask": {}, "TMArea": {}, "TMTag": {}, "TMChecklistItem": {},
            "TMTaskTag": {}, "TMAreaTag": {}}

    cols = ", ".join(f'"{c}"' for c in TASK_COLUMNS)
    task_uuids = set()
    for r in con.execute(f'SELECT uuid, {cols} FROM TMTask'):
        if r["title"] not in t:
            continue
        task_uuids.add(r["uuid"])
        snap["TMTask"][r["uuid"]] = {c: canon_cell(c, r[c]) for c in TASK_COLUMNS}

    area_uuids = set()
    for r in con.execute('SELECT uuid, title, visible, "index" FROM TMArea'):
        if r["title"] not in t:
            continue
        area_uuids.add(r["uuid"])
        snap["TMArea"][r["uuid"]] = {"title": r["title"], "visible": r["visible"], "index": r["index"]}

    for r in con.execute('SELECT uuid, title, parent, shortcut, "index" FROM TMTag'):
        if r["title"] not in t:
            continue
        snap["TMTag"][r["uuid"]] = {"title": r["title"], "parent": r["parent"],
                                    "shortcut": r["shortcut"], "index": r["index"]}

    for r in con.execute('SELECT uuid, title, status, "index", task FROM TMChecklistItem'):
        if r["task"] not in task_uuids:
            continue
        snap["TMChecklistItem"][r["uuid"]] = {"title": r["title"], "status": r["status"],
                                              "index": r["index"], "task": r["task"]}

    for r in con.execute('SELECT tasks, tags FROM TMTaskTag'):
        if r["tasks"] in task_uuids:
            snap["TMTaskTag"][f'{r["tasks"]}|{r["tags"]}'] = {"tasks": r["tasks"], "tags": r["tags"]}

    for r in con.execute('SELECT areas, tags FROM TMAreaTag'):
        if r["areas"] in area_uuids:
            snap["TMAreaTag"][f'{r["areas"]}|{r["tags"]}'] = {"areas": r["areas"], "tags": r["tags"]}

    con.close()
    return snap


def run_cli(node, app, args, env):
    resolved = [substitute(a, env) for a in args]
    proc = subprocess.run([node, f"{app}/dist/cli/main.js", *resolved, "--json"],
                          capture_output=True, text=True)
    return proc.returncode, proc.stdout


def substitute(s, env):
    def repl(m):
        return env.get(m.group(1), m.group(0))
    return re.sub(r"\{([A-Za-z0-9_]+)\}", repl, s)


def uuid_from(stdout):
    try:
        return json.loads(stdout)["data"]["uuid"]
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    manifest = json.load(open(a.manifest))
    os.makedirs(os.path.join(a.out, "cases"), exist_ok=True)

    for case in manifest["cases"]:
        cid = case["id"]
        titles = case["titles"]
        env = {}
        ok = True
        for step in case.get("seed", []):
            code, out = run_cli(a.node, a.app, step["args"], env)
            if code != 0:
                print(f"[{cid}] seed step failed (exit {code}): {step['args']}", file=sys.stderr)
                ok = False
                break
            if "as" in step:
                u = uuid_from(out)
                if u is None:
                    print(f"[{cid}] could not capture uuid from: {step['args']}", file=sys.stderr)
                    ok = False
                    break
                env[step["as"]] = u
        if not ok:
            continue

        time.sleep(1)
        before = snapshot(titles)
        code, _ = run_cli(a.node, a.app, case["op"], env)
        time.sleep(2)
        after = snapshot(titles)

        json.dump(before, open(os.path.join(a.out, "cases", f"{cid}.before.json"), "w"))
        json.dump(after, open(os.path.join(a.out, "cases", f"{cid}.after.json"), "w"))
        print(f"[{cid}] op exit={code}  before={sum(len(v) for v in before.values())} rows"
              f"  after={sum(len(v) for v in after.values())} rows")


if __name__ == "__main__":
    main()
