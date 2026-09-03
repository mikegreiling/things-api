/**
 * THE AX SETTLE SIDECAR — the app tells us when it has changed (VOPAT2, #676).
 *
 * Every settle this vector used to make was a POLL. `select-popup` clicked and
 * then re-asked `exists menu 1` every 50 ms; the typing loop slept 150 ms and
 * hoped the field had taken focus; `cgSettle` re-read the whole cadence group
 * until two reads agreed. VOPAT1 (docs/lab/vopat1-screen-reader-pattern.md §4)
 * measured what Things ANNOUNCES through the Accessibility notification API and
 * found an observable for every actuation this drive makes — plus the property
 * that makes them usable: **idle chatter is zero**, so every arrival is
 * attributable to the actuation that preceded it and a settle needs no noise
 * filter, only a debounce.
 *
 *   | the poll today                          | the observable that replaces it        | measured |
 *   |-----------------------------------------|----------------------------------------|---------:|
 *   | `exists menu 1` every 50 ms             | `AXMenuOpened`                         |   5.1 ms |
 *   | poll for the Repeat dialog              | `AXSheetCreated`                       |   582 ms |
 *   | `delay 0.15` after asking for focus     | `AXFocusedUIElementChanged`            |  27.6 ms |
 *   | `delay 0.1` after a keystroke           | `AXValueChanged` on the field          |  78.6 ms |
 *   | two agreeing reads of the cadence group | `AXValueChanged` on the pop-up the     |   535 ms |
 *   |                                         | step set + the `AXUIElementDestroyed`  |          |
 *   |                                         | burst that tears the old children down |          |
 *   | 1.2 s occurrence-recompute poll         | `AXValueChanged` on the `Next:` pop-up |   400 ms |
 *
 * An AX notification IS a closed-loop observable under the UI-automation
 * determinism doctrine — it is the app reporting a state change, not a clock —
 * and it fixes the specific defect the settle law was written for (RDLAT2 §7c):
 * a gate sized by how long the driver's own reads take breaks the moment the
 * reads get cheaper. A notification cannot be sized by the driver's speed.
 *
 * TWO RIDERS, both from the measurement:
 *  - `AXLayoutChanged` NEVER fires, for any actuation, on any element
 *    (VOPAT1-12) — no settle here may wait on it. It is registered anyway, so a
 *    future app version that starts posting it shows up in a trace.
 *  - A notification says WHEN, not WHAT. The pre-commit audit (CGRD1) still
 *    re-reads every control it set, and the shape manifest's assertions still
 *    run. Nothing here replaces a READ; it replaces the WAITING.
 *
 * ── the production shape, and why ──────────────────────────────────────────
 *
 * `AXObserverCreate` takes a C FUNCTION POINTER, which JXA's ObjC bridge cannot
 * marshal (VOPAT1 §4) — so the observer cannot live inside an osascript hop at
 * all. It is a `python3` ctypes sidecar, and it is:
 *
 *  - **ONE PROCESS PER DRIVE, not one per settle.** A settle is then a Unix
 *    socket round-trip (sub-millisecond, no spawn) against a ledger that has
 *    been recording since before the first actuation. A per-settle helper would
 *    pay a process spawn — measured at 143.9 ms for `osascript` in the same rig
 *    — to replace waits of 5 to 80 ms, i.e. it would be slower than the polls.
 *  - **SPAWNED FROM INSIDE AN OSASCRIPT HOP.** Accessibility trust belongs to
 *    the RESPONSIBLE application and is assigned at spawn time, so a sidecar
 *    spawned by the hop inherits the identity that already holds the grant —
 *    the deputy on a helper-routed Mac, the terminal otherwise. It needs no
 *    grant of its own and raises no consent dialog (permissions doctrine), and
 *    the deputy's fixed verb set needs no new verb.
 *  - **AWAITED FROM TWO SIDES.** The driver (node) speaks to the socket
 *    directly for cross-hop settles; a hop that must settle IN THE MIDDLE of
 *    its own script speaks to it with `nc -U` through one `do shell script`,
 *    which keeps the hop unsplit (DRVLAT1 folded those waits into their hops
 *    precisely because a split costs a process spawn).
 *  - **BOUNDED ON EVERY AXIS.** An absolute TTL, a no-request idle timeout, and
 *    an explicit `stop` in the drive's `finally`. A sidecar cannot outlive its
 *    drive even if the drive is killed.
 *
 * ── THE ROUTED MAC GETS A SECOND TRANSPORT (DEPOBS1, #695) ─────────────────
 *
 * Both shell hops above are the problem. The deputy's broker LINTS every script
 * it is handed and refuses any containing `do shell script` (or `do script`) —
 * `scriptGuard`, deputy/src/server.swift, mirrored in TS as
 * DEPUTY_BANNED_SCRIPT_PHRASES — because a broker that will shell out is no
 * longer "drive the Things GUI" but "run arbitrary shell under the helper's
 * grants". That lint is correct and stays. What it means is that a host which
 * routes its automation through the deputy cannot have this SIDECAR at all: not
 * the spawn hop, not the in-script client. 0.20.7 shipped it without that gate
 * and `todo add-repeating --dangerously-drive-gui` failed in two seconds on
 * every helpers-routed Mac — the lab never saw it because goldens run scripts
 * DIRECT, with no deputy installed, so the certified arm was the only arm.
 *
 * The answer is not a different sidecar; it is a different HOST for the
 * observer. An AXObserver needs a process that holds the Accessibility grant and
 * can own a C function pointer and a run loop — and on a routed Mac the deputy
 * is exactly that process, already trusted, already listening on a socket this
 * library already talks to. So helpers 1.4.0 host the ledger themselves
 * (deputy/src/observer.swift, verbs `observer-start` / `-mark` / `-wait` /
 * `-stop`) and this module grew a SECOND TRANSPORT for them.
 *
 * WHAT THE ROUTED TRANSPORT DOES AND DOES NOT RESTORE. It carries every settle
 * NODE performs — the marks, the "did that actuate anything?" count, and the
 * cross-hop `Next:` recompute wait, which is the whole-hop settle the field
 * could see. It does NOT carry the IN-SCRIPT settles: a generated script still
 * has no way to reach a socket without a phrase the broker refuses, so on a
 * routed host {@link settleInjectorFor} stays INERT and every script is
 * generated byte-identically to the polling version. A routed drive therefore
 * runs with node-side event settles and in-script polls — a real half, honestly
 * bounded, and the remaining half is a transport problem, not an observer one.
 *
 * Which transport a host gets is {@link observerTransport}'s single decision,
 * and it is traced, so a drive never has to be guessed at from its environment.
 *
 * ── the fallback stays certified ───────────────────────────────────────────
 *
 * `python3` ships with the Command Line Tools, so availability is gated exactly
 * as the probe gated it (`xcode-select -p`). When the gate says no — or the host
 * is deputy-routed, or the sidecar cannot be spawned, or its handshake fails —
 * every script is generated BYTE-IDENTICALLY to the polling version that shipped
 * before this campaign and the drive proceeds on it. Availability failure is a fallback, never a
 * refusal. An armed settle that TIMES OUT is the opposite: it fails closed with
 * its own named reason, because a settle that gave up is a surface the drive
 * cannot vouch for (determinism doctrine, fail direction over-caution).
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  type DeputyObserverStart,
  type DeputyObserverWait,
  deputyHostsObserver,
} from "../../deputy/protocol.ts";
import { deputyAsyncRequest, deputyExpected, deputyRouting } from "../../deputy/routing.ts";
import { stateDir } from "../../paths.ts";
import { trace } from "../../trace/tracer.ts";
import { escapeAppleScript } from "./applescript.ts";

/**
 * The switch. `0`/`false`/`no`/`off` disables the observer outright (the drive
 * runs the certified polling settles); anything else, or unset, means "use it
 * when it is available". A settle is machinery, and machinery gets an off
 * switch a refusal can name.
 */
