#!/usr/bin/env python3
"""Guest-side probe executor. Runs ON THE GUEST (macOS, stock Python 3.9).

Deliberately dumb: enforces app state, writes MARK sentinels into the
disruption monitor's events.ndjson, dumps raw table snapshots, executes
commands with SQL-poll waits, and records transport results + crash signals.
All judgment (DB diffing, disruption tiers, assertions, verdicts) happens
host-side in lab/runner/, where it is unit-tested.

Usage: python3 probe-runner.py --suite suite.json --context context.json --out ~/things-lab/run

Outputs under --out:
  execution.ndjson           one record per probe (see lab/runner/types.ts)
  snapshots/<id>-before.json raw keyed rows per table
  snapshots/<id>-after.json
  crash/<name>.ips           copies of new Things crash reports

Exit code: 0 if every probe executed (verdicts are computed host-side);
2 on harness-level failure (bad suite, DB unreadable, …).
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

THINGS_PROCESS = "Things3"
# MARK sentinels go to their own file, NOT the monitor's events.ndjson: the
# monitor's FileHandle keeps a private offset (no O_APPEND), so a second
# writer's lines get silently overwritten (observed: 13 of 44 marks survived).
# The host merges the two streams by timestamp at evaluation.
MARKS_PATH = os.path.expanduser("~/things-lab/run/marks.ndjson")
DIAG_DIR = os.path.expanduser("~/Library/Logs/DiagnosticReports")
SNAPSHOT_TABLES = [
    "TMTask",
    "TMArea",
    "TMTag",
    "TMTaskTag",
    "TMAreaTag",
    "TMChecklistItem",
    "TMTombstone",  # permanent deletes (area/tag/empty-trash) leave tombstones
]
TABLE_KEYS = {"TMTaskTag": ("tasks", "tags"), "TMAreaTag": ("areas", "tags")}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def locate_db() -> str:
    matches = glob.glob(
        os.path.expanduser(
            "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
            "ThingsData-*/Things Database.thingsdatabase/main.sqlite"
        )
    )
    if not matches:
        print("FATAL: Things database not found", file=sys.stderr)
        sys.exit(2)
    return matches[0]


DB = locate_db()


def q(sql: str, args: tuple = ()) -> list:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5.0)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def encode_cell(value):
    # BLOB columns (e.g. rt1_recurrenceRule plists) are not JSON-serializable;
    # the differ only needs equality, so hash them into a stable string.
    if isinstance(value, bytes):
        return "blob:sha256:" + hashlib.sha256(value).hexdigest()
    return value


def snapshot() -> dict:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    out: dict = {}
    try:
        for table in SNAPSHOT_TABLES:
            rows = {}
            for row in conn.execute(f"SELECT * FROM {table}"):
                d = {k: encode_cell(row[k]) for k in row.keys()}
                key_cols = TABLE_KEYS.get(table)
                if key_cols:
                    key = "|".join(str(d[c]) for c in key_cols)
                else:
                    key = str(d["uuid"])
                rows[key] = d
            out[table] = rows
    finally:
        conn.close()
    return out


def emit_mark(probe_id: str, phase: str) -> None:
    line = json.dumps({"ts": now_iso(), "kind": "mark", "detail": {"probe": probe_id, "phase": phase}})
    with open(MARKS_PATH, "a") as f:
        f.write(line + "\n")


def things_running() -> bool:
    r = subprocess.run(["pgrep", "-x", THINGS_PROCESS], capture_output=True)
    return r.returncode == 0


def kill_things(wait_seconds: float = 10.0) -> None:
    subprocess.run(["pkill", "-x", THINGS_PROCESS], capture_output=True)
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if not things_running():
            time.sleep(1.0)  # let the monitor observe the terminate + window-close
            return
        time.sleep(0.25)


def launch_things_background(wait_seconds: float = 30.0) -> None:
    subprocess.run(["open", "-g", "-a", THINGS_PROCESS], capture_output=True)
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if things_running():
            try:
                q("SELECT COUNT(*) FROM TMTask")
                time.sleep(2.0)  # post-launch settle: let startup maintenance finish
                return
            except sqlite3.Error:
                pass
        time.sleep(0.5)


def enforce_app_state(state: str) -> None:
    if state == "not-running":
        if things_running():
            kill_things()
    elif state in ("running-background", "modal-open"):
        # modal-open probes create their modal in setup; the base state is
        # "running with something else frontmost".
        if not things_running():
            launch_things_background()
        subprocess.run(["osascript", "-e", 'tell application "Finder" to activate'], capture_output=True)
        time.sleep(1.0)
    elif state == "frontmost":
        subprocess.run(["open", "-a", THINGS_PROCESS], capture_output=True)
        time.sleep(2.0)
    else:
        raise ValueError(f"unknown appState: {state}")


class Resolver:
    """Placeholder resolution: {ctx:KEY} {seed:NAME} {uuid:TITLE}."""

    PATTERN = re.compile(r"\{(ctx|seed|uuid):([^}]+)\}")

    def __init__(self, context: dict):
        self.ctx = context.get("ctx", {})
        self.seed = context.get("seed", {})

    def resolve(self, text: str) -> str:
        def sub(m: re.Match) -> str:
            kind, name = m.group(1), m.group(2)
            if kind == "ctx":
                if name not in self.ctx:
                    raise KeyError(f"context key not found: {name}")
                return str(self.ctx[name])
            if kind == "seed":
                if name not in self.seed:
                    raise KeyError(f"seed manifest entry not found: {name}")
                return str(self.seed[name]["uuid"])
            rows = q("SELECT uuid FROM TMTask WHERE title = ?", (name,))
            if len(rows) != 1:
                raise KeyError(f"{{uuid:{name}}}: {len(rows)} TMTask rows match")
            return str(rows[0][0])

        return self.PATTERN.sub(sub, text)


def run_argv(argv: list, timeout: float = 30.0) -> dict:
    started = time.time()
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        exit_code, stdout, stderr = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        exit_code = None
        stdout = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = "TIMEOUT"
    return {
        "resolved": " ".join(argv),
        "exitCode": exit_code,
        "stdout": stdout[:4000],
        "stderr": stderr[:4000],
        "durationMs": int((time.time() - started) * 1000),
    }


def execute_commands(commands: list, resolver: Resolver, record: dict) -> None:
    """Run a command list, appending transport/wait results to the record."""
    for cmd in commands:
        if "openUrl" in cmd:
            url = resolver.resolve(cmd["openUrl"])
            argv = ["open", url] if cmd.get("foreground") else ["open", "-g", url]
            record["commands"].append(run_argv(argv))
        elif "exec" in cmd:
            argv = [resolver.resolve(a) for a in cmd["exec"]]
            record["commands"].append(run_argv(argv))
        elif "osascript" in cmd:
            script = resolver.resolve(cmd["osascript"])
            result = run_argv(["osascript", "-e", script])
            record["commands"].append(result)
        elif "waitSql" in cmd:
            # Placeholders may reference rows the preceding command is still
            # creating ({uuid:TITLE} right after an `open`); resolve on every
            # poll iteration so "not there yet" is a retry, not a failure.
            timeout = cmd.get("timeoutSeconds", 10.0)
            started = time.time()
            satisfied = False
            sql = cmd["waitSql"]
            rows: list = []
            while time.time() - started < timeout:
                try:
                    sql = resolver.resolve(cmd["waitSql"])
                    rows = q(sql)
                except (KeyError, sqlite3.Error):
                    rows = []
                if rows:
                    satisfied = True
                    break
                time.sleep(0.25)
            record["waits"].append(
                {
                    "sql": sql,
                    "satisfied": satisfied,
                    "waitedMs": int((time.time() - started) * 1000),
                    "rows": [[encode_cell(v) for v in r] for r in rows[:5]],
                }
            )
        elif "waitCrash" in cmd:
            timeout = cmd.get("timeoutSeconds", 20.0)
            started = time.time()
            died = False
            while time.time() - started < timeout:
                if not things_running():
                    died = True
                    break
                time.sleep(0.25)
            record["waits"].append(
                {
                    "sql": "<waitCrash: Things3 process death>",
                    "satisfied": died,
                    "waitedMs": int((time.time() - started) * 1000),
                }
            )
        elif "sleep" in cmd:
            time.sleep(float(cmd["sleep"]))
        else:
            raise ValueError(f"unknown command: {json.dumps(cmd)}")


def list_ips() -> set:
    if not os.path.isdir(DIAG_DIR):
        return set()
    return {f for f in os.listdir(DIAG_DIR) if f.startswith("Things") and f.endswith(".ips")}


def run_probe(probe: dict, resolver: Resolver, out_dir: str) -> dict:
    probe_id = probe["id"]
    record: dict = {
        "probe": probe_id,
        "startedAt": None,
        "endedAt": None,
        "appState": probe["appState"],
        "appRunningBefore": False,
        "commands": [],
        "waits": [],
        "snapshotBefore": f"snapshots/{probe_id}-before.json",
        "snapshotAfter": f"snapshots/{probe_id}-after.json",
        "crash": {"pidDied": False, "ipsFiles": []},
        "errors": [],
    }

    try:
        # Setup runs OUTSIDE the evidence window (its noise is not the probe's).
        setup_record: dict = {"commands": [], "waits": []}
        execute_commands(probe.get("setup", []), resolver, setup_record)
        for wait in setup_record["waits"]:
            if not wait["satisfied"]:
                record["errors"].append(f"setup wait not satisfied: {wait['sql']}")
        for cmd in setup_record["commands"]:
            if cmd["exitCode"] != 0:
                record["errors"].append(f"setup command failed ({cmd['exitCode']}): {cmd['resolved']}")

        enforce_app_state(probe["appState"])
        record["appRunningBefore"] = things_running()
        ips_before = list_ips()

        before = snapshot()
        with open(os.path.join(out_dir, record["snapshotBefore"]), "w") as f:
            json.dump(before, f)

        record["startedAt"] = now_iso()
        emit_mark(probe_id, "start")

        execute_commands(probe["commands"], resolver, record)
        time.sleep(float(probe.get("settleSeconds", 2)))

        emit_mark(probe_id, "end")
        record["endedAt"] = now_iso()

        pid_alive = things_running()
        expected_running = probe["appState"] != "not-running" or any(
            "openUrl" in c or "osascript" in c for c in probe["commands"]
        )
        new_ips = sorted(list_ips() - ips_before)
        record["crash"] = {
            "pidDied": (not pid_alive) and expected_running and record["appRunningBefore"],
            "ipsFiles": new_ips,
        }
        for name in new_ips:
            try:
                src = os.path.join(DIAG_DIR, name)
                dst = os.path.join(out_dir, "crash", name)
                with open(src, "rb") as s, open(dst, "wb") as d:
                    d.write(s.read())
            except OSError as e:
                record["errors"].append(f"ips copy failed: {e}")

        after = snapshot()
        with open(os.path.join(out_dir, record["snapshotAfter"]), "w") as f:
            json.dump(after, f)

        cleanup_record: dict = {"commands": [], "waits": []}
        execute_commands(probe.get("cleanup", []), resolver, cleanup_record)
    except Exception as e:  # harness bug or guest surprise: record, keep going
        record["errors"].append(f"{type(e).__name__}: {e}")
        if record["startedAt"] and not record["endedAt"]:
            emit_mark(probe_id, "end")
            record["endedAt"] = now_iso()
    if not record["startedAt"]:
        record["startedAt"] = record["endedAt"] = now_iso()
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite")
    parser.add_argument("--context")
    parser.add_argument("--out", default=os.path.expanduser("~/things-lab/run"))
    parser.add_argument("--check-db", action="store_true", help="exit 0 if the DB is readable")
    parser.add_argument("--copy-db", metavar="DEST", help="write a consistent DB copy to DEST")
    args = parser.parse_args()

    if args.check_db:
        q("SELECT COUNT(*) FROM TMTask")
        print("db ok")
        return 0

    if args.copy_db:
        dest = os.path.expanduser(args.copy_db)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest):
            os.remove(dest)
        src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5.0)
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        print(dest)
        return 0

    if not args.suite or not args.context:
        parser.error("--suite and --context are required to execute probes")

    with open(args.suite) as f:
        suite = json.load(f)
    with open(args.context) as f:
        context = json.load(f)

    os.makedirs(os.path.join(args.out, "snapshots"), exist_ok=True)
    os.makedirs(os.path.join(args.out, "crash"), exist_ok=True)
    open(MARKS_PATH, "w").close()  # drop stale marks from any prior run

    resolver = Resolver(context)
    probes = suite["probes"]
    # Hazard probes (crash risk) are quarantined to the end, preserving order.
    ordered = [p for p in probes if p.get("group", "normal") != "hazard"] + [
        p for p in probes if p.get("group", "normal") == "hazard"
    ]

    exec_path = os.path.join(args.out, "execution.ndjson")
    ok = True
    with open(exec_path, "w") as exec_file:
        for probe in ordered:
            print(f"== {probe['id']}: {probe['title']}", flush=True)
            record = run_probe(probe, resolver, args.out)
            exec_file.write(json.dumps(record) + "\n")
            exec_file.flush()
            status = "ok" if not record["errors"] else f"ERRORS: {record['errors']}"
            print(f"   {status}", flush=True)
            if record["errors"]:
                ok = False

    print(f"executed {len(ordered)} probes -> {exec_path}", flush=True)
    if not ok:
        print("some probes recorded guest errors (details in execution.ndjson)", flush=True)
    return 0  # verdicts are host-side; guest errors surface in the records


if __name__ == "__main__":
    sys.exit(main())
