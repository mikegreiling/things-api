// Disruption-tier computation from a disruption-monitor event slice.
//
// Tiers (docs/design/lab.md §4.1):
//   0  no observable app effect
//   1  launches app if closed (no focus steal)
//   2  foregrounds / steals focus
//   3  navigates visible UI or spawns modals/windows
//
// The slice is the events between the probe's MARK start/end sentinels.
// window-new events that merely accompany an app launch (the main window
// appearing) do not count as tier 3; any window beyond that budget does.

import type { Disruption, DisruptionSignals, MonitorEvent } from "./types.ts";

const THINGS_BUNDLE_ID = "com.culturedcode.ThingsMac";

export function sliceEvents(events: MonitorEvent[], probeId: string): MonitorEvent[] {
  let start = -1;
  let end = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined || e.kind !== "mark") continue;
    const detail = e.detail ?? {};
    if (detail["probe"] !== probeId) continue;
    if (detail["phase"] === "start") start = i;
    if (detail["phase"] === "end" && start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0 || end < 0) return [];
  return events.slice(start + 1, end);
}

export function computeDisruption(slice: MonitorEvent[]): Disruption {
  const signals: DisruptionSignals = {
    launch: false,
    activated: false,
    windowNew: 0,
    windowClose: 0,
    titleChanges: 0,
  };

  for (const e of slice) {
    const bundleId = e.detail?.["bundleId"];
    switch (e.kind) {
      case "launch":
        if (bundleId === THINGS_BUNDLE_ID) signals.launch = true;
        break;
      case "activate":
      case "frontmost":
        if (bundleId === THINGS_BUNDLE_ID) signals.activated = true;
        break;
      case "window-new":
        signals.windowNew += 1;
        break;
      case "window-close":
        signals.windowClose += 1;
        break;
      case "title-change":
        signals.titleChanges += 1;
        break;
      default:
        break;
    }
  }

  // A launch is allowed to surface one window (the main window) without
  // counting as UI disruption; anything beyond that is a modal/new window.
  const windowBudget = signals.launch ? 1 : 0;
  let tier: 0 | 1 | 2 | 3 = 0;
  if (signals.launch) tier = 1;
  if (signals.activated) tier = 2;
  if (signals.windowNew > windowBudget || signals.titleChanges > 0) tier = 3;

  return { tier, signals, events: slice };
}

export function parseEventLog(ndjson: string): MonitorEvent[] {
  const events: MonitorEvent[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as MonitorEvent);
    } catch {
      // Torn final line from a live writer is expected; skip it.
    }
  }
  return events;
}
