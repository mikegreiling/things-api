/**
 * The `ui-state` diagnostic's library surface (issue #620).
 *
 * Two things matter here and nothing else does: the capability gate comes FIRST
 * and prompt-free (permissions doctrine — no surface may raise a consent dialog
 * outside the two setup ceremonies), and every answer is reported rather than
 * thrown, because the situations this exists for are exactly the ones where
 * something is wrong with the screen.
 *
 * The live read is always injected here: a test must never drive the
 * maintainer's own Things app.
 */
import { describe, expect, it } from "vitest";

import type { UiCapability } from "../../src/capability.ts";
import { readUiStateReport, uiStateLines } from "../../src/ui-state.ts";
import { parseUiState, type UiState } from "../../src/write/vectors/ui-state.ts";
import { censusStdout, healthyScreen } from "../fixtures/ui-state.ts";

const HOST = { name: "test-host", bundleId: null } as UiCapability["host"];

const allowed = (): UiCapability => ({
  mode: "helpers",
  detail: "the helpers hold GUI access",
  remediation: [],
  host: HOST,
});

const denied = (): UiCapability => ({
  mode: "config-disabled",
  detail: "GUI-driving is switched off on this machine (`ui-enabled` is false)",
  remediation: ["run `things config set ui-enabled true` to opt in"],
  host: HOST,
});

const state = (o: Parameters<typeof healthyScreen>[0] = {}): UiState =>
  parseUiState(censusStdout(healthyScreen(o))) as UiState;

describe("readUiStateReport", () => {
  it("refuses prompt-free, with remediation, when this machine has not granted the access", async () => {
    let read = 0;
    const report = await readUiStateReport({
      capability: denied,
      read: async () => {
        read += 1;
        return null;
      },
    });
    expect(report.available).toBe(false);
    expect(report.state).toBeNull();
    expect(report.detail).toContain("cannot be read on this machine");
    expect(report.remediation[0]).toContain("ui-enabled");
    // Nothing was attempted — the gate is what keeps a consent dialog off the
    // screen, so it must decide BEFORE the read.
    expect(read).toBe(0);
  });

  it("reports an open dialog and the sync consequence it carries", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ kind: "repeat" }),
    });
    expect(report.available).toBe(true);
    expect(report.state?.sheetKind).toBe("repeat");
    expect(report.detail).toContain("the Repeat dialog is open");
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("Things Cloud");
  });

  it("warns about nothing when no dialog is open", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ kind: "none" }),
    });
    expect(report.warnings).toEqual([]);
  });

  it("reports an unreadable screen as a state, not a failure", async () => {
    const report = await readUiStateReport({ capability: allowed, read: async () => null });
    expect(report.available).toBe(true);
    expect(report.state).toBeNull();
    expect(report.detail).toContain("could not be read");
    expect(report.remediation).not.toHaveLength(0);
  });

  it("says so plainly when Things is not running", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ thingsRunning: false, front: "Finder", kind: "none" }),
    });
    expect(report.detail).toContain("Things is not running");
    expect(report.warnings).toEqual([]);
  });
});

describe("uiStateLines", () => {
  it("renders the four facts, the census evidence, and the sync warning", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ kind: "repeat" }),
    });
    const text = uiStateLines(report).join("\n");
    expect(text).toContain("── Window state ──");
    expect(text).toContain("frontmost:   Things3 (Things)");
    expect(text).toContain("dialog:      repeat (attached; cb:2 pu:1 bt:2 gp:1 tf:0)");
    expect(text).toContain("focus:       Things3 · AXTextField");
    expect(text).toContain("inspectable: yes");
    expect(text).toContain("Things Cloud");
  });

  it("names an un-inspectable system dialog as exactly that", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ front: "", role: "", inspectable: false }),
    });
    const text = uiStateLines(report).join("\n");
    expect(text).toContain("inspectable: no — a system dialog macOS does not expose");
  });

  // ------------------------------------------------------------ issue #629
  it("reports what each probe PROVED, and names the one that did not answer", async () => {
    // The field symptom: with the Repeat sheet standing, `ui-state` collapsed
    // to state null and one generic sentence. The sheet was right there.
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ kind: "repeat", stalled: ["focus"] }),
    });
    expect(report.state).not.toBeNull();
    expect(report.state?.sheetKind).toBe("repeat");
    const text = uiStateLines(report).join("\n");
    expect(text).toContain("frontmost:   Things3 (Things)");
    expect(text).toContain("dialog:      repeat (attached; cb:2 pu:1 bt:2 gp:1 tf:0)");
    expect(text).toContain("focus:       not established");
    expect(text).toContain("unproven:   did not answer in time: which element has keyboard focus");
    expect(text).toContain("next:");
  });

  it("never renders an unproven row as its unset default", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ kind: "repeat", stalled: ["dialog"] }),
    });
    const text = uiStateLines(report).join("\n");
    // "dialog: none" beside probes that WERE measured is the lie #629 fixed.
    expect(text).not.toContain("dialog:      none");
    expect(text).toContain("dialog:      not established");
    expect(text).toContain("frontmost:   Things3 (Things)");
  });

  it("does not claim Things is 'not running' when the probe that would say so stalled", async () => {
    const report = await readUiStateReport({
      capability: allowed,
      read: async () => state({ thingsRunning: true, kind: "repeat", stalled: ["running"] }),
    });
    expect(report.detail).not.toContain("Things is not running");
    expect(report.detail).toContain("nothing about the screen could be established");
    expect(report.state).not.toBeNull();
  });

  it("renders the refusal with its remediation and no invented state", async () => {
    const report = await readUiStateReport({ capability: denied, read: async () => null });
    const text = uiStateLines(report).join("\n");
    expect(text).toContain("summary:     the Things window cannot be read");
    expect(text).toContain("next:      run `things config set ui-enabled true`");
    expect(text).not.toContain("frontmost:");
  });
});
