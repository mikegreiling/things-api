/**
 * Static (no-consent-prompt) availability signals per write surface. The URL
 * scheme's on/off switch lives as `uriSchemeEnabled` in the group-container
 * preferences plist — NOT in TMSettings, and NOT implied by the auth token
 * (the token persists while the feature is off; Phase 21b). The plist bytes
 * are read by this process (the same binary macOS already authorized for the
 * database read) and parsed via `plutil` on stdin, so no new file-access
 * shape is introduced.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFS_PLIST = join(
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac",
  "Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist",
);

/** The proxy shortcuts the Shortcuts surface is driven through (lab/shortcuts/). */
export const EXPECTED_PROXIES = [
  "things-proxy-find-items",
  "things-proxy-create-heading",
  "things-proxy-edit-title",
  "things-proxy-set-detail",
  "things-proxy-delete-items",
  "things-proxy-delete-items-permanently",
] as const;

export interface UrlSchemeState {
  /** true = on, false = off, null = not determinable from disk. */
  enabled: boolean | null;
  detail: string;
}

export interface ShortcutsState {
  present: string[];
  missing: string[];
  detail: string;
}

export interface AvailabilityDeps {
  /** Test seam: plist path override. */
  plistPath?: string;
  /** Test seam: raw `plutil -extract` runner; return the raw value or throw. */
  extract?: (plistBytes: Buffer) => string;
  /** Test seam: `shortcuts list` runner; return stdout or throw. */
  listShortcuts?: () => string;
}

function defaultExtract(plistBytes: Buffer): string {
  return execFileSync("plutil", ["-extract", "uriSchemeEnabled", "raw", "-o", "-", "--", "-"], {
    input: plistBytes,
    encoding: "utf8",
    timeout: 5000,
  });
}

function defaultListShortcuts(): string {
  return execFileSync("shortcuts", ["list"], { encoding: "utf8", timeout: 10000 });
}

/**
 * Read the "Enable Things URLs" state from disk. `1`/`0` when the toggle has
 * ever been set; the key is absent on an untouched install (the app then
 * holds the first URL write behind an enable dialog).
 */
export function readUrlSchemeEnabled(deps: AvailabilityDeps = {}): UrlSchemeState {
  const path = deps.plistPath ?? join(homedir(), PREFS_PLIST);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return {
      enabled: null,
      detail:
        "the app's preferences plist is not readable on this machine — the 'Enable Things " +
        "URLs' state is unknown (check Things > Settings > General)",
    };
  }
  let raw: string;
  try {
    raw = (deps.extract ?? defaultExtract)(bytes).trim();
  } catch {
    return {
      enabled: null,
      detail:
        "'Enable Things URLs' has never been toggled on this machine — the app holds the " +
        "first URL command behind an enable dialog (Things > Settings > General)",
    };
  }
  if (raw === "1" || raw === "true") {
    return { enabled: true, detail: "'Enable Things URLs' is on" };
  }
  if (raw === "0" || raw === "false") {
    return {
      enabled: false,
      detail:
        "'Enable Things URLs' is OFF (Things > Settings > General) — the app holds URL " +
        "commands behind an enable dialog instead of executing them",
    };
  }
  return { enabled: null, detail: `unexpected uriSchemeEnabled value: ${raw}` };
}

/** Which proxy shortcuts are installed (drives the Shortcuts surface + `setup shortcuts`). */
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
            "need them (run `things setup shortcuts`)"
          : `missing: ${missing.join(", ")} (run \`things setup shortcuts\`)`,
  };
}
