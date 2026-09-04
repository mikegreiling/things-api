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
  jxaSidebarDragScript,
  jxaSidebarHeldScrollDragScript,
  jxaSidebarScrollScript,
  jxaSidebarScrollToScript,
  jxaSidebarSnapshotScript,
} from "../../src/write/vectors/ui-drag.ts";
import {
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
  jxaSidebarDragScript: "guards both endpoints, and re-checks at the drop",
  jxaSidebarHeldScrollDragScript: "guards the grab, and re-checks at the drop",
  jxaSidebarChevronClickScript: "guards the arrow's point with an identity check",
  jxaSidebarScrollScript: "guards the sidebar centre the wheel events go to",
  jxaClickScript: "guards the resolved control point with an identity check",
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
const RENDERED: { label: string; script: string }[] = [
  { label: "sidebar-drag", script: jxaSidebarDragScript(180, 220, 180, 420, SIDEBAR_ROW) },
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
    // The window scan's ONE exemption is the Dock's mouse-transparent
    // full-screen backstop, and nothing else — a floating panel at layer 3 is
    // an occluder the scan must name.
    expect(POINTER_GUARD_JXA).toContain("name === 'Dock'");
    // 4 identity, from the app-scoped hit test up the AXParent chain
    expect(POINTER_GUARD_JXA).toContain("AXUIElementCopyElementAtPosition");
    expect(POINTER_GUARD_JXA).toContain("'AXParent'");
  });

  it("re-checks at the drop point in both drag scripts, and aborts with Escape", () => {
    for (const label of ["sidebar-drag", "sidebar-held-drag"]) {
      const script = (RENDERED.find((r) => r.label === label) as { script: string }).script;
      expect(script).toContain("ptrGuard('drop the area row'");
      // AXDRAG1-d's abort vector, not a bare mouse-up.
      expect(script).toContain("postEscape()");
      expect(script).toContain("aborted:true");
    }
  });

  it("takes the identity check at the GRAB point, against the planned row frame", () => {
    for (const label of ["sidebar-drag", "sidebar-held-drag"]) {
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