export const OBSERVER_ENV = "THINGS_API_AX_OBSERVER";

/** Stderr log prefix for a settle record, mirroring `#AXELEMS` (RDLAT2 §E.1). */
export const AX_SETTLE_LOG_PREFIX = "#AXSETTLE ";

/** How long the sidecar lives at the outside, whatever the drive does. */
const SIDECAR_TTL_MS = 300_000;
/** How long it lives with no request from anybody. */
const SIDECAR_IDLE_MS = 60_000;
/** How long the handshake is retried for while the sidecar binds its socket. */
const HANDSHAKE_TIMEOUT_MS = 3_000;
const HANDSHAKE_POLL_MS = 25;
/** Ceiling on one socket request, so a wedged sidecar cannot hold a drive. */
const REQUEST_GRACE_MS = 5_000;
/**
 * Deadline for a NON-WAITING observer round-trip (arm, mark, count, stop). A
 * unix-socket exchange with the deputy is sub-millisecond; this is the ceiling
 * that keeps a wedged helper from holding a drive, not a budget anything is
 * expected to use.
 */
const OBSERVER_REQUEST_MS = 5_000;

/** One settle's expectation: what the app must announce, and by when. */
export interface SettleSpec {
  /**
   * What this settle is waiting for, in the words a refusal should use — e.g.
   * `the Repeat dialog to open`. Never the contents of the dialog.
   */
  what: string;
  /** ANY-OF: `AXValueChanged:AXPopUpButton` (role optional) — the arrival that ends the wait. */
  want: string[];
  /** ALL-OF: every class here must also have been seen since the mark. */
  require?: string[];
  timeoutMs: number;
  /** Milliseconds of no further matching arrival before the wait is satisfied (burst debounce). */
  quietMs?: number;
  /**
   * The fixed delay (seconds) this settle REPLACES. It is what the generated
   * script falls back to when no sidecar is live, so the fallback script is
   * byte-identical to the one that shipped before this campaign.
   */
  fallbackDelayS?: number;
}

/** Which process is holding the ledger for this drive, if any. */
export type ObserverTransportKind = "sidecar" | "deputy" | "none";

/** The transport decision, with the reason a `none` can be reported by. */
export interface ObserverTransportChoice {
  transport: ObserverTransportKind;
  /** Why there is no observer — empty when there is one. */
  why: string;
}

/** A live `python3` sidecar, reached over the socket it bound for this drive. */
export interface SidecarSession {
  transport: "sidecar";
  socketPath: string;
  token: string;
  logPath: string;
  /** Registrations that succeeded / were asked for, from the handshake. */
  registered: string;
  /** The sidecar's own pid, for the trace and for the stop path's honesty. */
  pid: number;
}

/**
 * A session hosted BY THE DEPUTY, reached over the socket routing already
 * holds open. The token is the deputy's own mint — a capability for this drive,
 * never a name chosen here — and the deputy reaps the session on idleness and
 * on its own drain, so a killed client cannot leak an observer.
 */
export interface DeputySession {
  transport: "deputy";
  token: string;
  /** Registrations that succeeded / were asked for, from the start reply. */
  registered: string;
  /** The observed process — Things, as the deputy resolved it. */
  pid: number;
}

export type ObserverSession = SidecarSession | DeputySession;

export type SettleOutcome =
  | { ok: true; latencyMs: number; fired: string; hits: number; seq: number }
  | { ok: false; reason: string; waitedMs: number; seen: number; seq: number };

interface Reply {
  ok: boolean;
  fields: Record<string, string>;
}

/* ------------------------------------------------------------------ python */

/**
 * The sidecar, verbatim. It is EMBEDDED rather than shipped as a file because
 * `npm run build` is a bare `tsc` — an asset beside the sources would not reach
 * `dist`, the published package, or the lab's guest bundle, and every one of
 * those is a place this has to work. The same reason the JXA preludes in
 * `ui.ts` and `ui-drag.ts` are embedded.
 *
 * It reads a notification NAME and an AX ROLE and nothing else: no value, no
 * title, no description, no identifier. Nothing from the database can reach a
 * log or a trace through this path.
 */
