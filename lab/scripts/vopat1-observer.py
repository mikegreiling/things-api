#!/usr/bin/env python3
"""VOPAT1 — the AXObserver rig: do Accessibility NOTIFICATIONS replace polling?

A screen reader does not poll. It registers for notifications and is TOLD when
the tree changed. Our drivers poll: every settle re-reads the surface until two
reads agree, and every one of those reads costs ~115 ms per row realized on the
maintainer's M1 (the field law, docs/up-next.md). If a notification fires for the
actuations our drivers make, a settle can wait on the notification instead and
pay ZERO content reads while waiting.

This program answers that empirically. It registers an AXObserver on one or more
elements, runs a CFRunLoop, performs ONE actuation at a recorded t0, and reports
every notification that arrived with its latency from t0. A notification class
that does NOT fire for a given actuation is a LAW, and is reported as such.

WHY ctypes AND NOT JXA. AXObserverCreate takes a C FUNCTION POINTER
(AXObserverCallback). JXA's ObjC bridge can marshal blocks but not raw C
function pointers, so the observer cannot be built from JXA at all. ctypes'
CFUNCTYPE produces a real function pointer, and the stdlib is already the
transport the field probe's native-latency cell uses (lab/scripts/
field-probe-sidebar.jxa.js path B), so nothing new has to be installed on a
guest or on the maintainer's Mac.

usage:
  python3 vopat1-observer.py <pid> <targets-json> <timeout-ms> [actuation]

  <targets-json>  [{"label":"table","path":[1,9,1],"notifications":["AXRowCountChanged",…]}, …]
                  `path` is a child-index path from the APPLICATION element, the
                  same address the field probe's native cell uses; [] is the
                  application element itself.
  [actuation]     one of
                    none                        register and wait, actuate nothing
                    cg-click:<x>,<y>            one left click at screen point
                    cg-altclick:<x>,<y>         one option-click
                    ax-press:<i,j,k>            AXPress on the element at that path
                    ax-setnum:<i,j,k>=<float>   set AXValue (a number) on that element
                    ax-focus:<i,j,k>            set AXFocused on that element
                    key:<keycode>[,<flags>]     one key down/up
                    cmd:<shell command>         run a command (its spawn cost is
                                                reported separately so the
                                                latency can be read honestly)

Output is one JSON object on stdout. It carries counts, AX role strings,
notification-name strings and millisecond timings ONLY — never a title, a note,
or any other text from the database.
"""

import ctypes
import json
import subprocess
import sys
import time
from ctypes import (
    CFUNCTYPE,
    POINTER,
    byref,
    c_char_p,
    c_double,
    c_float,
    c_int,
    c_int32,
    c_long,
    c_uint32,
    c_void_p,
)


class CGPoint(ctypes.Structure):
    # A CGPoint is passed BY VALUE. Declaring it as an array of two doubles
    # would pass a POINTER instead, and every synthesized click would land at
    # a garbage coordinate -- silently, because CGEventPost reports nothing.
    _fields_ = [("x", c_double), ("y", c_double)]

UTF8 = 0x08000100  # kCFStringEncodingUTF8

AS = ctypes.CDLL(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
)
CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
CG = ctypes.CDLL(
    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
)

# Every restype/argtype is declared. A missing restype on a 64-bit pointer return
# silently truncates to a 32-bit int -- the classic ctypes+AX bug, and the one
# that would make this whole program report a plausible-looking nothing.
AS.AXUIElementCreateApplication.restype = c_void_p
AS.AXUIElementCreateApplication.argtypes = [c_int]
AS.AXUIElementCopyAttributeValue.restype = c_int
AS.AXUIElementCopyAttributeValue.argtypes = [c_void_p, c_void_p, POINTER(c_void_p)]
AS.AXUIElementSetAttributeValue.restype = c_int
AS.AXUIElementSetAttributeValue.argtypes = [c_void_p, c_void_p, c_void_p]
AS.AXUIElementPerformAction.restype = c_int
AS.AXUIElementPerformAction.argtypes = [c_void_p, c_void_p]
AS.AXUIElementCopyElementAtPosition.restype = c_int
AS.AXUIElementCopyElementAtPosition.argtypes = [
    c_void_p,
    c_float,
    c_float,
    POINTER(c_void_p),
]
AS.AXUIElementSetMessagingTimeout.restype = c_int
AS.AXUIElementSetMessagingTimeout.argtypes = [c_void_p, c_float]
AS.AXIsProcessTrusted.restype = ctypes.c_bool

