/**
 * PTRGD1 — NO SYNTHESIZED POINTER GESTURE MAY SHIP WITHOUT THE PRE-GESTURE GUARD.
 *
 * A leaked keystroke lands in a foreign text field; a leaked drag moves a
 * foreign application's files. Both hazards come from the same place — a screen
 * coordinate read from an AX frame in an earlier hop, posted at the global HID
 * tap — and only the keystroke half had a law. This suite is the ratchet on the
 * other half.
 *
 * Two locks, because either alone is escapable:
 *
 *  1. THE CENSUS. Every place in `src/write/vectors/**` that posts a synthesized
 *     mouse event is enumerated from the SOURCE, and the set of declarations
 *     holding one is pinned. A new gesture in a new function changes that set
 *     and fails here, with a message saying what to do about it — nobody has to
 *     remember this suite exists.
 *  2. THE RENDER. Every one of those script builders is called, and its output
 *     must carry the guard call ahead of the events. A guard that is imported
 *     but never invoked satisfies lock 1 and not this one.
 *
 * The keyboard tap is deliberately out of scope: `CGEventPostToPid` (ui-chord.ts)
 * addresses a PROCESS rather than the screen, it is not a pointer gesture, and
 * HARDEN1 left it unguarded by design.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEPUTY_BANNED_SCRIPT_PHRASES } from "../../src/deputy/protocol.ts";
import {
  jxaSidebarChevronClickScript,
  jxaSidebarLiveDragScript,
  jxaSidebarHeldScrollDragScript,
  jxaSidebarScrollScript,
  jxaSidebarSparseChevronClickScript,
  jxaSidebarSparseScrollScript,
  jxaSidebarScrollToScript,
  jxaSidebarSnapshotScript,
} from "../../src/write/vectors/ui-drag.ts";
import {
  POINTER_GUARD_DECISION_JS,
  POINTER_GUARD_JXA,
  PTRGD1_GUARD_END,
  PTRGD1_MARKER,
  THINGS_BUNDLE_ID,
} from "../../src/write/vectors/ui-pointer-guard.ts";
import { jxaClickScript } from "../../src/write/vectors/ui.ts";

const VECTORS_DIR = "src/write/vectors";

/**
 * What counts as posting a synthesized mouse event. `postHID(` is in the list
 * because it is how this repo actually posts one — a census that knew only the
 * CoreGraphics names would have missed every gesture in `ui-drag.ts`.
 */
const HID_MARKERS = [
  /kCGHIDEventTap/,
  /CGEventCreateMouseEvent/,
  /CGEventCreateScrollWheelEvent/,
  /\bpostHID\s*\(/,
] as const;

/**
 * The declarations allowed to hold a mouse post, and how each satisfies the law.
 * Adding a member is a deliberate act: guard the gesture first, then say so here.
 */
const GUARDED_SITES: Readonly<Record<string, string>> = {
  // The shared JXA prelude: it DEFINES mev/postHID/postEscape and calls none of
  // them, and it compiles the guard in beside them, so every script built on it
  // has `ptrGuard` in scope.
  JXA_PRELUDE: "defines the posting helpers; the guard ships in the same prelude",
  jxaSidebarLiveDragScript:
    "guards the grab and the estimate, and re-checks at the LIVE drop point",
  jxaSidebarHeldScrollDragScript: "guards the grab, and re-checks at the drop",
  jxaSidebarChevronClickScript: "guards the arrow's point with an identity check",
  jxaSidebarScrollScript: "guards the sidebar centre the wheel events go to",
  jxaClickScript: "guards the resolved control point with an identity check",
  // The ORDINAL-ADDRESSED twins (VOPAT2 PR 2). A cheaper way to FIND the sidebar
  // is not a cheaper way to be sure of the pixel, so these carry the same guard
  // as the census-addressed builders above — the chevron's identity leg with the
  // row frame the census measured, the wheel's with the sidebar's own table.
  jxaSidebarSparseChevronClickScript: "guards the arrow's point against the census's row frame",
  jxaSidebarSparseScrollScript: "guards the sidebar centre the wheel events go to",
};

/** Strip comments so a JSDoc line naming `CGEventPost(kCGHIDEventTap)` is not a site. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/**
 * The nearest enclosing TYPESCRIPT declaration above a line.
 *
 * The naive "nearest `function`" answer is wrong here, and quietly so: these
 * files are mostly JXA held in template literals, whose own `function mev(...)`
 * and `function boundaryNow(...)` start at column 0 too. A TypeScript
 * declaration in this tree is always either exported or a `const NAME =`, and
 * the embedded JavaScript is never either.
 */
function enclosingDeclaration(lines: string[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const line = lines[i] as string;
    const m =
      /^export (?:async )?(?:function|const|let) ([A-Za-z0-9_$]+)/.exec(line) ??
      /^const ([A-Za-z0-9_$]+)(?:\s*:[^=]*)? = /.exec(line);
    if (m !== null) return m[1] as string;
  }
  return "<file scope>";
}

/** Every (file, declaration) in the vector tree that posts a mouse event. */
function mousePostSites(): { file: string; declaration: string; line: string }[] {
  const found: { file: string; declaration: string; line: string }[] = [];
  for (const name of readdirSync(VECTORS_DIR).toSorted()) {
    if (!name.endsWith(".ts")) continue;
    const lines = stripComments(readFileSync(join(VECTORS_DIR, name), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!HID_MARKERS.some((re) => re.test(line))) return;
      found.push({ file: name, declaration: enclosingDeclaration(lines, i), line: line.trim() });
    });
  }
  return found;
}