export const OBSERVER_PY = `#!/usr/bin/env python3
"""things-api AX settle sidecar - the app tells us when it has changed (VOPAT2).

Registers an AXObserver on the Things APPLICATION element, runs a CFRunLoop,
records every notification with a sequence number, and answers BLOCKING await
requests over a Unix domain socket. The driver marks the sequence before an
actuation and awaits the observable after it, so nothing can be missed in
between.

WHY ctypes: AXObserverCreate takes a C function pointer (AXObserverCallback),
which JXA's ObjC bridge cannot marshal, so the observer cannot live inside an
osascript hop. CFUNCTYPE produces a real function pointer and the stdlib is
present on every macOS with the Command Line Tools, which is what the caller
gates on.

WHY SPAWNED BY OSASCRIPT: Accessibility trust belongs to the RESPONSIBLE
application and is assigned at spawn time, so a sidecar spawned inside the hop
inherits the identity that already holds the grant and needs none of its own.

IT NEVER READS CONTENT: a record carries a notification name and an AX role
string. No title, value, description or identifier is ever read.

PROTOCOL - one line per request, one line per response (no JSON: the in-hop
client is AppleScript, which has no parser):

  <token> hello                    -> ok seq=N trusted=1 reg=A/B pid=P
  <token> mark                     -> ok seq=N
  <token> count since=N            -> ok seq=M seen=K   (non-blocking)
  <token> await since=N want=A[:Role],B timeout=3000 [require=...] [quiet=50]
                                   -> ok seq=M lat=5.1 fired=A:Role hits=1 events=3
                                   -> err reason=timeout since=N waited=3000 seen=0 missing=-
  <token> stop                     -> ok seq=N

want is ANY-OF; require is ALL-OF. quiet waits for that many milliseconds with
no further matching arrival, which absorbs a burst (65 AXRowCountChanged for one
disclosure fold) without reading anything.

Every exit is bounded: --ttl-ms is the absolute lifetime, --idle-ms the
no-request lifetime, and stop is explicit. A sidecar cannot outlive its drive.
"""

import argparse
import ctypes
import os
import socketserver
import sys
import threading
import time
from ctypes import (
    CFUNCTYPE,
    POINTER,
    byref,
    c_char_p,
    c_double,
    c_int,
    c_int32,
    c_long,
    c_uint32,
    c_void_p,
)

UTF8 = 0x08000100  # kCFStringEncodingUTF8

# Registered on the APPLICATION element, which receives what its descendants
# post: VOPAT1 S4 recorded AXValueChanged tagged AXScrollBar and AXImage from a
# registration that named neither element. AXLayoutChanged NEVER fires for any
# actuation this driver makes (VOPAT1-12); it is listed so that a future app
# version which starts posting it appears in a trace instead of being invisible.
CLASSES = [
    "AXCreated",
    "AXUIElementDestroyed",
    "AXSheetCreated",
    "AXWindowCreated",
    "AXValueChanged",
    "AXTitleChanged",
    "AXFocusedUIElementChanged",
    "AXFocusedWindowChanged",
    "AXMenuOpened",
    "AXMenuClosed",
    "AXRowCountChanged",
    "AXSelectedRowsChanged",
    "AXSelectedChildrenChanged",
    "AXLayoutChanged",
    "AXResized",
    "AXMoved",
]

AS = None
CF = None
CALLBACK = None
RUNLOOP_MODE = None


def load_frameworks():
    """Bind every symbol, with EVERY restype declared.

    A missing restype on a 64-bit pointer return silently truncates to a 32-bit
    int - the classic ctypes+AX defect, and the one that would make this program
    report a plausible-looking nothing.
    """
    global AS, CF, RUNLOOP_MODE
    AS = ctypes.CDLL(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    )
    CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

    AS.AXUIElementCreateApplication.restype = c_void_p
    AS.AXUIElementCreateApplication.argtypes = [c_int]
    AS.AXUIElementCopyAttributeValue.restype = c_int
    AS.AXUIElementCopyAttributeValue.argtypes = [c_void_p, c_void_p, POINTER(c_void_p)]
    AS.AXUIElementSetMessagingTimeout.restype = c_int
    AS.AXUIElementSetMessagingTimeout.argtypes = [c_void_p, ctypes.c_float]
    AS.AXIsProcessTrusted.restype = ctypes.c_bool
    AS.AXObserverCreate.restype = c_int
    AS.AXObserverAddNotification.restype = c_int
    AS.AXObserverAddNotification.argtypes = [c_void_p, c_void_p, c_void_p, c_void_p]
    AS.AXObserverGetRunLoopSource.restype = c_void_p
    AS.AXObserverGetRunLoopSource.argtypes = [c_void_p]

    CF.CFStringCreateWithCString.restype = c_void_p
    CF.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
    CF.CFStringGetCString.restype = c_int
    CF.CFStringGetCString.argtypes = [c_void_p, c_char_p, c_long, c_uint32]
    CF.CFRelease.restype = None
    CF.CFRelease.argtypes = [c_void_p]
    CF.CFRunLoopGetCurrent.restype = c_void_p
    CF.CFRunLoopGetCurrent.argtypes = []
    CF.CFRunLoopAddSource.restype = None
    CF.CFRunLoopAddSource.argtypes = [c_void_p, c_void_p, c_void_p]
    CF.CFRunLoopRunInMode.restype = c_int32
    CF.CFRunLoopRunInMode.argtypes = [c_void_p, c_double, ctypes.c_bool]

    RUNLOOP_MODE = c_void_p.in_dll(CF, "kCFRunLoopDefaultMode")


def cfstr(s):
    return c_void_p(CF.CFStringCreateWithCString(None, s.encode("utf-8"), UTF8))


def pystr(ref):
    if not ref:
        return ""
    buf = ctypes.create_string_buffer(256)
    if CF.CFStringGetCString(ref, buf, 256, UTF8):
        return buf.value.decode("utf-8", "replace")
    return ""


_KEYS = {}


def key(name):
    if name not in _KEYS:
        _KEYS[name] = cfstr(name)
    return _KEYS[name]


def role_of(el):
    out = c_void_p()
    if AS.AXUIElementCopyAttributeValue(el, key("AXRole"), byref(out)) != 0:
        return ""
    if not out.value:
        return ""
    s = pystr(out)
    CF.CFRelease(out)
    return s


class Ledger(object):
    """Every arrival, in order, with the sequence number a waiter compares to.

    Bounded: idle chatter is zero (VOPAT1-6) and the largest burst measured is 65
    arrivals for one disclosure fold, so this is a whole drive with room to
    spare. What is trimmed is counted, so a waiter is never silently answered
    out of a ledger that dropped its evidence.
    """

    LIMIT = 4000

    def __init__(self):
        self.cond = threading.Condition()
        self.events = []
        self.seq = 0
        self.dropped = 0

    def add(self, notification, role):
        with self.cond:
            self.seq += 1
            self.events.append((self.seq, time.monotonic(), notification, role))
            if len(self.events) > self.LIMIT:
                cut = len(self.events) - self.LIMIT
                del self.events[:cut]
                self.dropped += cut
            self.cond.notify_all()

    def current(self):
        with self.cond:
            return self.seq

    def since(self, seq):
        return [e for e in self.events if e[0] > seq]


LEDGER = Ledger()
STOP = threading.Event()
STATE = {"token": "", "trusted": False, "registered": 0, "asked": 0, "lastRequest": 0.0}

# WHEN EACH MARK WAS TAKEN, so a reported latency is the time from THE ACTUATION
# to the app's announcement rather than the time from the await request.
#
# Without this the two are confused, and the confusion is visible: a settle whose
# notification had ALREADY arrived by the time the script got round to asking
# reported a NEGATIVE latency (measured -0.2 ms and -0.6 ms for the typing
# loop's two settles, VOPAT2 trace). That is not a defect in the settle - the
# mark is taken before the actuation, so the arrival was correctly counted - but
# a trace that says "-0.6 ms" tells the reader nothing about what the app took.
# Keyed by the sequence the mark returned; the newest mark for a sequence wins.
MARKS = {}
MARKS_LIMIT = 64


def note_mark(seq):
    MARKS[seq] = time.monotonic()
    if len(MARKS) > MARKS_LIMIT:
        for old_seq in sorted(MARKS)[: len(MARKS) - MARKS_LIMIT]:
            del MARKS[old_seq]


def on_notification(observer, element, notification, refcon):
    # Runs on the sidecar's own run loop. Reads the element's ROLE and nothing
    # else, so no database content can reach a log or a trace through here.
    LEDGER.add(pystr(notification), role_of(element))


def parse_matchers(spec):
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if part == "":
            continue
        name, _, role = part.partition(":")
        out.append((name, role if role != "" else None))
    return out


def matches(event, matchers):
    for name, role in matchers:
        if event[2] == name and (role is None or event[3] == role):
            return True
    return False


def await_events(since, want, require, timeout_ms, quiet_ms):
    """Block until the wanted arrival - and every required class - has landed.

    The wait is on the ledger's condition variable, so it ends the instant the
    app announces: never at the next poll boundary, and never sized by how long
    the driver's own reads take (the RDLAT2 settle law).
    """
    t_start = time.monotonic()
    # The mark, when this waiter's since-sequence came from one - otherwise the
    # request itself, which is the best reference there is.
    t_ref = MARKS.get(since, t_start)
    deadline = t_start + timeout_ms / 1000.0
    quiet = max(0.0, quiet_ms / 1000.0)
    with LEDGER.cond:
        while True:
            fresh = LEDGER.since(since)
            hit = None
            for e in fresh:
                if matches(e, want):
                    hit = e
                    break
            missing = []
            for name, role in require:
                if not any(matches(e, [(name, role)]) for e in fresh):
                    missing.append(name if role is None else name + ":" + role)
            if hit is not None and not missing:
                relevant = [e[1] for e in fresh if matches(e, want) or matches(e, require)]
                last = max(relevant) if relevant else hit[1]
                if quiet == 0.0 or (time.monotonic() - last) >= quiet:
                    return True, [
                        ("seq", LEDGER.seq),
                        ("lat", round((hit[1] - t_ref) * 1000, 1)),
                        ("wait", round((time.monotonic() - t_start) * 1000, 1)),
                        ("fired", hit[2] + (":" + hit[3] if hit[3] else "")),
                        ("hits", sum(1 for e in fresh if matches(e, want))),
                        ("events", len(fresh)),
                    ]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fresh = LEDGER.since(since)
                return False, [
                    ("reason", "timeout"),
                    ("since", since),
                    ("seq", LEDGER.seq),
                    ("waited", round((time.monotonic() - t_start) * 1000, 1)),
                    ("seen", len(fresh)),
                    ("missing", "+".join(missing) if missing else "-"),
                    ("dropped", LEDGER.dropped),
                ]
            slice_s = remaining
            if hit is not None and not missing and quiet > 0.0:
                slice_s = min(slice_s, quiet)
            LEDGER.cond.wait(min(slice_s, 0.25))


def render(ok, fields):
    head = "ok" if ok else "err"
    return " ".join([head] + ["%s=%s" % (k, v) for k, v in fields])


class Handler(socketserver.StreamRequestHandler):
    timeout = 120

    def handle(self):
        try:
            line = self.rfile.readline(8192).decode("utf-8", "replace").strip()
        except Exception:
            return
        STATE["lastRequest"] = time.monotonic()
        parts = line.split(" ")
        if len(parts) < 2 or parts[0] != STATE["token"]:
            self.reply(False, [("reason", "unauthorized")])
            return
        op = parts[1]
        args = {}
        for kv in parts[2:]:
            k, _, v = kv.partition("=")
            args[k] = v
        if op == "hello":
            self.reply(
                True,
                [
                    ("seq", LEDGER.current()),
                    ("trusted", 1 if STATE["trusted"] else 0),
                    ("reg", "%d/%d" % (STATE["registered"], STATE["asked"])),
                    ("pid", os.getpid()),
                ],
            )
            return
        if op == "mark":
            seq = LEDGER.current()
            note_mark(seq)
            self.reply(True, [("seq", seq)])
            return
        if op == "count":
            # NON-BLOCKING: how many arrivals since a sequence, right now. It is
            # what lets a caller ask "did the previous actuation change anything
            # at all?" without waiting to find out, and Things being silent when
            # nothing happens (VOPAT1-6) is what makes the answer meaningful.
            try:
                since = int(args.get("since", "0"))
            except ValueError:
                self.reply(False, [("reason", "badargs")])
                return
            self.reply(True, [("seq", LEDGER.current()), ("seen", len(LEDGER.since(since)))])
            return
        if op == "stop":
            self.reply(True, [("seq", LEDGER.current())])
            STOP.set()
            return
        if op == "await":
            try:
                since = int(args.get("since", "0"))
                timeout_ms = min(60000, max(1, int(args.get("timeout", "3000"))))
                quiet_ms = min(2000, max(0, int(args.get("quiet", "0"))))
            except ValueError:
                self.reply(False, [("reason", "badargs")])
                return
            want = parse_matchers(args.get("want", ""))
            require = parse_matchers(args.get("require", ""))
            if not want:
                want = require
            if not want:
                self.reply(False, [("reason", "nomatcher")])
                return
            ok, fields = await_events(since, want, require, timeout_ms, quiet_ms)
            STATE["lastRequest"] = time.monotonic()
            self.reply(ok, fields)
            return
        self.reply(False, [("reason", "unknownop")])

    def reply(self, ok, fields):
        try:
            self.wfile.write((render(ok, fields) + "\\n").encode("utf-8"))
            self.wfile.flush()
        except Exception:
            pass


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 16


def serve(sock_path, ttl_ms, idle_ms, pump):
    try:
        os.unlink(sock_path)
    except OSError:
        pass
    old = os.umask(0o077)
    try:
        server = Server(sock_path, Handler)
    finally:
        os.umask(old)
    os.chmod(sock_path, 0o600)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
    thread.daemon = True
    thread.start()
    STATE["lastRequest"] = time.monotonic()
    deadline = time.monotonic() + ttl_ms / 1000.0
    idle_s = idle_ms / 1000.0
    try:
        while not STOP.is_set():
            pump()
            now = time.monotonic()
            if now >= deadline:
                break
            if idle_s > 0 and (now - STATE["lastRequest"]) >= idle_s:
                break
    finally:
        server.shutdown()
        server.server_close()
        try:
            os.unlink(sock_path)
        except OSError:
            pass


def main(argv):
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--socket", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--ttl-ms", type=int, default=180000)
    ap.add_argument("--idle-ms", type=int, default=60000)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)

    STATE["token"] = args.token
    if len(args.socket.encode("utf-8")) > 100:
        sys.stderr.write("socket path too long for a unix socket\\n")
        return 3

    if args.self_test:
        # NO ACCESSIBILITY AT ALL. What the lab certifies is the AX half; what
        # this proves, on any machine and without touching another process's UI
        # tree, is that the socket, the token, the matcher, the burst debounce
        # and every bounded exit behave as written. Events are injected by
        # writing "<Notification>[:<Role>],..." into the inject file.
        STATE["trusted"] = True
        inject = os.environ.get("THINGS_API_OBSERVER_INJECT", "")

        def pump():
            time.sleep(0.01)
            if inject and os.path.exists(inject):
                try:
                    with open(inject, "r") as fh:
                        spec = fh.read().strip()
                    os.unlink(inject)
                except OSError:
                    return
                for part in spec.split(","):
                    if part.strip() == "":
                        continue
                    name, _, role = part.partition(":")
                    LEDGER.add(name, role)

        serve(args.socket, args.ttl_ms, args.idle_ms, pump)
        return 0

    load_frameworks()
    global CALLBACK
    CALLBACK = CFUNCTYPE(None, c_void_p, c_void_p, c_void_p, c_void_p)(on_notification)
    AS.AXObserverCreate.argtypes = [c_int, type(CALLBACK), POINTER(c_void_p)]

    STATE["trusted"] = bool(AS.AXIsProcessTrusted())
    if not STATE["trusted"]:
        sys.stderr.write("not trusted for the Accessibility API\\n")
        return 4
    if args.pid <= 0:
        sys.stderr.write("no target pid\\n")
        return 5

    app = c_void_p(AS.AXUIElementCreateApplication(args.pid))
    if not app.value:
        sys.stderr.write("AXUIElementCreateApplication returned NULL\\n")
        return 6
    AS.AXUIElementSetMessagingTimeout(app, 5.0)

    obs = c_void_p()
    err = AS.AXObserverCreate(args.pid, CALLBACK, byref(obs))
    if err != 0 or not obs.value:
        sys.stderr.write("AXObserverCreate failed (AXError %d)\\n" % err)
        return 7

    for name in CLASSES:
        STATE["asked"] += 1
        # -25204 kAXErrorNotificationUnsupported is not a failure: an app that
        # does not post a class never will, and a settle waiting on it times out
        # into its own named refusal rather than hanging.
        if AS.AXObserverAddNotification(obs, app, key(name), None) == 0:
            STATE["registered"] += 1

    src = AS.AXObserverGetRunLoopSource(obs)
    if not src:
        sys.stderr.write("AXObserverGetRunLoopSource returned NULL\\n")
        return 8
    CF.CFRunLoopAddSource(CF.CFRunLoopGetCurrent(), src, RUNLOOP_MODE)

    # Drain whatever the registration itself queued, so sequence 0 is a clean
    # "nothing has happened yet" for the drive's first mark.
    CF.CFRunLoopRunInMode(RUNLOOP_MODE, 0.10, False)
    with LEDGER.cond:
        LEDGER.events = []
        LEDGER.seq = 0

    def pump():
        # Short slices: an arrival's recorded time is its own rather than the end
        # of a long blocking run, and STOP/TTL are checked between them.
        CF.CFRunLoopRunInMode(RUNLOOP_MODE, 0.02, False)

    serve(args.socket, args.ttl_ms, args.idle_ms, pump)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 - a sidecar reports and exits
        sys.stderr.write("%s: %s\\n" % (type(exc).__name__, exc))
        sys.exit(9)
`;