AS.AXObserverCreate.restype = c_int
# (pid, callback, AXObserverRef*) -- callback is declared below, after CALLBACK.
AS.AXObserverAddNotification.restype = c_int
AS.AXObserverAddNotification.argtypes = [c_void_p, c_void_p, c_void_p, c_void_p]
AS.AXObserverGetRunLoopSource.restype = c_void_p
AS.AXObserverGetRunLoopSource.argtypes = [c_void_p]

CF.CFStringCreateWithCString.restype = c_void_p
CF.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
CF.CFStringGetCString.restype = c_int
CF.CFStringGetCString.argtypes = [c_void_p, c_char_p, c_long, c_uint32]
CF.CFArrayGetCount.restype = c_long
CF.CFArrayGetCount.argtypes = [c_void_p]
CF.CFArrayGetValueAtIndex.restype = c_void_p
CF.CFArrayGetValueAtIndex.argtypes = [c_void_p, c_long]
CF.CFRelease.restype = None
CF.CFRelease.argtypes = [c_void_p]
CF.CFRunLoopGetCurrent.restype = c_void_p
CF.CFRunLoopGetCurrent.argtypes = []
CF.CFRunLoopAddSource.restype = None
CF.CFRunLoopAddSource.argtypes = [c_void_p, c_void_p, c_void_p]
CF.CFRunLoopRunInMode.restype = c_int32
CF.CFRunLoopRunInMode.argtypes = [c_void_p, c_double, ctypes.c_bool]
CF.CFNumberCreate.restype = c_void_p
CF.CFNumberCreate.argtypes = [c_void_p, c_int, c_void_p]

CG.CGEventCreateMouseEvent.restype = c_void_p
CG.CGEventCreateMouseEvent.argtypes = [c_void_p, c_uint32, CGPoint, c_uint32]
CG.CGEventCreateKeyboardEvent.restype = c_void_p
CG.CGEventCreateKeyboardEvent.argtypes = [c_void_p, ctypes.c_uint16, ctypes.c_bool]
CG.CGEventPost.restype = None
CG.CGEventPost.argtypes = [c_uint32, c_void_p]
CG.CGEventSetFlags.restype = None
CG.CGEventSetFlags.argtypes = [c_void_p, ctypes.c_uint64]
CG.CGEventSetIntegerValueField.restype = None
CG.CGEventSetIntegerValueField.argtypes = [c_void_p, c_uint32, ctypes.c_int64]

kCFRunLoopDefaultMode = c_void_p.in_dll(CF, "kCFRunLoopDefaultMode")

kCFNumberDoubleType = 13
kCGHIDEventTap = 0
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGMouseEventClickState = 1
kCGEventFlagMaskAlternate = 0x00080000

# kCFBooleanTrue, for AXFocused. A CFBoolean is a singleton, so it is fetched
# once from CoreFoundation rather than constructed.
TRUE_REF = c_void_p.in_dll(CF, "kCFBooleanTrue")


def cfstr(s):
    return c_void_p(CF.CFStringCreateWithCString(None, s.encode("utf-8"), UTF8))


def pystr(ref):
    if not ref:
        return ""
    buf = ctypes.create_string_buffer(512)
    if CF.CFStringGetCString(ref, buf, 512, UTF8):
        return buf.value.decode("utf-8", "replace")
    return ""


_KEYS = {}


def key(name):
    if name not in _KEYS:
        _KEYS[name] = cfstr(name)
    return _KEYS[name]


def copyattr(el, name):
    out = c_void_p()
    err = AS.AXUIElementCopyAttributeValue(el, key(name), byref(out))
    return err, out


def role_of(el):
    err, v = copyattr(el, "AXRole")
    if err != 0 or not v.value:
        return ""
    s = pystr(v)
    CF.CFRelease(v)
    return s


# Child arrays are kept alive for the process's whole life: elements pulled out
# of them with CFArrayGetValueAtIndex are BORROWED, so releasing the array could
# free the element out from under the observer. Nothing borrowed is released.
KEEP = []