/** The pointer-gesture builders, rendered exactly as the driver dispatches them. */
const SIDEBAR_TITLES = ["Errands", "Reading"] as const;
const SIDEBAR_ROW = { x: 12, y: 208, w: 240, h: 24 };
const SPARSE_ADDR = { paneIndex: 1, verifyOrdinal: 13, verifyTitle: "Errands" };
const RENDERED: { label: string; script: string }[] = [
  {
    label: "sidebar-drag (live-aim)",
    script: jxaSidebarLiveDragScript(
      180,
      220,
      420,
      SIDEBAR_ROW,
      SIDEBAR_TITLES,
      { title: "Reading", ordinal: 17, unique: true },
      1,
      40,
    ),
  },
  {
    label: "sidebar-drag (live-aim, to last)",
    script: jxaSidebarLiveDragScript(180, 220, 420, SIDEBAR_ROW, SIDEBAR_TITLES, null, null, 40),
  },
  {
    label: "sidebar-held-drag",
    script: jxaSidebarHeldScrollDragScript(180, 220, "Reading", 40, SIDEBAR_TITLES, SIDEBAR_ROW),
  },
  {
    label: "sidebar-chevron",
    script: jxaSidebarChevronClickScript("Errands", -1, SIDEBAR_TITLES),
  },
  { label: "sidebar-scroll (wheel)", script: jxaSidebarScrollScript(-3, SIDEBAR_TITLES) },
  {
    label: "sidebar-chevron (ordinal-addressed)",
    script: jxaSidebarSparseChevronClickScript(SPARSE_ADDR, SIDEBAR_ROW),
  },
  {
    label: "sidebar-scroll (wheel, ordinal-addressed)",
    script: jxaSidebarSparseScrollScript(-3, SPARSE_ADDR),
  },
  {
    label: "click-point",
    script: jxaClickScript(412, 388, "click the open dialog's Cancel button"),
  },
];

describe("the mouse-post census", () => {
  it("finds a posting site at all — a census that matches nothing proves nothing", () => {
    expect(mousePostSites().length).toBeGreaterThan(4);
  });

  it("holds no site outside the declarations pinned as guarded", () => {
    const unknown = mousePostSites().filter((s) => GUARDED_SITES[s.declaration] === undefined);
    expect(
      unknown.map((s) => `${s.file} · ${s.declaration} · ${s.line}`),
      "a synthesized mouse event was added outside a guarded builder. Post it behind " +
        "ptrGuard() (src/write/vectors/ui-pointer-guard.ts) — frontmost + containment + " +
        "occlusion + identity, in the SAME script as the event — then add the declaration to " +
        "GUARDED_SITES with a note saying how it satisfies the law.",
    ).toEqual([]);
  });

  it("pins every declaration it names — a stale allowlist entry is a stale claim", () => {
    const live = new Set(mousePostSites().map((s) => s.declaration));
    expect(Object.keys(GUARDED_SITES).filter((d) => !live.has(d))).toEqual([]);
  });
});