/* ---------------------------------------------------------- availability */

/** Memoized SIDECAR tool probe only — never the routing decision. */
let availability: ObserverTransportChoice | null = null;

/** Test seam: forget the memoized availability decision. */
export function resetObserverAvailability(): void {
  availability = null;
}

/** Is the observer switched off by environment? */
export function observerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[OBSERVER_ENV] ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

function which(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4_000 }, (err) => resolve(err === null));
  });
}

/**
 * WHERE THIS DRIVE'S LEDGER WILL LIVE — one decision, taken once per drive.
 *
 * THE ROUTING QUESTION COMES FIRST, and it is not about this machine's tools
 * (#695). A host that expects the deputy to carry its automation cannot have
 * the SIDECAR, because both of its hops shell out and the broker's lint refuses
 * every script that does — but from helpers 1.4.0 it can have the observer
 * anyway, hosted in the deputy (DEPOBS1). EXPECTED, not merely active, is the
 * right question: when the deputy is expected but not carrying traffic the
 * osascript seam REFUSES rather than running direct (#620, src/deputy/osa.ts),
 * so there is no configuration where an expected deputy still executes an
 * acting script locally.
 *
 * THE SIDECAR GATE is exactly the one VOPAT1's rig used: the Command Line Tools
 * are what put `python3` on the PATH, and `xcode-select -p` is the prompt-free
 * question that says whether they are installed. Memoized — the answer cannot
 * change inside one process — and the memo covers ONLY that tool probe, because
 * routing is a per-process decision of its own with its own test seam.
 *
 * EVERY BRANCH IS PROMPT-FREE. The routed branch reads the handshake the
 * activation already performed (config, a socket, a token) and asks the deputy
 * nothing new; the direct branch runs two `--version`-shaped probes. Nothing
 * here can raise a consent dialog, which is what lets a `doctor` on a broken
 * machine report the transport truthfully (permissions doctrine, Article II).
 */