def walk(app, path):
    el = app
    for step, idx in enumerate(path):
        err, arr = copyattr(el, "AXChildren")
        if err != 0 or not arr.value:
            return None, "AXChildren failed at step %d (AXError %d)" % (step, err)
        KEEP.append(arr)
        cnt = CF.CFArrayGetCount(arr)
        if idx < 0 or idx >= cnt:
            return None, "child index %d out of range %d at step %d" % (idx, cnt, step)
        el = c_void_p(CF.CFArrayGetValueAtIndex(arr, idx))
        if not el.value:
            return None, "NULL child at step %d" % step
    return el, None


# ------------------------------------------------------------------ actuation


def _mouse(kind, x, y, click_state=0, flags=0):
    ev = CG.CGEventCreateMouseEvent(None, kind, CGPoint(x, y), 0)
    if click_state:
        CG.CGEventSetIntegerValueField(ev, kCGMouseEventClickState, click_state)
    CG.CGEventSetFlags(ev, flags)
    CG.CGEventPost(kCGHIDEventTap, ev)
    CF.CFRelease(ev)


def click_at(x, y, flags=0):
    # The 300 ms MOVED settle is REPX1 1.2's certified rig law: a press that
    # arrives in the same instant as the move lands on the view the pointer was
    # leaving. It is INSIDE the actuation, so it is inside t0..t1 and shows up in
    # `actuationMs` rather than being mistaken for notification latency.
    _mouse(kCGEventMouseMoved, x, y)
    time.sleep(0.30)
    _mouse(kCGEventLeftMouseDown, x, y, 1, flags)
    time.sleep(0.09)
    _mouse(kCGEventLeftMouseUp, x, y, 1, flags)


def press_key(code, flags=0):
    down = CG.CGEventCreateKeyboardEvent(None, code, True)
    CG.CGEventSetFlags(down, flags)
    CG.CGEventPost(kCGHIDEventTap, down)
    CF.CFRelease(down)
    up = CG.CGEventCreateKeyboardEvent(None, code, False)
    CG.CGEventSetFlags(up, flags)
    CG.CGEventPost(kCGHIDEventTap, up)
    CF.CFRelease(up)


