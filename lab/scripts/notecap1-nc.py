#!/usr/bin/env python3
"""NOTECAP1 guest helper — synthetic notes payloads + one dispatch per vector.

Everything about a notes-ceiling probe is length-sensitive, so payload
construction, percent-encoding and dispatch all happen HERE (in the guest,
in one process) rather than through a shell that could clip or re-encode.

Payload kinds (all fully synthetic — digits, one emoji, one combining pair):
  ascii  n scalars of cycling digits            1 byte  / 1 scalar / 1 utf16
  emoji  n copies of U+1F600                    4 bytes / 1 scalar / 2 utf16
  comb   n copies of "e" + U+0301               3 bytes / 2 scalars / 2 utf16
  strad  k ascii scalars then emoji filler      (boundary-straddle probe)

Every payload starts with "<tag>|" so a DB poll can wait on the prefix.

Verbs:
  gen  <kind> <n> <tag>              write /tmp/nc.txt, print stats json
  stats                              print stats json for /tmp/nc.txt
  as-set <uuid>                      AppleScript: set notes of to do <uuid>
  as-setp <uuid>                     AppleScript: set notes of project <uuid>
  as-add <title>                     AppleScript: make new to do w/ notes
  url-add <title> [token]            things:///add?notes=
  url-upd <uuid> <token> [titlepad]  things:///update?notes=  (+ optional title pad)
  url-updp <uuid> <token>            things:///update-project?notes=
  url-app <uuid> <token>             things:///update?append-notes=
  json-upd <uuid> <token>            things:///json  update, notes=
  url-addp <title>                   things:///add-project?notes=
  json-add <title> <token>           things:///json  (batch vector)
"""
import json
import os
import subprocess
import sys
import urllib.parse

PATH = "/tmp/nc.txt"
ASCRIPT = "/tmp/nc.applescript"


def build(kind, n, tag):
    head = tag + "|"
    if kind == "ascii":
        body = "".join(str(i % 10) for i in range(n))
    elif kind == "emoji":
        body = "\U0001f600" * n
    elif kind == "comb":
        body = "é" * n
    elif kind == "zwj":
        # family: 4 emoji joined by 3 ZWJ — 7 scalars, 25 bytes, 11 utf16,
        # ONE UAX#29 extended grapheme cluster.
        body = "\U0001f468‍\U0001f469‍\U0001f467‍\U0001f466" * n
    elif kind == "flag":
        # regional-indicator pair — 2 scalars, 8 bytes, 4 utf16, ONE cluster.
        body = "\U0001f1fa\U0001f1f3" * n
    elif kind == "skin":
        # emoji + skin-tone modifier — 2 scalars, 8 bytes, 4 utf16, ONE cluster.
        body = "\U0001f44d\U0001f3fd" * n
    elif kind == "crlf":
        # CR LF — 2 scalars, 2 bytes, 2 utf16, ONE cluster under UAX#29.
        body = "\r\n" * n
    elif kind == "strad":
        # n ascii scalars, then 40 emoji: whatever the ceiling's unit, the cut
        # lands inside the emoji run and the stored tail bytes name the law.
        body = "".join(str(i % 10) for i in range(n)) + "\U0001f600" * 40
    else:
        raise SystemExit("unknown kind " + kind)
    return head + body


def stats(s):
    b = s.encode("utf-8")
    return {
        "scalars": len(s),
        "bytes": len(b),
        "utf16": len(s.encode("utf-16-le")) // 2,
        "head": s[:24],
        "tailhex": b[-12:].hex(),
    }


def read_payload():
    with open(PATH, encoding="utf-8") as f:
        return f.read()


def osa(script):
    with open(ASCRIPT, "w", encoding="utf-8") as f:
        f.write(script)
    r = subprocess.run(
        ["osascript", ASCRIPT], capture_output=True, text=True, timeout=120
    )
    return {"exit": r.returncode, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}


READ = 'set t to (read (POSIX file "%s") as «class utf8»)\n' % PATH


