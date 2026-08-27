/**
 * The read-only window/focus census, its parse, and the per-step focus guard's
 * verdict matrix (issue #620).
 *
 * These are the decisions that stand between a synthetic keystroke and someone
 * else's window, so every branch is a test: who is frontmost, whether the
 * screen can be inspected at all, whether the dialog in front is still the one
 * the drive opened, and what an unreadable census means (nothing is sent).
 */
import { describe, expect, it } from "vitest";

import {
  axUiStateScript,
  describeFocusOwner,
  describeUiState,
  parseUiState,
  readUiState,
  SYNC_GATE_WARNING,
  UI_STATE_MARKER,
  type UiState,
} from "../../src/write/vectors/ui-state.ts";
import { judgeFocusGuard } from "../../src/write/vectors/ui.ts";
import { censusStdout, healthyScreen } from "../fixtures/ui-state.ts";

/** Parse a fake screen into the census shape the callers see. */
const screenState = (o: Parameters<typeof healthyScreen>[0] = {}): UiState =>
  parseUiState(censusStdout(healthyScreen(o))) as UiState;

describe("ui-state census script", () => {
  const script = axUiStateScript();

  it("carries its marker so a runner can recognize it", () => {
    expect(script.startsWith(UI_STATE_MARKER)).toBe(true);
  });

  it("is READ-ONLY: it types nothing, clicks nothing and opens nothing", () => {
    // The whole value of this probe is that it can be run at any moment,
    // including mid-drive and mid-cleanup, without changing what it measures.
    expect(script).not.toContain("keystroke");
    expect(script).not.toContain("key code");
    expect(script).not.toMatch(/\bclick\b/);
    expect(script).not.toContain("set focused");
    expect(script).not.toContain("perform action");
    expect(script).not.toContain("activate");
  });

  it("identifies the Repeat dialog from its CONTROL CENSUS, not from a title", () => {
    // The structural discriminator (RDLG1 §2.1) — two checkboxes, one direct
    // pop-up, two buttons, one group, no direct text field — appears verbatim.
    expect(script).toContain("nCb is 2 and nPu is 1 and nBt is 2 and nGp is 1 and nTf is 0");
    // …and the picker is identified by its own window identifier.
    expect(script).toContain("MovePopUpDialog-");
  });

  it("emits no element values, titles or descriptions (no user content can leak)", () => {
    expect(script).not.toContain("value of static text");
    expect(script).not.toContain("title of");
    expect(script).not.toContain("description of");
  });
});

describe("parseUiState", () => {
  it("reads the healthy Repeat-dialog census", () => {
    const state = parseUiState(censusStdout(healthyScreen({ kind: "repeat" })));
    expect(state).not.toBeNull();
    expect(state?.thingsFrontmost).toBe(true);
    expect(state?.frontmostApp).toBe("Things3");
    expect(state?.sheetOpen).toBe(true);
    expect(state?.sheetKind).toBe("repeat");
    expect(state?.sheetForm).toBe("attached");
    expect(state?.focusOwner).toEqual({ app: "Things3", role: "AXTextField", subrole: null });
    expect(state?.inspectable).toBe(true);
  });

  it("reads a foreign frontmost application with no dialog in Things", () => {
    const state = parseUiState(
      censusStdout(healthyScreen({ front: "Finder", kind: "none", role: "AXList" })),
    );
    expect(state?.thingsFrontmost).toBe(false);
    expect(state?.frontmostApp).toBe("Finder");
    expect(state?.sheetOpen).toBe(false);
    expect(state?.sheetKind).toBe("none");
    expect(state?.sheetControls).toBeNull();
  });

  it("reads the un-inspectable case (a secure system modal)", () => {
    const state = parseUiState(
      censusStdout(healthyScreen({ front: "", role: "", inspectable: false })),
    );
    expect(state?.inspectable).toBe(false);
    expect(state?.frontmostApp).toBeNull();
    expect(state?.focusOwner).toBeNull();
  });

  it("returns null for output that is not a census (a transport error)", () => {
    expect(parseUiState("")).toBeNull();
    expect(parseUiState("true")).toBeNull();
    expect(parseUiState("execution error: -1728")).toBeNull();
  });

  it("degrades an unknown dialog kind to none rather than inventing one", () => {
    expect(parseUiState("kind=something-new\ninspectable=true")?.sheetKind).toBe("none");
  });
});