describe("every rendered pointer gesture carries the guard", () => {
  it.each(RENDERED)("$label posts nothing before ptrGuard has its verdict", ({ script }) => {
    expect(script).toContain(PTRGD1_MARKER);
    // The gesture's own body starts past the guard block, so the posting
    // helpers' DEFINITIONS in the prelude cannot be mistaken for a post.
    const body = script.slice(script.indexOf(PTRGD1_GUARD_END));
    expect(body).not.toBe("");
    const guardAt = body.search(/ptrGuard\(['"]/);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const firstPost = body.search(/postHID\(|CGEventPost\(/);
    expect(firstPost).toBeGreaterThan(guardAt);
    expect(body).toMatch(/refusal !== null/);
  });

  it("names the occluding application and says nothing was posted", () => {
    expect(POINTER_GUARD_JXA).toContain("kCGWindowOwnerName");
    expect(POINTER_GUARD_JXA).toContain("owns the screen at ");
    expect(POINTER_GUARD_JXA).toContain(", so nothing was posted");
    expect(POINTER_GUARD_JXA).toContain(" — nothing was posted");
    // The keystroke law's sentence family, verbatim where it is shared.
    expect(POINTER_GUARD_JXA).toContain("is frontmost, not Things");
  });

  it("asserts all four legs of the law", () => {
    // 1 frontmost, by bundle id
    expect(POINTER_GUARD_JXA).toContain("frontmostApplication");
    expect(POINTER_GUARD_JXA).toContain(THINGS_BUNDLE_ID);
    // 2 containment against Things' own window frame
    expect(POINTER_GUARD_JXA).toContain("ptrRectHas(wins[k].f");
    // 3 occlusion, both ways: the window list and the window server's hit test
    expect(POINTER_GUARD_JXA).toContain("CGWindowListCopyWindowInfo");
    expect(POINTER_GUARD_JXA).toContain("kCGWindowListOptionOnScreenOnly");
    expect(POINTER_GUARD_JXA).toContain("kCGWindowListExcludeDesktopElements");
    expect(POINTER_GUARD_JXA).toContain("AXUIElementCreateSystemWide");
    // The scan's exemption is a CLASS, not an instance: a system-owned window
    // that covers the whole display. Naming the Dock was the defect.
    expect(POINTER_GUARD_JXA).toContain("ptrCoversScreen");
    expect(POINTER_GUARD_JXA).toContain("isSystemOwner");
    // 4 identity, from the app-scoped hit test up the AXParent chain
    expect(POINTER_GUARD_JXA).toContain("AXUIElementCopyElementAtPosition");
    expect(POINTER_GUARD_JXA).toContain("'AXParent'");
  });

  it("re-checks at the drop point in both drag scripts, and aborts with Escape", () => {
    for (const label of ["sidebar-drag (live-aim)", "sidebar-held-drag"]) {
      const script = (RENDERED.find((r) => r.label === label) as { script: string }).script;
      expect(script).toContain("ptrGuard('drop the area row'");
      // AXDRAG1-d's abort vector, not a bare mouse-up.
      expect(script).toContain("postEscape()");
      expect(script).toContain("aborted:true");
    }
  });

  it("takes the identity check at the GRAB point, against the planned row frame", () => {
    for (const label of ["sidebar-drag (live-aim)", "sidebar-held-drag"]) {
      const script = (RENDERED.find((r) => r.label === label) as { script: string }).script;
      expect(script).toContain('var SRC = {"x":12,"y":208,"w":240,"h":24}');
      expect(script).toContain("ptrChainHasFrame(chain, ['AXRow','AXTableRow'], SRC)");
      expect(script).toContain("so the frames are stale");
    }
  });

  it("leaves the POINTERLESS scroll alone — it writes AXValue and posts nothing", () => {
    // SBSCR1's scroll-bar write is genuinely positionless, so it is not a
    // pointer gesture and must not grow a pointer guard's cost.
    for (const script of [
      jxaSidebarScrollToScript(0.5, SIDEBAR_TITLES),
      jxaSidebarSnapshotScript(SIDEBAR_TITLES),
    ]) {
      const body = script.slice(script.indexOf(PTRGD1_GUARD_END));
      expect(body).not.toMatch(/postHID\(|CGEventPost\(/);
      expect(body).not.toMatch(/ptrGuard\(['"]/);
    }
  });

  it("reaches its verdict without a phrase the deputy's broker refuses", () => {
    const lowered = POINTER_GUARD_JXA.toLowerCase();
    for (const phrase of DEPUTY_BANNED_SCRIPT_PHRASES) expect(lowered).not.toContain(phrase);
  });
});

/**
 * THE OCCLUSION DECISION TABLE, EXECUTED.
 *
 * `POINTER_GUARD_DECISION_JS` is deliberately free of the ObjC bridge so this
 * suite can run the shipped source rather than pattern-match it. The table is
 * what the v0.20.9 release gate bought: the first cut asked the window scan
 * first, and refused every gesture on every real Mac, because macOS keeps
 * full-screen mouse-transparent system surfaces permanently above every
 * ordinary window and the window list has no field that says so.
 */
interface Verdict {
  ok?: boolean;
  pid?: number;
  name?: string | null;
  unanswered?: boolean;
}
type VerdictFn = (
  frontPid: number,
  hitPid: number | null,
  list: unknown[],
  x: number,
  y: number,
  screen: { x: number; y: number; w: number; h: number } | null,
  isSystemOwner: (pid: number) => boolean,
) => Verdict;

const occlusionVerdict = new Function(
  `${POINTER_GUARD_DECISION_JS}\nreturn ptrOcclusionVerdict;`,
)() as VerdictFn;

const THINGS_PID = 665;
const SYSTEM_PID = 411;
const FOREIGN_PID = 1778;
/** The guest's display, and the full-screen Notification Center over it. */
const SCREEN = { x: 0, y: 0, w: 1024, h: 768 };
function win(pid: number, name: string, b: [number, number, number, number]) {
  return {
    kCGWindowOwnerPID: pid,
    kCGWindowOwnerName: name,
    kCGWindowBounds: { X: b[0], Y: b[1], Width: b[2], Height: b[3] },
  };
}
/** Exactly the guest list the release gate captured, front to back. */
const GUEST_LIST = [
  win(155, "Window Server", [6, 6, 17, 23]),
  win(331, "Control Center", [843, 0, 34, 24]),
  win(155, "Window Server", [0, 0, 1024, 24]),
  win(SYSTEM_PID, "Notification Center", [0, 0, 1024, 768]),
  win(329, "Dock", [0, 0, 1024, 768]),
  win(THINGS_PID, "Things", [44, 25, 935, 684]),
];
const isSystem = (pid: number): boolean => pid === SYSTEM_PID || pid === 329 || pid === 155;
const POINT: [number, number] = [212, 524];

describe("the occlusion decision table", () => {
  it("passes when the hit test says Things — the scan is not consulted at all", () => {
    // The v0.20.9 defect verbatim: hit test 665, scan Notification Center.
    const v = occlusionVerdict(
      THINGS_PID,
      THINGS_PID,
      GUEST_LIST,
      POINT[0],
      POINT[1],
      SCREEN,
      () => {
        throw new Error("the scan must not run when the hit test has an answer");
      },
    );
    expect(v.ok).toBe(true);
  });

  it("refuses and names the app when the hit test says another application", () => {
    const v = occlusionVerdict(
      THINGS_PID,
      FOREIGN_PID,
      GUEST_LIST,
      POINT[0],
      POINT[1],
      SCREEN,
      isSystem,
    );
    expect(v.ok).toBe(false);
    // The pid is returned so the caller can name it from NSRunningApplication;
    // the hit test itself carries no name.
    expect(v.pid).toBe(FOREIGN_PID);
    expect(v.name).toBeNull();
  });

  it("passes when the hit test says NOTHING and only display-sized system windows are above", () => {
    const v = occlusionVerdict(THINGS_PID, null, GUEST_LIST, POINT[0], POINT[1], SCREEN, isSystem);
    expect(v.ok).toBe(true);
  });

  it("refuses and names it when the hit test says NOTHING and the window is not system-owned", () => {
    const list = [win(FOREIGN_PID, "osascript", [118, 463, 260, 90]), ...GUEST_LIST];
    const v = occlusionVerdict(THINGS_PID, null, list, 208, 503, SCREEN, isSystem);
    expect(v.ok).toBe(false);
    expect(v.name).toBe("osascript");
  });

  it("refuses a system window that is NOT display-sized — a banner swallows the click", () => {
    const banner = win(SYSTEM_PID, "Notification Center", [700, 40, 320, 100]);
    const v = occlusionVerdict(
      THINGS_PID,
      null,
      [banner, ...GUEST_LIST],
      800,
      80,
      SCREEN,
      isSystem,
    );
    expect(v.ok).toBe(false);
    expect(v.name).toBe("Notification Center");
  });

  it("refuses a display-sized window that is NOT system-owned — both halves are required", () => {
    const overlay = win(FOREIGN_PID, "Screen Sharing", [0, 0, 1024, 768]);
    const v = occlusionVerdict(
      THINGS_PID,
      null,
      [overlay, ...GUEST_LIST],
      POINT[0],
      POINT[1],
      SCREEN,
      isSystem,
    );
    expect(v.ok).toBe(false);
    expect(v.name).toBe("Screen Sharing");
  });

  it("exempts the maintainer's host surfaces too — loginwindow at layers 2004 and 2001", () => {
    // Measured read-only on the host: both sit above every ordinary window, and
    // the second is far larger than the display.
    const hostScreen = { x: 0, y: 0, w: 2056, h: 1329 };
    const LOGINWINDOW = 214;
    const host = [
      win(LOGINWINDOW, "loginwindow", [0, 0, 2056, 1329]),
      win(LOGINWINDOW, "loginwindow", [-15000, -15000, 30000, 30000]),
      win(82034, "Dock", [0, 0, 2056, 1329]),
      win(THINGS_PID, "Things", [273, 44, 1252, 1002]),
    ];
    const v = occlusionVerdict(
      THINGS_PID,
      null,
      host,
      900,
      545,
      hostScreen,
      (pid) => pid === LOGINWINDOW || pid === 82034,
    );
    expect(v.ok).toBe(true);
  });

  it("reports the unanswered case rather than guessing when no window owns the point", () => {
    const v = occlusionVerdict(THINGS_PID, null, [], 10, 10, SCREEN, isSystem);
    expect(v.ok).toBe(false);
    expect(v.unanswered).toBe(true);
  });

  it("never lets a name stand in for an identity — the exemption is by pid", () => {
    // A process that merely CALLS itself Dock is not exempt: `isSystemOwner`
    // is asked about the pid, and the shipped predicate reads the executable
    // path rather than the window's owner name.
    const impostor = win(FOREIGN_PID, "Dock", [0, 0, 1024, 768]);
    const v = occlusionVerdict(
      THINGS_PID,
      null,
      [impostor, ...GUEST_LIST],
      POINT[0],
      POINT[1],
      SCREEN,
      isSystem,
    );
    expect(v.ok).toBe(false);
    expect(v.name).toBe("Dock");
  });
});

describe("the shipped system-owner predicate", () => {
  it("judges by executable path, in exactly two directories", () => {
    expect(POINTER_GUARD_JXA).toContain("/System/Library/CoreServices");
    expect(POINTER_GUARD_JXA).toContain("/System/Library/PrivateFrameworks");
    expect(POINTER_GUARD_JXA).toContain("executableURL");
    // Never by name: the old Dock-by-name exemption is gone.
    expect(POINTER_GUARD_JXA).not.toContain("=== 'Dock'");
  });

  it("asks the hit test BEFORE the scan, and only scans when it answered nothing", () => {
    const body = POINTER_GUARD_JXA.slice(POINTER_GUARD_JXA.indexOf("function ptrGuard("));
    expect(body).toContain("ptrOcclusionVerdict(front.pid, ptrHitPidAt(px, py)");
    // The scan is reached only through the verdict function, never directly.
    expect(body).not.toContain("ptrScanOwnerAt(");
  });

  it("measures the display the point is on, not a hardcoded screen", () => {
    expect(POINTER_GUARD_JXA).toContain("NSScreen.screens");
    expect(POINTER_GUARD_JXA).toContain("ptrScreenAt(px, py)");
  });
});