export async function observerTransport(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ObserverTransportChoice> {
  if (observerDisabled(env)) {
    return { transport: "none", why: `switched off by ${OBSERVER_ENV}` };
  }
  if (deputyExpected(env)) return routedObserverTransport(env);
  if (availability !== null) return availability;
  if (!(await which("/usr/bin/xcode-select", ["-p"]))) {
    availability = {
      transport: "none",
      why: "the Command Line Tools are not installed (xcode-select -p)",
    };
    return availability;
  }
  if (!(await which("/usr/bin/python3", ["-c", "import ctypes,socketserver"]))) {
    availability = { transport: "none", why: "/usr/bin/python3 cannot load ctypes" };
    return availability;
  }
  availability = { transport: "sidecar", why: "" };
  return availability;
}

/**
 * The routed host's answer: the deputy hosts the observer, or it does not and
 * the drive runs the certified polling settles.
 *
 * A helper that predates 1.4.0 advertises no `observer` capability, and that is
 * the whole compatibility story — no version arithmetic, no shim. The remedy is
 * named in the reason, because the person who will read it in a trace is the
 * one who can act on it.
 */
function routedObserverTransport(env: NodeJS.ProcessEnv): ObserverTransportChoice {
  const routing = deputyRouting(env);
  if (!routing.active) {
    return {
      transport: "none",
      why: `deputy-routed, but routing is not active (${routing.reason ?? "unknown"})`,
    };
  }
  if (!deputyHostsObserver(routing.hello)) {
    return {
      transport: "none",
      why:
        `deputy-routed: the installed helpers (v${routing.hello?.deputyVersion ?? "?"}) do not host ` +
        "the settle observer — rebuild with `bash scripts/build-helpers.sh`, then " +
        "`things helpers install`",
    };
  }
  if (routing.hello?.axTrusted === false) {
    return {
      transport: "none",
      why: "deputy-routed: the helper is not trusted for the Accessibility API (`things helpers setup`)",
    };
  }
  return { transport: "deputy", why: "" };
}

/* ------------------------------------------------------------- transport */

export function observerDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "observer");
}

/**
 * Where the sidecar source is materialized. The name carries a hash of the
 * source, so a package upgrade writes a NEW file rather than racing a running
 * sidecar's inode, and an unchanged package rewrites nothing.
 */
export function observerScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256").update(OBSERVER_PY).digest("hex").slice(0, 12);
  return join(observerDir(env), `ax-observer-${hash}.py`);
}

/** One request/response over the sidecar's socket. Never throws. */
function request(session: SidecarSession, line: string, timeoutMs: number): Promise<Reply | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const finish = (reply: Reply | null): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(reply);
    };
    const sock = createConnection({ path: session.socketPath });
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on("error", () => finish(null));
    sock.on("connect", () => sock.write(`${line}\n`));
    sock.on("data", (chunk) => {
      buf += String(chunk);
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(parseReply(buf.slice(0, nl)));
    });
    sock.on("close", () => finish(buf.trim() === "" ? null : parseReply(buf.trim())));
  });
}