describe("readUiState", () => {
  it("returns null when the transport failed (never a false all-clear)", async () => {
    const state = await readUiState(async () => ({ ok: false, stdout: "", stderr: "boom" }), 100);
    expect(state).toBeNull();
  });

  it("parses a successful read", async () => {
    const state = await readUiState(
      async () => ({
        ok: true,
        stdout: censusStdout(healthyScreen({ kind: "repeat" })),
        stderr: "",
      }),
      100,
    );
    expect(state?.sheetKind).toBe("repeat");
  });
});

describe("describeFocusOwner / describeUiState", () => {
  it("names the application that owns the screen and the focused element's role", () => {
    expect(describeFocusOwner(screenState({ front: "Finder", role: "AXList" }))).toBe(
      "Finder is frontmost and keyboard focus is on a AXList",
    );
  });

  it("says plainly when a system dialog cannot be identified", () => {
    const text = describeFocusOwner(screenState({ front: "", role: "", inspectable: false }));
    expect(text).toContain("a system dialog owns the screen");
    expect(text).toContain("macOS does not expose it");
  });

  it("says the state is unknown when there was nothing to read", () => {
    expect(describeFocusOwner(null)).toBe("the window state could not be read");
  });

  it("summarizes the two facts a caller needs", () => {
    expect(describeUiState(screenState({ kind: "repeat" }))).toBe(
      "Things is frontmost; the Repeat dialog is open (attached)",
    );
    expect(describeUiState(screenState({ kind: "repeat", depth: 3 }))).toBe(
      "Things is frontmost; the Repeat dialog is open (attached), on top of 2 more",
    );
    expect(describeUiState(screenState({ front: "Safari", kind: "none" }))).toBe(
      "Safari is frontmost; no dialog is open in Things",
    );
  });
});

describe("judgeFocusGuard — the verdict matrix", () => {
  it("allows the hop when Things is frontmost and the dialog is the expected one", () => {
    expect(judgeFocusGuard(screenState({ kind: "repeat" }), "repeat", "type 1")).toBeNull();
  });

  it("allows the hop when no dialog kind is expected yet", () => {
    expect(judgeFocusGuard(screenState({ kind: "none" }), null, "type 1")).toBeNull();
  });

  it("REFUSES and names the thief when another application is frontmost", () => {
    const why = judgeFocusGuard(
      screenState({ front: "Finder", role: "AXList" }),
      "repeat",
      "type 1",
    );
    expect(why).toContain('refused to run "type 1"');
    expect(why).toContain("Finder is frontmost");
    expect(why).toContain("nothing was sent");
  });

  it("REFUSES on a system dialog macOS will not expose", () => {
    const why = judgeFocusGuard(
      screenState({ front: "", role: "", inspectable: false }),
      null,
      "type 1",
    );
    expect(why).toContain("a system dialog owns the screen");
    expect(why).toContain("nothing was sent");
  });

  it("REFUSES when the state could not be read at all (fail-closed)", () => {
    const why = judgeFocusGuard(null, "repeat", "type 1");
    expect(why).toContain("could not be read");
    expect(why).toContain("nothing was sent");
  });

  it("REFUSES when the dialog in front is not the one this drive opened", () => {
    const why = judgeFocusGuard(screenState({ kind: "move-picker" }), "repeat", "type 1");
    expect(why).toContain("no longer the one in front");
    expect(why).toContain("expected repeat");
    expect(why).toContain("found move-picker");
  });
});

describe("the sync-gate warning", () => {
  it("states the consequence in behavior terms, with no app-internals vocabulary", () => {
    expect(SYNC_GATE_WARNING).toContain("Things Cloud");
    expect(SYNC_GATE_WARNING).toContain("dismissed");
    expect(SYNC_GATE_WARNING).not.toMatch(/sheet|AX|Accessibility/);
  });
});
