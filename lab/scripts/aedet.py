"""AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false), verbatim.

Mirrors deputy/src/tcc.swift: an AECreateDesc of typeApplicationBundleID, then
the determination with typeWildCard for both the event class and the event id
and askUserIfNeeded FALSE. A golden clone has no helper bundle to ask, so this
ctypes replica stands in for the deputy's own probe.

    aedet.py <bundle-id>                        one determination
    aedet.py <bundle-id> poll <bound-ms> <interval-ms>
                                                the shipped closed loop:
                                                re-ask until the target stops
                                                answering procNotFound, bounded,
                                                with no fixed sleep standing in
                                                for the answer

Prints "<status> <label> ..." — the raw OSStatus is what matters; the label is
the deputy's own mapping. Used by SEWAKE1 (System Events) and THWAKE1 (Things).
"""

import ctypes
import sys
import time

TYPE_BUNDLE_ID = 0x62756E64  # 'bund'
TYPE_WILDCARD = 0x2A2A2A2A  # '****'


class AEDesc(ctypes.Structure):
    _fields_ = [("descriptorType", ctypes.c_uint32), ("dataHandle", ctypes.c_void_p)]


def load():
    for path in (
        "/System/Library/Frameworks/CoreServices.framework/CoreServices",
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    ):
        try:
            lib = ctypes.CDLL(path)
            lib.AEDeterminePermissionToAutomateTarget
            return lib
        except (OSError, AttributeError):
            continue
    raise SystemExit("no framework exports AEDeterminePermissionToAutomateTarget")


LABELS = {0: "granted", -1743: "denied", -600: "not-running", -1744: "unknown(never-asked)"}


def determine(lib, bundle_id):
    data = bundle_id.encode()
    desc = AEDesc()
    lib.AECreateDesc.argtypes = [
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_long,
        ctypes.POINTER(AEDesc),
    ]
    lib.AECreateDesc.restype = ctypes.c_int16
    if lib.AECreateDesc(TYPE_BUNDLE_ID, data, len(data), ctypes.byref(desc)) != 0:
        raise SystemExit("AECreateDesc failed")
    lib.AEDeterminePermissionToAutomateTarget.argtypes = [
        ctypes.POINTER(AEDesc),
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_bool,
    ]
    lib.AEDeterminePermissionToAutomateTarget.restype = ctypes.c_int32
    started = time.monotonic()
    status = lib.AEDeterminePermissionToAutomateTarget(
        ctypes.byref(desc), TYPE_WILDCARD, TYPE_WILDCARD, False
    )
    elapsed = int((time.monotonic() - started) * 1000)
    lib.AEDisposeDesc(ctypes.byref(desc))
    return status, elapsed


def main():
    lib = load()
    bundle_id = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "poll":
        bound_ms, interval_ms = int(sys.argv[3]), int(sys.argv[4])
        deadline = time.monotonic() + bound_ms / 1000
        started, asks = time.monotonic(), 0
        while True:
            status, _ = determine(lib, bundle_id)
            asks += 1
            if status != -600 or time.monotonic() >= deadline:
                break
            time.sleep(interval_ms / 1000)
        waited = int((time.monotonic() - started) * 1000)
        print(f"{status} {LABELS.get(status, 'unknown')} waited={waited}ms asks={asks}")
        return
    status, elapsed = determine(lib, bundle_id)
    print(f"{status} {LABELS.get(status, 'unknown')} call={elapsed}ms")


main()
