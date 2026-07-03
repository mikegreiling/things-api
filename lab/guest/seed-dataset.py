#!/usr/bin/env python3
"""Seed the golden image's canonical Things dataset. Runs ON THE GUEST.

Every mutation is verified by SQLite read-back (write -> verify doctrine).
Creation vectors: URL scheme (validated) + the two officially-documented
AppleScript creation commands (areas/tags — URL scheme cannot create them),
each verified, doubling as early evidence for probes A03/A04/A24.

Usage: python3 seed-dataset.py <auth-token>
Output: ~/things-lab/seed-manifest.json  (name -> {uuid, role})
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.parse

TOKEN = sys.argv[1]
DB = glob.glob(
    os.path.expanduser(
        "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
        "ThingsData-*/Things Database.thingsdatabase/main.sqlite"
    )
)[0]
MANIFEST: dict[str, dict] = {}
FAILURES: list[str] = []


def q(sql: str, args: tuple = ()) -> list[tuple]:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def open_url(url: str) -> None:
    subprocess.run(["open", "-g", url], check=True)


def osa(script: str) -> str:
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"osascript failed: {r.stderr.strip()}")
    return r.stdout.strip()


def wait_for(sql: str, args: tuple, desc: str, timeout: float = 10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = q(sql, args)
        if rows:
            return rows
        time.sleep(0.25)
    FAILURES.append(f"TIMEOUT waiting for: {desc}")
    return []


def record(name: str, role: str, uuid: str | None):
    MANIFEST[name] = {"uuid": uuid, "role": role}
    status = "ok" if uuid else "FAIL"
    print(f"  [{status}] {name} ({role}) -> {uuid}")


def task_uuid(title: str, role: str, extra_check: str = "1=1") -> str | None:
    rows = wait_for(
        f"SELECT uuid FROM TMTask WHERE title = ? AND {extra_check}", (title,), title
    )
    uuid = rows[0][0] if rows else None
    record(title, role, uuid)
    return uuid


def add(title: str, role: str, params: dict | None = None, check: str = "1=1"):
    qs = urllib.parse.urlencode({"title": title, **(params or {})}, quote_via=urllib.parse.quote)
    open_url(f"things:///add?{qs}")
    return task_uuid(title, role, check)


def update(uuid: str, desc: str, params: dict, check_sql: str):
    qs = urllib.parse.urlencode(
        {"id": uuid, "auth-token": TOKEN, **params}, quote_via=urllib.parse.quote
    )
    open_url(f"things:///update?{qs}")
    if not wait_for(check_sql, (uuid,), f"update {desc}"):
        return
    print(f"  [ok] update {desc}")


print("== AppleScript layer: areas + tag taxonomy (probes A03/A04 evidence) ==")
for area in ("LAB-AREA-A", "LAB-AREA-B"):
    osa(f'tell application "Things3" to make new area with properties {{name:"{area}"}}')
    rows = wait_for("SELECT uuid FROM TMArea WHERE title = ?", (area,), area)
    record(area, "area (created via AppleScript)", rows[0][0] if rows else None)

for tag, parent in [("lab-tag-1", None), ("lab-tag-2", None), ("prio", None), ("high", "prio"), ("low", "prio")]:
    osa(f'tell application "Things3" to make new tag with properties {{name:"{tag}"}}')
    rows = wait_for("SELECT uuid, parent FROM TMTag WHERE title = ?", (tag,), tag)
    uuid = rows[0][0] if rows else None
    if uuid and parent:
        osa(
            f'tell application "Things3" to set parent tag of tag "{tag}" to tag "{parent}"'
        )
        wait_for(
            "SELECT 1 FROM TMTag t JOIN TMTag p ON t.parent = p.uuid WHERE t.title = ? AND p.title = ?",
            (tag, parent),
            f"tag {tag} parent {parent}",
        )
    record(tag, f"tag{f' (child of {parent})' if parent else ''}", uuid)

print("== AppleScript: area tag assignment (TMAreaTag population probe) ==")
osa('tell application "Things3" to set tag names of area "LAB-AREA-A" to "lab-tag-1"')
if wait_for(
    "SELECT 1 FROM TMAreaTag at JOIN TMArea a ON at.areas=a.uuid JOIN TMTag t ON at.tags=t.uuid WHERE a.title='LAB-AREA-A' AND t.title='lab-tag-1'",
    (),
    "area tag join",
):
    print("  [ok] LAB-AREA-A tagged lab-tag-1 (TMAreaTag row exists)")

print("== URL layer: projects ==")
for title, area in [("LAB-PROJ-PLAIN", "LAB-AREA-A"), ("LAB-PROJ-MIXED", "LAB-AREA-B")]:
    qs = urllib.parse.urlencode({"title": title, "area": area}, quote_via=urllib.parse.quote)
    open_url(f"things:///add-project?{qs}")
    task_uuid(title, f"project in {area}", "type = 1")

qs = urllib.parse.urlencode(
    {"title": "LAB-PROJ-COMPLETED", "area": "LAB-AREA-B", "to-dos": "LAB-C-1\nLAB-C-2"},
    quote_via=urllib.parse.quote,
)
open_url(f"things:///add-project?{qs}")
task_uuid("LAB-PROJ-COMPLETED", "project (Mike completes via UI)", "type = 1")
for t in ("LAB-C-1", "LAB-C-2"):
    task_uuid(t, "child of LAB-PROJ-COMPLETED")

print("== URL json layer: headed project (heading creation in NEW project payload) ==")
payload = [
    {
        "type": "project",
        "attributes": {
            "title": "LAB-PROJ-HEADINGS",
            "area": "LAB-AREA-A",
            "items": [
                {"type": "to-do", "attributes": {"title": "LAB-H-FLAT"}},
                {"type": "heading", "attributes": {"title": "Alpha"}},
                {"type": "to-do", "attributes": {"title": "LAB-H-A1"}},
                {"type": "to-do", "attributes": {"title": "LAB-H-A2"}},
                {"type": "heading", "attributes": {"title": "Beta"}},
                {"type": "to-do", "attributes": {"title": "LAB-H-B1"}},
            ],
        },
    }
]
open_url("things:///json?data=" + urllib.parse.quote(json.dumps(payload)))
task_uuid("LAB-PROJ-HEADINGS", "project with headings", "type = 1")
for h in ("Alpha", "Beta"):
    task_uuid(h, "heading", "type = 2")
# heading-containment invariant: headed children have project NULL, heading set
for t, role in [("LAB-H-FLAT", "unheaded child"), ("LAB-H-A1", "child under Alpha"), ("LAB-H-A2", "child under Alpha"), ("LAB-H-B1", "child under Beta")]:
    task_uuid(t, role)
rows = q(
    "SELECT COUNT(*) FROM TMTask WHERE title IN ('LAB-H-A1','LAB-H-A2','LAB-H-B1') AND heading IS NOT NULL AND project IS NULL"
)
print(f"  heading-containment invariant (expect 3): {rows[0][0]}")
if rows[0][0] != 3:
    FAILURES.append("headed children do not follow the heading/project-NULL invariant")

print("== URL layer: project children ==")
add("LAB-P-1", "todo tagged lab-tag-1", {"list": "LAB-PROJ-PLAIN", "tags": "lab-tag-1"})
add("LAB-P-2", "todo with deadline", {"list": "LAB-PROJ-PLAIN", "deadline": "2026-07-06"})
add("LAB-P-3", "todo with unicode notes", {"list": "LAB-PROJ-PLAIN", "notes": "Seeded ✓ note — émoji 🎯"})
mixed = {}
for t in ("LAB-M-OPEN", "LAB-M-DONE", "LAB-M-CANCEL"):
    mixed[t] = add(t, "child of LAB-PROJ-MIXED", {"list": "LAB-PROJ-MIXED"})

print("== URL layer: standalone todos across every list state ==")
add("LAB-INBOX-1", "inbox plain", {}, "start = 0")
add("LAB-INBOX-2", "inbox with checklist", {"checklist-items": "Alpha\nBravo\nCharlie"}, "start = 0")
add("LAB-TODAY-1", "today", {"when": "today"})
add("LAB-EVENING-1", "this evening", {"when": "evening"}, "startBucket = 1")
add("LAB-ANYTIME-1", "anytime", {"when": "anytime"}, "start = 1")
add("LAB-PINNED-TODAY", "today-exact at pinned date", {"when": "2026-07-05"})
add("LAB-UPCOMING-1", "upcoming", {"when": "2026-07-08"})
add("LAB-SOMEDAY-1", "someday", {"when": "someday"}, "start = 2")
add("LAB-DEADLINE-ONLY", "anytime w/ deadline (not-in-today check)", {"when": "anytime", "deadline": "2026-07-04"})
add("LAB-TAGGED-BOTH", "anytime w/ tag hierarchy", {"when": "anytime", "tags": "lab-tag-2,high"})
logged = add("LAB-LOGGED-1", "to be completed via URL", {"when": "anytime"})
trash_me = add("LAB-TRASH-ME", "to be trashed via AppleScript (probe A24)", {})

print("== URL updates (auth-token): status changes ==")
if mixed.get("LAB-M-DONE"):
    update(mixed["LAB-M-DONE"], "LAB-M-DONE completed", {"completed": "true"}, "SELECT 1 FROM TMTask WHERE uuid = ? AND status = 3")
if mixed.get("LAB-M-CANCEL"):
    update(mixed["LAB-M-CANCEL"], "LAB-M-CANCEL canceled", {"canceled": "true"}, "SELECT 1 FROM TMTask WHERE uuid = ? AND status = 2")
if logged:
    update(logged, "LAB-LOGGED-1 completed", {"completed": "true"}, "SELECT 1 FROM TMTask WHERE uuid = ? AND status = 3")

print("== AppleScript: delete-to-trash (probe A24 evidence) ==")
if trash_me:
    osa('tell application "Things3" to delete to do id "%s"' % trash_me)
    if wait_for("SELECT 1 FROM TMTask WHERE uuid = ? AND trashed = 1", (trash_me,), "trash flag"):
        print("  [ok] AppleScript delete set trashed=1 (original area/project links intact)")

print("== checklist verification ==")
rows = q(
    "SELECT COUNT(*) FROM TMChecklistItem c JOIN TMTask t ON c.task = t.uuid WHERE t.title = 'LAB-INBOX-2'"
)
print(f"  checklist items on LAB-INBOX-2 (expect 3): {rows[0][0]}")
if rows[0][0] != 3:
    FAILURES.append("checklist seeding failed")

with open(os.path.expanduser("~/things-lab/seed-manifest.json"), "w") as f:
    json.dump(MANIFEST, f, indent=2)

missing = [n for n, m in MANIFEST.items() if not m["uuid"]]
print(f"\nSEEDED: {len(MANIFEST)} records, missing uuids: {missing or 'none'}")
print(f"FAILURES: {FAILURES or 'none'}")
sys.exit(1 if (missing or FAILURES) else 0)
