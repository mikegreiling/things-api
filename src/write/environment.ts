/**
 * Environment tuple tracking. macOS consent decisions (Automation, app-data
 * access) key on identities that can change underneath a working setup: the
 * invoking node binary, the Things app version, the OS itself. We record the
 * tuple of those identities after every verified mutation and compare before
 * the next one, so a change — the classic trigger for a fresh consent prompt
 * or altered app behavior — is reported instead of being discovered as a
 * mysterious hang. See docs/setup.md ("Hardening against consent prompts").
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { environmentStatePath } from "../paths.ts";

export interface EnvironmentTuple {
  /** Things app version (CFBundleShortVersionString); null when unreadable. */
  thingsVersion: string | null;
  /** macOS product version (sw_vers); null when unreadable. */
  macosVersion: string | null;
  /** things-api package version. */
  pkgVersion: string;
  /** Resolved node executable path — consent grants can key on it. */
  nodeBinary: string;
}

export interface EnvironmentChange {
  field: keyof EnvironmentTuple;
  from: string | null;
  to: string | null;
}

/** `defaults read` wants the plist path WITHOUT the .plist extension. */
const THINGS_INFO_PLIST = "/Applications/Things3.app/Contents/Info";

function readCmd(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export function captureEnvironment(pkgVersion: string): EnvironmentTuple {
  let nodeBinary = process.execPath;
  try {
    // Resolve through version-manager shims: the shim path is stable while
    // the real binary underneath changes, and TCC keys on the real binary.
    nodeBinary = realpathSync(process.execPath);
  } catch {
    // keep the unresolved path
  }
  return {
    thingsVersion: readCmd("defaults", ["read", THINGS_INFO_PLIST, "CFBundleShortVersionString"]),
    macosVersion: readCmd("sw_vers", ["-productVersion"]),
    pkgVersion,
    nodeBinary,
  };
}

const TUPLE_FIELDS: (keyof EnvironmentTuple)[] = [
  "thingsVersion",
  "macosVersion",
  "pkgVersion",
  "nodeBinary",
];

/** Changes between the recorded tuple and now; empty when nothing was recorded. */
export function diffEnvironment(
  recorded: EnvironmentTuple | null,
  current: EnvironmentTuple,
): EnvironmentChange[] {
  if (recorded === null) return [];
  return TUPLE_FIELDS.filter((f) => (recorded[f] ?? null) !== (current[f] ?? null)).map((f) => ({
    field: f,
    from: recorded[f] ?? null,
    to: current[f] ?? null,
  }));
}

const FIELD_LABEL: Record<keyof EnvironmentTuple, string> = {
  thingsVersion: "Things",
  macosVersion: "macOS",
  pkgVersion: "things-api",
  nodeBinary: "the node binary",
};

/** Consumer-readable summary, e.g. "Things changed (3.22.11 → 3.22.12)". */
export function describeEnvironmentChanges(changes: EnvironmentChange[]): string {
  return changes
    .map((c) => `${FIELD_LABEL[c.field]} changed (${c.from ?? "unknown"} → ${c.to ?? "unknown"})`)
    .join("; ");
}

export interface EnvironmentTracker {
  /** The current tuple (memoized for the process lifetime). */
  capture(): EnvironmentTuple;
  /** The tuple recorded at the last verified mutation; null when none. */
  load(): EnvironmentTuple | null;
  /** Persist the tuple. Never throws — tracking must not break a mutation. */
  record(tuple: EnvironmentTuple): void;
}

export function createEnvironmentTracker(
  pkgVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentTracker {
  const path = environmentStatePath(env);
  let current: EnvironmentTuple | null = null;
  return {
    capture() {
      current ??= captureEnvironment(pkgVersion);
      return current;
    },
    load() {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EnvironmentTuple> | null;
        if (typeof parsed !== "object" || parsed === null) return null;
        return {
          thingsVersion: typeof parsed.thingsVersion === "string" ? parsed.thingsVersion : null,
          macosVersion: typeof parsed.macosVersion === "string" ? parsed.macosVersion : null,
          pkgVersion: typeof parsed.pkgVersion === "string" ? parsed.pkgVersion : "unknown",
          nodeBinary: typeof parsed.nodeBinary === "string" ? parsed.nodeBinary : "unknown",
        };
      } catch {
        return null;
      }
    },
    record(tuple) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(tuple, null, 2)}\n`);
      } catch {
        // never let the state trail break a successful mutation
      }
    },
  };
}
