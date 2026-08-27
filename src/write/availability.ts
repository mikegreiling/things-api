/**
 * Static (no-consent-prompt) availability signals per write surface.
 *
 * The URL scheme's own switch used to live here too. It now lives with the
 * other prompt-free verdicts, as `urlSchemeCapability()` in ../capability.ts:
 * it gates a dispatch exactly the way the app-control and GUI-driving standings
 * do, and reading it has a consent story of its own (the plist is inside the
 * Things group container) that belongs next to the rest of the doctrine.
 */
import { shortcutsListSync } from "../deputy/shortcuts-exec.ts";

/** The proxy shortcuts the Shortcuts surface is driven through (lab/shortcuts/). */
export const EXPECTED_PROXIES = [
  "things-proxy-find-items",
  "things-proxy-create-heading",
  "things-proxy-edit-title",
  "things-proxy-set-detail",
  "things-proxy-delete-items",
  "things-proxy-delete-items-permanently",
] as const;

export interface ShortcutsState {
  present: string[];
  missing: string[];
  detail: string;
}

export interface AvailabilityDeps {
  /** Test seam: `shortcuts list` runner; return stdout or throw. */
  listShortcuts?: () => string;
}

function defaultListShortcuts(): string {
  // Deputy-routed when active (src/deputy/shortcuts-exec.ts); direct otherwise.
  return shortcutsListSync(10000);
}

/** Which proxy shortcuts are installed (drives the Shortcuts surface + `setup`). */
export function readShortcutProxies(deps: AvailabilityDeps = {}): ShortcutsState {
  let listing: string;
  try {
    listing = (deps.listShortcuts ?? defaultListShortcuts)();
  } catch {
    return {
      present: [],
      missing: [...EXPECTED_PROXIES],
      detail: "the `shortcuts` command-line tool is unavailable — proxy state is unknown",
    };
  }
  const installed = new Set(
    listing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  );
  const present = EXPECTED_PROXIES.filter((p) => installed.has(p));
  const missing = EXPECTED_PROXIES.filter((p) => !installed.has(p));
  return {
    present,
    missing,
    detail:
      missing.length === 0
        ? "all proxy shortcuts are installed"
        : present.length === 0
          ? "no proxy shortcuts are installed — heading creation and dated-reminder clearing " +
            "need them (run `things setup`)"
          : `missing: ${missing.join(", ")} (run \`things setup\`)`,
  };
}