/** `ok seq=3 lat=5.1` → `{ ok: true, fields: { seq: "3", lat: "5.1" } }`. */
export function parseReply(line: string): Reply | null {
  const parts = line.trim().split(/\s+/);
  const head = parts.shift();
  if (head !== "ok" && head !== "err") return null;
  const fields: Record<string, string> = {};
  for (const kv of parts) {
    const at = kv.indexOf("=");
    if (at > 0) fields[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return { ok: head === "ok", fields };
}

/* -------------------------------------------------------------- lifecycle */

/**
 * The AppleScript that spawns the sidecar. It reads the Things pid itself (the
 * only thing it needs System Events for) and backgrounds `python3` from inside
 * the hop, so the sidecar inherits the hop's Accessibility identity.
 *
 * Readiness is NOT read back from stdout: the sidecar's proof of life is its
 * socket answering the handshake, which is the thing the driver actually needs
 * to be true. Everything the sidecar says goes to its log, which is what a
 * failed handshake reports.
 */
export function observerSpawnScript(
  scriptPath: string,
  socketPath: string,
  token: string,
  logPath: string,
  ttlMs: number = SIDECAR_TTL_MS,
  idleMs: number = SIDECAR_IDLE_MS,
): string {
  const py = escapeAppleScript(scriptPath);
  const sock = escapeAppleScript(socketPath);
  const log = escapeAppleScript(logPath);
  const tok = escapeAppleScript(token);
  return `set pidNum to 0
try
	tell application "System Events" to set pidNum to unix id of first application process whose name is "Things3"
end try
if pidNum is 0 then return "no-process"
set cmd to "/usr/bin/python3 " & quoted form of "${py}" & " --socket " & quoted form of "${sock}" & " --token " & quoted form of "${tok}" & " --pid " & pidNum & " --ttl-ms ${Math.trunc(ttlMs)} --idle-ms ${Math.trunc(idleMs)} >> " & quoted form of "${log}" & " 2>&1 </dev/null &"
tell current application to do shell script cmd
return "spawned pid=" & pidNum`;
}

/** A runner shaped like the vector's dispatch seam, so the spawn hop is routed. */
export type SpawnRunner = (
  command: { primitive: "observer-spawn"; label: string; script: string },
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Materialize the sidecar and hand back a live session, or null.
 *
 * NULL IS NEVER A REFUSAL. Every reason this can fail — no Command Line Tools,
 * no Things process, a socket that will not answer — leaves the drive on the
 * certified polling settles, with one trace record saying which reason it was.
 */
export async function startObserver(
  run: SpawnRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ObserverSession | null> {
  const choice = await observerTransport(env);
  if (choice.transport === "none") {
    trace(() => ({ phase: "ui-observer", event: "unavailable", why: choice.why }));
    return null;
  }
  if (choice.transport === "deputy") return startDeputyObserver();
  const dir = observerDir(env);
  const token = randomBytes(16).toString("hex");
  const socketPath = join(dir, `s-${token.slice(0, 8)}.sock`);
  const logPath = join(dir, "observer.log");
  const scriptPath = observerScriptPath(env);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(scriptPath, OBSERVER_PY, { mode: 0o600 });
    await chmod(dir, 0o700);
  } catch (err) {
    trace(() => ({ phase: "ui-observer", event: "unwritable", why: String(err) }));
    return null;
  }
  const started = Date.now();
  const res = await run(
    {
      primitive: "observer-spawn",
      label: "arm the AX settle observer",
      script: observerSpawnScript(scriptPath, socketPath, token, logPath),
    },
    10_000,
  );
  if (!res.ok || res.stdout.trim() === "no-process") {
    trace(() => ({
      phase: "ui-observer",
      event: "spawn-failed",
      why: res.stdout.trim() === "no-process" ? "Things is not running" : res.stderr.trim(),
    }));
    return null;
  }
  const session: SidecarSession = {
    transport: "sidecar",
    socketPath,
    token,
    logPath,
    registered: "?",
    pid: 0,
  };
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  for (;;) {
    const reply = await request(session, `${token} hello`, 1_000);
    if (reply !== null && reply.ok) {
      session.registered = reply.fields["reg"] ?? "?";
      session.pid = Number.parseInt(reply.fields["pid"] ?? "0", 10) || 0;
      trace(() => ({
        phase: "ui-observer",
        event: "armed",
        transport: "sidecar",
        registered: session.registered,
        sidecarPid: session.pid,
        armMs: Date.now() - started,
      }));
      return session;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, HANDSHAKE_POLL_MS));
  }
  let why = "the sidecar's socket never answered";
  try {
    const log = await readFile(logPath, "utf8");
    const last = log.trim().split(/\r?\n/).pop();
    if (last !== undefined && last !== "") why = last;
  } catch {
    /* no log is its own answer */
  }
  trace(() => ({ phase: "ui-observer", event: "handshake-failed", why }));
  return null;
}

/**
 * Arm the DEPUTY's observer: one socket round-trip, no process to spawn and no
 * osascript hop at all — the deputy resolves Things' pid itself (prompt-free,
 * from the session it lives in) and registers on the application element.
 *
 * NULL IS NEVER A REFUSAL here either. Things not running, an Accessibility
 * grant the helper does not hold, a session cap already reached: each arrives as
 * a typed protocol error, is traced by its own message, and leaves the drive on
 * the certified polling settles.
 */
async function startDeputyObserver(): Promise<DeputySession | null> {
  const started = Date.now();
  try {
    const res = (await deputyAsyncRequest(
      { verb: "observer-start" },
      OBSERVER_REQUEST_MS,
    )) as unknown as DeputyObserverStart;
    const session: DeputySession = {
      transport: "deputy",
      token: res.observer,
      registered: `${res.registered}/${res.asked}`,
      pid: res.pid,
    };
    trace(() => ({
      phase: "ui-observer",
      event: "armed",
      transport: "deputy",
      registered: session.registered,
      thingsPid: session.pid,
      armMs: Date.now() - started,
    }));
    return session;
  } catch (err) {
    trace(() => ({
      phase: "ui-observer",
      event: "start-failed",
      transport: "deputy",
      why: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

/**
 * One observer round-trip to the deputy. Never throws: every failure — a
 * reaped session, a stopped helper, a deadline — becomes null, which every
 * caller already treats as "no observer answer" and falls through on.
 */
async function deputyObserverRequest(
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await deputyAsyncRequest(fields, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Ask the observer to stand down, and say honestly whether it answered. Called
 * from the drive's `finally`; the sidecar's TTL/idle timeout and the deputy's
 * own idle reaper are what cover the case where this never runs at all.
 */
export async function stopObserver(session: ObserverSession): Promise<boolean> {
  const acknowledged =
    session.transport === "deputy"
      ? (await deputyObserverRequest(
          { verb: "observer-stop", observer: session.token },
          OBSERVER_REQUEST_MS,
        )) !== null
      : await (async () => {
          const reply = await request(session, `${session.token} stop`, 1_000);
          return reply !== null && reply.ok;
        })();
  trace(() => ({
    phase: "ui-observer",
    event: "stopped",
    transport: session.transport,
    acknowledged,
    ...(session.transport === "sidecar" ? { sidecarPid: session.pid } : {}),
  }));
  return acknowledged;
}

/** The ledger's current sequence — the point an actuation is about to happen at. */
export async function observerMark(session: ObserverSession): Promise<number | null> {
  if (session.transport === "deputy") {
    const res = await deputyObserverRequest(
      { verb: "observer-mark", observer: session.token },
      OBSERVER_REQUEST_MS,
    );
    const seq = res === null ? Number.NaN : Number(res["seq"]);
    return Number.isFinite(seq) ? seq : null;
  }
  const reply = await request(session, `${session.token} mark`, 1_000);
  if (reply === null || !reply.ok) return null;
  const seq = Number.parseInt(reply.fields["seq"] ?? "", 10);
  return Number.isFinite(seq) ? seq : null;
}

/**
 * HOW MUCH HAS THE APP SAID SINCE `since`? Non-blocking, and meaningful only
 * because Things is silent when nothing happens (VOPAT1-6): zero arrivals since
 * the mark taken before a step means that step ACTUATED NOTHING — it found the
 * control already holding the value it was going to set, opened no menu and
 * changed no state. A settle waiting for the consequence of a change that never
 * happened is waiting for nothing, and this is how it finds that out for free.
 */
export async function observerCount(
  session: ObserverSession,
  since: number,
): Promise<number | null> {
  if (session.transport === "deputy") {
    // A WAIT WITH NOTHING TO WAIT FOR is the count: no matcher and no budget, so
    // the deputy reports what has landed since the cursor and returns. One
    // message fewer to implement, certify and keep in step across the seam.
    const res = await deputyObserverRequest(
      { verb: "observer-wait", observer: session.token, after: since, want: [], timeoutMs: 0 },
      OBSERVER_REQUEST_MS,
    );
    const seen = res === null ? Number.NaN : Number(res["seen"]);
    return Number.isFinite(seen) ? seen : null;
  }
  const reply = await request(session, `${session.token} count since=${since}`, 1_000);
  if (reply === null || !reply.ok) return null;
  const seen = Number.parseInt(reply.fields["seen"] ?? "", 10);
  return Number.isFinite(seen) ? seen : null;
}

function awaitLine(token: string, since: number, spec: SettleSpec): string {
  const parts = [
    token,
    "await",
    `since=${since}`,
    `want=${spec.want.join(",")}`,
    `timeout=${Math.trunc(spec.timeoutMs)}`,
  ];
  if (spec.require !== undefined && spec.require.length > 0) {
    parts.push(`require=${spec.require.join(",")}`);
  }
  if (spec.quietMs !== undefined && spec.quietMs > 0)
    parts.push(`quiet=${Math.trunc(spec.quietMs)}`);
  return parts.join(" ");
}

/** The deputy's ledger, awaited over the socket routing already holds. */
async function deputyAwait(
  session: DeputySession,
  since: number,
  spec: SettleSpec,
): Promise<SettleOutcome> {
  const res = (await deputyObserverRequest(
    {
      verb: "observer-wait",
      observer: session.token,
      after: since,
      want: spec.want,
      ...(spec.require !== undefined && spec.require.length > 0 && { all: spec.require }),
      ...(spec.quietMs !== undefined && spec.quietMs > 0 && { quietMs: Math.trunc(spec.quietMs) }),
      timeoutMs: Math.trunc(spec.timeoutMs),
    },
    spec.timeoutMs + REQUEST_GRACE_MS,
  )) as unknown as DeputyObserverWait | null;
  if (res === null) {
    return {
      ok: false,
      reason: "the settle observer stopped answering",
      waitedMs: 0,
      seen: 0,
      seq: since,
    };
  }
  return res.timedOut
    ? {
        ok: false,
        reason: "timeout",
        waitedMs: res.waitedMs,
        seen: res.seen,
        seq: res.seq,
      }
    : {
        ok: true,
        latencyMs: res.latencyMs ?? 0,
        fired: res.fired ?? "?",
        hits: res.hits ?? 0,
        seq: res.seq,
      };
}

/** The sidecar's ledger, awaited over its own socket. */
async function sidecarAwait(
  session: SidecarSession,
  since: number,
  spec: SettleSpec,
): Promise<SettleOutcome> {
  const reply = await request(
    session,
    awaitLine(session.token, since, spec),
    spec.timeoutMs + REQUEST_GRACE_MS,
  );
  if (reply === null) {
    return {
      ok: false,
      reason: "the settle observer stopped answering",
      waitedMs: 0,
      seen: 0,
      seq: since,
    };
  }
  return reply.ok
    ? {
        ok: true,
        latencyMs: Number.parseFloat(reply.fields["lat"] ?? "0") || 0,
        fired: reply.fields["fired"] ?? "?",
        hits: Number.parseInt(reply.fields["hits"] ?? "0", 10) || 0,
        seq: Number.parseInt(reply.fields["seq"] ?? "0", 10) || since,
      }
    : {
        ok: false,
        reason: reply.fields["reason"] ?? "unknown",
        waitedMs: Number.parseFloat(reply.fields["waited"] ?? "0") || 0,
        seen: Number.parseInt(reply.fields["seen"] ?? "0", 10) || 0,
        seq: Number.parseInt(reply.fields["seq"] ?? "0", 10) || since,
      };
}

/** Block until the app announces, or until the settle's own budget is spent. */
export async function observerAwait(
  session: ObserverSession,
  since: number,
  spec: SettleSpec,
): Promise<SettleOutcome> {
  const outcome =
    session.transport === "deputy"
      ? await deputyAwait(session, since, spec)
      : await sidecarAwait(session, since, spec);
  trace(() => ({
    phase: "ui-settle",
    transport: session.transport,
    what: spec.what,
    want: spec.want.join(","),
    ...(spec.require !== undefined &&
      spec.require.length > 0 && { require: spec.require.join(",") }),
    timeoutMs: spec.timeoutMs,
    ok: outcome.ok,
    ...(outcome.ok
      ? { latencyMs: outcome.latencyMs, fired: outcome.fired, hits: outcome.hits }
      : { reason: outcome.reason, waitedMs: outcome.waitedMs, seen: outcome.seen }),
  }));
  return outcome;
}

/**
 * The refusal an armed settle raises when the app never announced. Names the
 * observable, the budget, and the switch that turns the whole mechanism off —
 * so an operator whose Mac does not post a notification this driver expects has
 * a one-line remedy rather than a mystery.
 */
export function settleRefusal(spec: SettleSpec, outcome: SettleOutcome): string {
  const detail = outcome.ok
    ? ""
    : outcome.reason === "timeout"
      ? `after ${Math.round(outcome.waitedMs)}ms (${outcome.seen} unrelated notification(s) arrived)`
      : `(${outcome.reason})`;
  return (
    `Things never announced ${spec.what} — the drive waits for the app's own ` +
    `${spec.want.join(" or ")} notification and it did not arrive ${detail}. Nothing further was ` +
    `sent. If this Mac's Things build does not post it, set ${OBSERVER_ENV}=0 to fall back to the ` +
    "polling settles and re-run the same command."
  );
}

/* ---------------------------------------------------- in-script settling */

/**
 * The settle injector a script generator uses. With no sidecar every method
 * returns exactly the text that shipped before this campaign, so the polling
 * fallback is byte-identical rather than merely equivalent.
 */
export interface SettleInjector {
  /** True when a sidecar is live and the snippets below actually settle on a notification. */
  readonly live: boolean;
  /** The AppleScript handlers the snippets need, or "" when there is no sidecar. */
  handlers(): string;
  /** Record the ledger's sequence into `varName` before an actuation. */
  mark(varName: string, indent: string): string;
  /**
   * HARD settle: block until the app announces, and RAISE the named refusal when
   * it does not. For a step whose surface has no other oracle.
   */
  settle(varName: string, spec: SettleSpec, indent: string): string;
  /**
   * SOFT settle: block until the app announces, and carry on when it does not.
   * For a step that already carries its own certified closed loop — the
   * `exists menu 1` retry, the `focused` assertion, the value read-back. There
   * the notification's job is to make the wait END EARLY and stop the loop being
   * sized by a fixed delay; the loop itself is still what refuses, in its own
   * words. The miss is recorded in the trace either way.
   */
  soft(varName: string, spec: SettleSpec, indent: string): string;
}

const inertDelay = (spec: SettleSpec, indent: string): string =>
  spec.fallbackDelayS === undefined ? "" : `${indent}delay ${spec.fallbackDelayS}`;

const INERT: SettleInjector = {
  live: false,
  handlers: () => "",
  mark: () => "",
  settle: (_v, spec, indent) => inertDelay(spec, indent),
  soft: (_v, spec, indent) => inertDelay(spec, indent),
};

/** The no-sidecar injector: every generated script is the polling one, verbatim. */
export function inertSettleInjector(): SettleInjector {
  return INERT;
}

/**
 * The in-script client, as AppleScript. One `do shell script` per request,
 * `printf | nc -U` as the transport — the smallest thing on a stock macOS that
 * can hold a blocking connection open. `nc`'s idle timeout is set past the
 * settle's own budget so the settle, not the transport, is what expires.
 *
 * `do shell script` is addressed to `current application` deliberately: inside
 * a `tell application "System Events"` block it would become an Apple event to
 * System Events, i.e. exactly the round-trip this campaign is removing.
 */
export function settleInjectorFor(session: ObserverSession | null): SettleInjector {
  // A DEPUTY-HOSTED SESSION GETS THE INERT INJECTOR, and that is not an
  // oversight (DEPOBS1). The in-script client below reaches its socket through
  // `do shell script`, which is the exact phrase the broker refuses — so on a
  // routed host every generated script must come out byte-identically to the
  // polling version, whether or not node has an observer of its own. The
  // routed transport carries the settles NODE makes; the in-script waits stay
  // polls until they have a transport a broker will pass.
  //
  // This is also what keeps the four certified quadrants intact (#698,
  // DEFAULTS3): {observer up/down} × {pre-fill on/off} are certified against
  // exactly two script shapes, and a routed drive produces the polling one.
  if (session === null || session.transport === "deputy") return INERT;
  const sock = escapeAppleScript(session.socketPath);
  const token = escapeAppleScript(session.token);
  return {
    live: true,
    handlers: () => `on obsReq(payload, waitSecs)
	-- ONE request/response over the settle sidecar's socket. No AX call, no Apple
	-- event, no content read: the app has already said what happened and this
	-- collects it.
	set shellCmd to "/usr/bin/printf '%s\\\\n' " & quoted form of payload & " | /usr/bin/nc -U -w " & waitSecs & " " & quoted form of "${sock}"
	try
		tell current application to return do shell script shellCmd
	on error
		return "err reason=transport"
	end try
end obsReq

on obsMark()
	set r to my obsReq("${token} mark", 5)
	if r starts with "ok seq=" then return (text 8 thru -1 of r) as integer
	return -1
end obsMark

on obsWait(sinceSeq, tail, waitSecs, what)
	-- A mark that never answered (-1) means the sidecar went away mid-hop. There
	-- is nothing to wait for, and the step's own closed loop is still in force,
	-- so this reports and carries on rather than inventing a verdict.
	--
	-- EVERY UNSUCCESSFUL RETURN YIELDS THE BEAT THE POLL WOULD HAVE SPENT. A soft
	-- settle sits inside a retry loop, and an instant "no" would turn that loop
	-- into a click storm — a second click into a menu that is already opening is
	-- exactly what BEEP1 forbids (docs/lab/beep1-numeric-field-beep.md). So a
	-- miss costs at least the 0.05 s the in-script poll used to cost, whether it
	-- came from a spent budget, a dead sidecar or a transport error.
	if sinceSeq is -1 then
		delay 0.05
		return "err reason=nomark"
	end if
	set r to my obsReq("${token} await since=" & sinceSeq & tail, waitSecs)
	log "${AX_SETTLE_LOG_PREFIX}" & what & " ~ " & r
	if r does not start with "ok " then delay 0.05
	return r
end obsWait

on obsSettle(sinceSeq, tail, waitSecs, what)
	set r to my obsWait(sinceSeq, tail, waitSecs, what)
	if r starts with "ok " then return r
	error "Things never announced " & what & " — the drive waits for the app's own notification and it did not arrive (" & r & "). Nothing further was sent. If this Mac's Things build does not post it, set ${OBSERVER_ENV}=0 to fall back to the polling settles and re-run the same command."
end obsSettle`,
    mark: (varName, indent) => `${indent}set ${varName} to my obsMark()`,
    settle: (varName, spec, indent) => call("obsSettle", varName, spec, indent),
    soft: (varName, spec, indent) => call("obsWait", varName, spec, indent),
  };
}

/** `my obsWait(obsSeq, " want=… timeout=…", 5, "the menu to open")` */
function call(handler: string, varName: string, spec: SettleSpec, indent: string): string {
  // The transport's own idle timeout sits PAST the settle's budget, so what
  // expires is the settle (with its named reason) and never `nc`.
  const budget = Math.max(2, Math.ceil(spec.timeoutMs / 1000) + 2);
  return `${indent}my ${handler}(${varName}, "${escapeAppleScript(
    awaitTail(spec),
  )}", ${budget}, "${escapeAppleScript(spec.what)}")`;
}

/**
 * The part of an `await` request that follows the sequence number. Split out so
 * the AppleScript concatenates the live sequence into the middle of the line
 * without having to build the whole request itself.
 */
function awaitTail(spec: SettleSpec): string {
  const parts = [` want=${spec.want.join(",")}`, ` timeout=${Math.trunc(spec.timeoutMs)}`];
  if (spec.require !== undefined && spec.require.length > 0) {
    parts.push(` require=${spec.require.join(",")}`);
  }
  if (spec.quietMs !== undefined && spec.quietMs > 0) {
    parts.push(` quiet=${Math.trunc(spec.quietMs)}`);
  }
  return parts.join("");
}

/**
 * Pull every `#AXSETTLE` line out of a hop's stderr and REMOVE them — a refusal
 * a caller reads must never carry the machinery (the `#AXELEMS` rule, RDLAT2
 * §E.1). Each record is `<what> ~ <reply line>`.
 */
export function parseSettleLog(stderr: string): { settles: string[]; stderr: string } {
  const kept: string[] = [];
  const settles: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const at = line.indexOf(AX_SETTLE_LOG_PREFIX);
    if (at >= 0) {
      settles.push(line.slice(at + AX_SETTLE_LOG_PREFIX.length).trim());
      continue;
    }
    kept.push(line);
  }
  return { settles, stderr: kept.join("\n").trim() };
}