def actuate(app, spec):
    """Perform one actuation, and describe it. Never raises."""
    if spec in ("", "none"):
        return {"kind": "none"}
    kind, _, rest = spec.partition(":")
    try:
        if kind in ("cg-click", "cg-altclick"):
            xs, _, ys = rest.partition(",")
            flags = kCGEventFlagMaskAlternate if kind == "cg-altclick" else 0
            click_at(float(xs), float(ys), flags)
            return {"kind": kind, "at": [float(xs), float(ys)]}
        if kind == "ax-press":
            el, why = walk(app, [int(x) for x in rest.split(",") if x != ""])
            if el is None:
                return {"kind": kind, "ok": False, "why": why}
            err = AS.AXUIElementPerformAction(el, key("AXPress"))
            return {"kind": kind, "ok": err == 0, "axError": err}
        if kind == "ax-setnum":
            addr, _, val = rest.partition("=")
            el, why = walk(app, [int(x) for x in addr.split(",") if x != ""])
            if el is None:
                return {"kind": kind, "ok": False, "why": why}
            d = c_double(float(val))
            num = c_void_p(CF.CFNumberCreate(None, kCFNumberDoubleType, byref(d)))
            err = AS.AXUIElementSetAttributeValue(el, key("AXValue"), num)
            CF.CFRelease(num)
            return {"kind": kind, "ok": err == 0, "axError": err, "value": float(val)}
        if kind == "ax-focus":
            el, why = walk(app, [int(x) for x in rest.split(",") if x != ""])
            if el is None:
                return {"kind": kind, "ok": False, "why": why}
            err = AS.AXUIElementSetAttributeValue(el, key("AXFocused"), TRUE_REF)
            return {"kind": kind, "ok": err == 0, "axError": err}
        if kind == "key":
            parts = rest.split(",")
            press_key(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
            return {"kind": kind, "code": int(parts[0])}
        if kind == "cmd":
            t = time.perf_counter()
            proc = subprocess.run(
                ["/bin/sh", "-c", rest], capture_output=True, text=True, timeout=30
            )
            return {
                "kind": kind,
                "exit": proc.returncode,
                "spawnMs": round((time.perf_counter() - t) * 1000, 1),
                "note": "spawnMs is INSIDE the measured latency; subtract it to "
                "read the app's own response time",
            }
    except Exception as exc:  # noqa: BLE001 - a probe reports, it does not crash
        return {"kind": kind, "ok": False, "why": "%s: %s" % (type(exc).__name__, exc)}
    return {"kind": kind, "ok": False, "why": "unknown actuation"}


# ------------------------------------------------------------------- observer

EVENTS = []
T0 = [None]


def _on_notification(observer, element, notification, refcon):
    now = time.perf_counter()
    t0 = T0[0]
    EVENTS.append(
        {
            "notification": pystr(notification),
            "role": role_of(element),
            "msFromActuation": None if t0 is None else round((now - t0) * 1000, 1),
        }
    )


CALLBACK = CFUNCTYPE(None, c_void_p, c_void_p, c_void_p, c_void_p)(_on_notification)
AS.AXObserverCreate.argtypes = [c_int, type(CALLBACK), POINTER(c_void_p)]


def main():
    if len(sys.argv) < 4:
        return {"ok": False, "why": "usage: <pid> <targets-json> <timeout-ms> [actuation]"}
    pid = int(sys.argv[1])
    targets = json.loads(sys.argv[2])
    timeout_ms = int(sys.argv[3])
    spec = sys.argv[4] if len(sys.argv) > 4 else "none"

    if not AS.AXIsProcessTrusted():
        return {
            "ok": False,
            "why": "this process is not trusted for the Accessibility API; grant the "
            "terminal (or the lab's ssh session) Accessibility and retry",
        }

    app = c_void_p(AS.AXUIElementCreateApplication(pid))
    if not app.value:
        return {"ok": False, "why": "AXUIElementCreateApplication returned NULL"}
    AS.AXUIElementSetMessagingTimeout(app, 5.0)

    obs = c_void_p()
    err = AS.AXObserverCreate(pid, CALLBACK, byref(obs))
    if err != 0 or not obs.value:
        return {"ok": False, "why": "AXObserverCreate failed (AXError %d)" % err}

    registered = []
    for t in targets:
        label = t.get("label", "?")
        path = t.get("path", [])
        el, why = walk(app, path)
        if el is None:
            registered.append({"label": label, "ok": False, "why": why})
            continue
        el_role = role_of(el)
        for name in t.get("notifications", []):
            e = AS.AXObserverAddNotification(obs, el, key(name), None)
            # -25204 kAXErrorNotificationUnsupported, -25205 already registered.
            registered.append(
                {
                    "label": label,
                    "role": el_role,
                    "notification": name,
                    "axError": e,
                    "ok": e == 0,
                }
            )

    src = AS.AXObserverGetRunLoopSource(obs)
    if not src:
        return {"ok": False, "why": "AXObserverGetRunLoopSource returned NULL"}
    CF.CFRunLoopAddSource(CF.CFRunLoopGetCurrent(), src, kCFRunLoopDefaultMode)

    # Drain anything already queued from the registration itself, so the count
    # below is the ACTUATION's notifications and nothing else.
    CF.CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.30, False)
    EVENTS.clear()

    T0[0] = time.perf_counter()
    act = actuate(app, spec)
    actuation_ms = round((time.perf_counter() - T0[0]) * 1000, 1)

    # Pump in short slices so a notification's arrival time is its own, not the
    # end of a long blocking run. `returnAfterSourceHandled` False keeps the loop
    # servicing every source in the slice.
    deadline = T0[0] + timeout_ms / 1000.0
    while time.perf_counter() < deadline:
        CF.CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, False)

    by_name = {}
    for ev in EVENTS:
        n = ev["notification"]
        if n not in by_name:
            by_name[n] = {"count": 0, "firstMs": ev["msFromActuation"], "roles": []}
        by_name[n]["count"] += 1
        if ev["role"] and ev["role"] not in by_name[n]["roles"]:
            by_name[n]["roles"].append(ev["role"])

    asked = sorted({r["notification"] for r in registered if r.get("ok")})
    fired = sorted(by_name.keys())
    return {
        "ok": True,
        "pid": pid,
        "timeoutMs": timeout_ms,
        "actuation": act,
        "actuationMs": actuation_ms,
        "registered": registered,
        "eventCount": len(EVENTS),
        "firstEventMs": EVENTS[0]["msFromActuation"] if EVENTS else None,
        "byNotification": by_name,
        "silent": [n for n in asked if n not in fired],
        "events": EVENTS[:60],
        "note": "msFromActuation is measured from the instant BEFORE the actuation "
        "began, so it includes the actuation's own duration (actuationMs).",
    }


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "why": "%s: %s" % (type(exc).__name__, exc)}))
