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
  beep-marks.tsv             beep-sentinel marks, one per probe phase
  beeps.json                 the beep count for the whole run (host gates on it)

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
# The beep sentinel ships beside this file in the guest harness dir. A macOS
# alert beep during a suite is a FAILURE STATE (docs/lab/harness.md §The beep
# sentinel): the guest stamps a mark per probe phase and, at the end of the run,
# counts the beeps in the whole window with `log show`. The count is written to
# beeps.json and JUDGED HOST-SIDE, like every other verdict.
BEEP_SENTINEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "beep-sentinel.sh")
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


def beep_env(out_dir: str) -> dict:
    env = dict(os.environ)
    env["BEEP_MARKS"] = os.path.join(out_dir, "beep-marks.tsv")
    return env


def beep_sentinel(args: list, out_dir: str) -> int:
    """Drive the beep sentinel; never let its own failure abort a probe run."""
    if not os.path.exists(BEEP_SENTINEL):
        return 0
    try:
        r = subprocess.run(
            ["bash", BEEP_SENTINEL] + args,
            env=beep_env(out_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=180,
        )
    except Exception as e:  # noqa: BLE001 — the sentinel is never the thing that kills a run
        print(f"   beep-sentinel error: {type(e).__name__}: {e}", flush=True)
        return 2
    text = (r.stdout or b"").decode("utf-8", "replace").strip()
    if text:
        print(text, flush=True)
    return r.returncode


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


def wait_for_main_window(wait_seconds: float = 20.0) -> bool:
    """Block until Things has materialized its main window (a CLOSED LOOP, not a sleep).

    A background launch always ends with Things opening its main window, but HOW
    LONG that takes is a per-version property: measured 2026-08-22, Things 3.23
    takes ~3.5s from launch to `window-new "Today"`, where the old fixed 2.0s
    post-launch settle (+1.0s in enforce_app_state) returned at ~3.0s. The window
    therefore landed INSIDE the first probe's evidence window and flipped its
    disruption tier 0 -> 3 with a bare `window-new` and no launch/activate — the
    A10/R01 signature reported as a 3.23 behavior change in gv4-323-campaign.md
    §3.3. It is not a behavior change; it is a RACE, which is why it appeared on
    some runs and not others (RDLG2's a-suite run read tier 0).

    Waiting for the window itself rather than lengthening the sleep is the fix
    the determinism doctrine requires: no probe's tier can depend on how fast the
    host booted. `count windows` is a pure read; if the AppleEvent itself is what
    prompts the window on some future build, the loop still exits with the window
    materialized OUTSIDE the evidence window, which is the property we need.

    Best-effort: on timeout we fall through rather than fail the run — a tier
    assertion is the right place for that to surface, not a harness abort.
    """
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        r = subprocess.run(
            ["osascript", "-e", f'tell application "{THINGS_PROCESS}" to count windows'],
            capture_output=True,
            text=True,
        )
        count = r.stdout.strip()
        if r.returncode == 0 and count.isdigit() and int(count) >= 1:
            time.sleep(1.0)  # let the monitor record window-new before MARK start
            return True
        time.sleep(0.5)
    return False


def launch_things_background(wait_seconds: float = 30.0) -> None:
    subprocess.run(["open", "-g", "-a", THINGS_PROCESS], capture_output=True)
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if things_running():
            try:
                q("SELECT COUNT(*) FROM TMTask")
                time.sleep(2.0)  # post-launch settle: let startup maintenance finish
                wait_for_main_window()
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
        elif "shortcut" in cmd:
            # Apple Shortcuts vector: JSON input -> temp file -> `shortcuts run
            # <name> --input-path <in> --output-path <out>`. Placeholders in
            # string input values resolve like command strings. The output file
            # (falling back to process stdout) becomes the command's stdout so
            # stdoutMatches assertions see the proxy's result. The output file
            # is removed first — `shortcuts run` exits 0 even when Edit Items
            # silently no-ops (oddity 5k), so a stale file would alias a prior
            # run's output (scf harness lesson).
            name = cmd["shortcut"]
            resolved_input = {
                k: (resolver.resolve(v) if isinstance(v, str) else v)
                for k, v in cmd.get("input", {}).items()
            }
            in_path = os.path.expanduser("~/things-lab/run/shortcut-in.json")
            out_path = os.path.expanduser("~/things-lab/run/shortcut-out.txt")
            with open(in_path, "w") as f:
                json.dump(resolved_input, f)
            if os.path.exists(out_path):
                os.remove(out_path)
            result = run_argv(
                ["shortcuts", "run", name, "--input-path", in_path, "--output-path", out_path],
                timeout=float(cmd.get("timeoutSeconds", 40)),
            )
            try:
                with open(out_path) as f:
                    result["stdout"] = f.read()
            except OSError:
                pass  # no output file (empty result) — keep the process stdout
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
        # Beep marks bracket every phase, so a beep is attributed to the probe
        # AND the phase that produced it (setup noise is excluded from the DB
        # evidence window, but a beep in setup is still a beep).
        beep_sentinel(["mark", f"{probe_id} setup"], out_dir)
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
        beep_sentinel(["mark", f"{probe_id} commands"], out_dir)

        execute_commands(probe["commands"], resolver, record)
        time.sleep(float(probe.get("settleSeconds", 2)))

        emit_mark(probe_id, "end")
        record["endedAt"] = now_iso()

        pid_alive = things_running()
        expected_running = probe["appState"] != "not-running" or any(
            "openUrl" in c or "osascript" in c for c in probe["commands"]
        )
        pid_died = (not pid_alive) and expected_running and record["appRunningBefore"]
        new_ips = sorted(list_ips() - ips_before)
        if pid_died and not new_ips:
            # ReportCrash writes the .ips several seconds after process death;
            # wait for it — the crash log is bug-report evidence.
            deadline = time.time() + 25.0
            while time.time() < deadline and not new_ips:
                time.sleep(1.0)
                new_ips = sorted(list_ips() - ips_before)
        record["crash"] = {
            "pidDied": pid_died,
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

        beep_sentinel(["mark", f"{probe_id} cleanup"], out_dir)
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
    beep_sentinel(["reset"], args.out)
    beep_sentinel(["mark", "suite start"], args.out)

    resolver = Resolver(context)
    probes = suite["probes"]
    # Interactive probes (delete-class Shortcuts with no Always-Allow, oddities
    # 5j) re-prompt every run and cannot run unattended — skip them; the host
    # excludes them from evaluation and the green gate too (evaluate.activeProbes).
    for p in probes:
        if p.get("group", "normal") == "interactive":
            print(f"== {p['id']}: SKIPPED (interactive — needs a human sitting)", flush=True)
    runnable = [p for p in probes if p.get("group", "normal") != "interactive"]
    # Hazard probes (crash risk) are quarantined to the end, preserving order.
    ordered = [p for p in runnable if p.get("group", "normal") != "hazard"] + [
        p for p in runnable if p.get("group", "normal") == "hazard"
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

    # The beep window closes here and is counted in ONE `log show`. The verdict
    # is the host's (beeps.json → lab/runner/run.ts), so a beep never masks the
    # probe records; the guest only measures and attributes.
    beep_sentinel(
        ["assert", "--name", str(suite.get("suite", "suite")),
         "--json", os.path.join(args.out, "beeps.json")],
        args.out,
    )

    print(f"executed {len(ordered)} probes -> {exec_path}", flush=True)
    if not ok:
        print("some probes recorded guest errors (details in execution.ndjson)", flush=True)
    return 0  # verdicts are host-side; guest errors surface in the records


if __name__ == "__main__":
    sys.exit(main())