def openurl(url):
    r = subprocess.run(
        ["open", "-g", url], capture_output=True, text=True, timeout=120
    )
    return {
        "exit": r.returncode,
        "urlchars": len(url),
        "urlbytes": len(url.encode("utf-8")),
        "stderr": r.stderr.strip(),
    }


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "stats"
    out = {}
    if cmd == "gen":
        s = build(argv[1], int(argv[2]), argv[3])
        with open(PATH, "w", encoding="utf-8") as f:
            f.write(s)
        out = stats(s)
    elif cmd == "stats":
        out = stats(read_payload())
    elif cmd == "as-set":
        out = osa(
            READ + 'tell application "Things3" to set notes of to do id "%s" to t\n' % argv[1]
        )
    elif cmd == "as-setp":
        out = osa(
            READ + 'tell application "Things3" to set notes of project id "%s" to t\n' % argv[1]
        )
    elif cmd == "as-add":
        out = osa(
            READ
            + 'tell application "Things3" to make new to do with properties {name:"%s", notes:t}\n'
            % argv[1]
        )
    elif cmd == "url-add":
        p = read_payload()
        q = {"title": argv[1], "notes": p}
        if len(argv) > 2 and argv[2]:
            q["auth-token"] = argv[2]
        out = openurl("things:///add?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote))
    elif cmd == "url-addp":
        p = read_payload()
        out = openurl(
            "things:///add-project?"
            + urllib.parse.urlencode({"title": argv[1], "notes": p}, quote_via=urllib.parse.quote)
        )
    elif cmd == "url-upd":
        p = read_payload()
        q = {"id": argv[1], "notes": p, "auth-token": argv[2]}
        # optional TITLE PAD: same notes payload, a longer overall URL. If the
        # notes cut moves, the ceiling is on the URL; if it does not, it is on
        # the FIELD.
        if len(argv) > 3 and argv[3] and int(argv[3]) > 0:
            q["title"] = "T" * int(argv[3])
        out = openurl("things:///update?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote))
    elif cmd == "url-updp":
        p = read_payload()
        out = openurl(
            "things:///update-project?"
            + urllib.parse.urlencode(
                {"id": argv[1], "notes": p, "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    elif cmd == "url-app":
        p = read_payload()
        out = openurl(
            "things:///update?"
            + urllib.parse.urlencode(
                {"id": argv[1], "append-notes": p, "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    elif cmd == "json-upd":
        p = read_payload()
        data = [{"type": "to-do", "operation": "update", "id": argv[1], "attributes": {"notes": p}}]
        out = openurl(
            "things:///json?"
            + urllib.parse.urlencode(
                {"data": json.dumps(data, ensure_ascii=False), "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    elif cmd == "json-add":
        p = read_payload()
        data = [{"type": "to-do", "attributes": {"title": argv[1], "notes": p}}]
        out = openurl(
            "things:///json?"
            + urllib.parse.urlencode(
                {"data": json.dumps(data, ensure_ascii=False), "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    # ---------------- the FIELD-LENGTH matrix (title / checklist / tag /
    # heading / area) — same payload machinery, one verb per field × vector.
    elif cmd == "url-add-t":
        p = read_payload()
        out = openurl(
            "things:///add?" + urllib.parse.urlencode({"title": p}, quote_via=urllib.parse.quote)
        )
    elif cmd == "url-addp-t":
        p = read_payload()
        out = openurl(
            "things:///add-project?"
            + urllib.parse.urlencode({"title": p}, quote_via=urllib.parse.quote)
        )
    elif cmd == "url-upd-t":
        p = read_payload()
        out = openurl(
            "things:///update?"
            + urllib.parse.urlencode(
                {"id": argv[1], "title": p, "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    elif cmd == "url-add-ck":
        p = read_payload()
        out = openurl(
            "things:///add?"
            + urllib.parse.urlencode(
                {"title": argv[1], "checklist-items": p}, quote_via=urllib.parse.quote
            )
        )
    elif cmd == "url-add-ckn":
        # MANY short checklist items: the client newline-joins them into ONE
        # `checklist-items` parameter, so this measures the JOINED parameter's
        # own ceiling rather than any single item's.
        count, ln = int(argv[2]), int(argv[3])
        items = ["%s%0*d" % (argv[4], ln, i) for i in range(count)]
        out = openurl(
            "things:///add?"
            + urllib.parse.urlencode(
                {"title": argv[1], "checklist-items": "\n".join(items)},
                quote_via=urllib.parse.quote,
            )
        )
        out["items"] = count
        out["joined"] = len("\n".join(items))
    elif cmd == "url-upd-ckn":
        count, ln = int(argv[3]), int(argv[4])
        items = ["%s%0*d" % (argv[5], ln, i) for i in range(count)]
        out = openurl(
            "things:///update?"
            + urllib.parse.urlencode(
                {
                    "id": argv[1],
                    "checklist-items": "\n".join(items),
                    "auth-token": argv[2],
                },
                quote_via=urllib.parse.quote,
            )
        )
        out["items"] = count
    elif cmd == "json-ckn":
        count, ln = int(argv[3]), int(argv[4])
        items = [
            {"type": "checklist-item", "attributes": {"title": "%s%0*d" % (argv[5], ln, i)}}
            for i in range(count)
        ]
        data = [
            {
                "type": "to-do",
                "attributes": {"title": argv[1], "checklist-items": items},
            }
        ]
        out = openurl(
            "things:///json?"
            + urllib.parse.urlencode(
                {"data": json.dumps(data, ensure_ascii=False), "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
        out["items"] = count
    elif cmd == "url-add-tag":
        p = read_payload()
        out = openurl(
            "things:///add?"
            + urllib.parse.urlencode({"title": argv[1], "tags": p}, quote_via=urllib.parse.quote)
        )
    elif cmd == "json-head":
        p = read_payload()
        data = [
            {
                "type": "project",
                "operation": "update",
                "id": argv[1],
                "attributes": {"items": [{"type": "heading", "attributes": {"title": p}}]},
            }
        ]
        out = openurl(
            "things:///json?"
            + urllib.parse.urlencode(
                {"data": json.dumps(data, ensure_ascii=False), "auth-token": argv[2]},
                quote_via=urllib.parse.quote,
            )
        )
    elif cmd == "as-name":
        out = osa(
            READ + 'tell application "Things3" to set name of to do id "%s" to t\n' % argv[1]
        )
    elif cmd == "as-area":
        out = osa(
            READ + 'tell application "Things3" to make new area with properties {name:t}\n'
        )
    elif cmd == "as-tag":
        out = osa(READ + 'tell application "Things3" to make new tag with properties {name:t}\n')
    else:
        raise SystemExit("unknown verb " + cmd)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
