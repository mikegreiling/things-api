/**
 * Sync-health signals for long-running headless operation (a "closet Mac
 * mini"): answer "is my Things data fresh, and is sync alive?". All signals
 * are LOCAL freshness proxies plus, when a Things Cloud account is attached,
 * the sync engine's last-attempt timestamp. There is no background sync
 * daemon — if the app is not running the database is frozen.
 *
 * Signal provenance (docs/lab/headless-research.md SYNC1 + SYNC2):
 *   - app running          → `pgrep -x Things3` (no app = frozen DB)
 *   - WAL freshness        → `main.sqlite-wal` mtime (advances on every write)
 *   - last local edit      → MAX(TMTask.userModificationDate)
 *   - last foreground      → group-container plist importantInformationLastForegroundDate
 *   - cloud last-attempt   → BSSyncronyMetadata bplist NSDate (2001-epoch)
 *
 * The BSSyncronyMetadata BLOBs are decoded with the minimal in-process bplist
 * reader below (unit-testable from raw bytes, no subprocess-per-row). The
 * group-container plist is read with `plutil` on stdin — the same one stable
 * command shape the URL-scheme availability read already uses.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { isThingsRunning } from "./write/automation-probe.ts";

/** The minimal read surface this module needs — satisfied by node:sqlite's DatabaseSync. */
export interface ReadableDb {
  prepare(sql: string): { get(): unknown; all(): unknown[] };
}

/** 2001-01-01T00:00:00Z expressed in Unix seconds (the NSDate epoch offset). */
const NSDATE_EPOCH_OFFSET_S = 978_307_200;
/** WAL is flagged stale only when the app IS running and has not written in this long. */
const DEFAULT_WAL_STALE_SECONDS = 24 * 60 * 60;
/**
 * The account-specific last-sync key, stable across two devices on one account
 * (SYNC2). The value-based fallback (nearest-to-now) covers the unverified
 * multi-account case; its only sibling double is a ~now+31yr lease sentinel,
 * excluded by rejecting doubles this far in the future.
 */
const LAST_SYNC_KEY = "GryCJ44xPcJG6go5KeTZp1";
const LEASE_SENTINEL_MIN_FUTURE_S = 5 * 365 * 24 * 60 * 60;

export interface SyncHealth {
  appRunning: {
    running: boolean;
    verdict: string;
  };
  wal: {
    /** ISO timestamp of the last `main.sqlite-wal` write; null when no sidecar. */
    mtime: string | null;
    ageSeconds: number | null;
    /** true = stale beyond threshold (app running); null = cannot judge (app not running / no WAL). */
    stale: boolean | null;
    verdict: string;
  };
  lastLocalEdit: {
    /** ISO timestamp of MAX(TMTask.userModificationDate); null when the library is empty. */
    at: string | null;
    ageSeconds: number | null;
    verdict: string;
  };
  lastForeground: {
    /** ISO timestamp the app was last frontmost; null when the plist is absent/unreadable. */
    at: string | null;
    verdict: string;
  };
  cloud: {
    /** true once a Things Cloud account is attached (BSSyncronyMetadata populated). */
    accountAttached: boolean;
    /** ISO timestamp of the last sync ATTEMPT (advances even offline); null when no account. */
    lastSyncAttempt: string | null;
    ageSeconds: number | null;
    /** How the timestamp was located, or null when there is no account signal. */
    keySource: "known-key" | "nearest-to-now" | null;
    verdict: string;
  };
}

export interface SyncHealthDeps {
  /** Injected clock (ms epoch). */
  now?: () => number;
  /** Process check seam. */
  isAppRunning?: () => boolean;
  /** WAL mtime seam (ms epoch), given the `<db>-wal` path; null when absent. */
  walMtimeMs?: (walPath: string) => number | null;
  /** Override the group-container plist path (default: derived from the db path). */
  foregroundPlistPath?: string;
  /** Foreground-date seam (ms epoch), given the plist path; null when absent/unreadable. */
  readForegroundMs?: (plistPath: string) => number | null;
  /** WAL staleness threshold in seconds (default 24h). */
  walStaleSeconds?: number;
}

/**
 * Decode a bplist whose top object is a single scalar double — an NSDate
 * (marker 0x33) or a real (0x2n). Returns the raw double (NSDate seconds since
 * 2001, or the plain real), or null for any other shape (ints, strings, dicts)
 * or malformed bytes. Deliberately minimal: the BSSyncronyMetadata values are
 * each a single scalar, so no object graph walk is needed.
 */
export function decodeBplistScalarDouble(
  bytes: Uint8Array | Buffer | null | undefined,
): number | null {
  if (!bytes || bytes.length < 8 + 32) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.toString("latin1", 0, 6) !== "bplist") return null;
  const trailerStart = buf.length - 32;
  const offsetSize = buf[trailerStart + 6] ?? 0;
  if (offsetSize < 1 || offsetSize > 8) return null;
  const numObjects = readBE(buf, trailerStart + 8, 8);
  const topObject = readBE(buf, trailerStart + 16, 8);
  const offsetTableOffset = readBE(buf, trailerStart + 24, 8);
  if (topObject >= numObjects) return null;
  const entry = offsetTableOffset + topObject * offsetSize;
  if (entry + offsetSize > trailerStart) return null;
  const objOffset = readBE(buf, entry, offsetSize);
  const marker = buf[objOffset];
  if (marker === undefined) return null;
  const type = marker & 0xf0;
  const nbytes = 1 << (marker & 0x0f);
  // Real (0x2n) or date (0x33): a big-endian IEEE float of nbytes bytes.
  if (type === 0x20 || marker === 0x33) {
    if (nbytes === 8) {
      if (objOffset + 1 + 8 > trailerStart) return null;
      return buf.readDoubleBE(objOffset + 1);
    }
    if (nbytes === 4) {
      if (objOffset + 1 + 4 > trailerStart) return null;
      return buf.readFloatBE(objOffset + 1);
    }
  }
  return null;
}

function readBE(buf: Buffer, start: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + (buf[start + i] ?? 0);
  return v;
}

/**
 * Choose the last-sync NSDate double from all decoded BSSyncronyMetadata
 * doubles when the account-specific key is unavailable: exclude the ~now+31yr
 * lease sentinel (any double that far in the future), then pick the one
 * nearest to now. Pure; unit-tested with fixture doubles.
 */
export function selectNearestNsDate(candidates: number[], nowNsDate: number): number | null {
  const viable = candidates.filter((v) => v - nowNsDate < LEASE_SENTINEL_MIN_FUTURE_S);
  if (viable.length === 0) return null;
  return viable.reduce((best, v) =>
    Math.abs(v - nowNsDate) < Math.abs(best - nowNsDate) ? v : best,
  );
}

function defaultWalMtimeMs(walPath: string): number | null {
  try {
    return statSync(walPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The group-container preferences plist sits alongside the database:
 * `<group>/ThingsData-XXXX/Things Database.thingsdatabase/main.sqlite` →
 * `<group>/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist`.
 */
function defaultForegroundPlistPath(dbPath: string): string {
  const groupRoot = dirname(dirname(dirname(dbPath)));
  return join(groupRoot, "Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist");
}

function defaultReadForegroundMs(plistPath: string): number | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(plistPath);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = execFileSync(
      "plutil",
      ["-extract", "importantInformationLastForegroundDate", "raw", "-o", "-", "--", "-"],
      { input: bytes, encoding: "utf8", timeout: 5000 },
    ).trim();
  } catch {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function ageSecondsFrom(nowMs: number, thenMs: number | null): number | null {
  if (thenMs === null) return null;
  return Math.max(0, Math.floor((nowMs - thenMs) / 1000));
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function nsDateToUnixMs(nsdate: number): number {
  return (nsdate + NSDATE_EPOCH_OFFSET_S) * 1000;
}

/** Read every BSSyncronyMetadata row; null when the table is absent (older schema). */
function readSyncronyRows(
  db: ReadableDb,
): Array<{ uuid: string; value: Uint8Array | null }> | null {
  try {
    return db.prepare("SELECT uuid, value FROM BSSyncronyMetadata").all() as Array<{
      uuid: string;
      value: Uint8Array | null;
    }>;
  } catch {
    return null;
  }
}

function computeCloud(db: ReadableDb, nowMs: number): SyncHealth["cloud"] {
  const rows = readSyncronyRows(db);
  if (rows === null || rows.length === 0) {
    return {
      accountAttached: false,
      lastSyncAttempt: null,
      ageSeconds: null,
      keySource: null,
      verdict:
        "no Things Cloud account attached — without one there is no server-side sync signal " +
        "to report (local freshness proxies above still apply)",
    };
  }
  let nsdate: number | null = null;
  let keySource: "known-key" | "nearest-to-now" | null = null;
  const known = rows.find((r) => r.uuid === LAST_SYNC_KEY);
  if (known) {
    const decoded = decodeBplistScalarDouble(known.value);
    if (decoded !== null) {
      nsdate = decoded;
      keySource = "known-key";
    }
  }
  if (nsdate === null) {
    const nowNsDate = nowMs / 1000 - NSDATE_EPOCH_OFFSET_S;
    const doubles = rows
      .map((r) => decodeBplistScalarDouble(r.value))
      .filter((v): v is number => v !== null);
    const picked = selectNearestNsDate(doubles, nowNsDate);
    if (picked !== null) {
      nsdate = picked;
      keySource = "nearest-to-now";
    }
  }
  if (nsdate === null) {
    return {
      accountAttached: true,
      lastSyncAttempt: null,
      ageSeconds: null,
      keySource: null,
      verdict:
        "a Things Cloud account is attached but no last-sync timestamp could be read from the " +
        "sync metadata (the format may have changed)",
    };
  }
  const atMs = nsDateToUnixMs(nsdate);
  const ageSeconds = ageSecondsFrom(nowMs, atMs);
  const via =
    keySource === "nearest-to-now"
      ? " (identified by value, not the expected account key — the key was not present)"
      : "";
  return {
    accountAttached: true,
    lastSyncAttempt: isoOrNull(atMs),
    ageSeconds,
    keySource,
    verdict:
      `last sync attempt ${describeAge(ageSeconds)}${via} — this advances on every attempt, ` +
      "including while offline, so it is not proof of a completed server exchange; pair it with " +
      "network reachability if you need confirmed sync",
  };
}

/** Compact "Ns/Nm/Nh/Nd ago" phrasing; used inside verdict prose. */
export function describeAge(seconds: number | null): string {
  if (seconds === null) return "at an unknown time";
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days}d ago`;
}

/**
 * Compute the sync-health section. Read-only: the caller supplies the already
 * open read-only connection and the resolved database path.
 */
export function computeSyncHealth(
  db: ReadableDb,
  dbPath: string,
  deps: SyncHealthDeps = {},
): SyncHealth {
  const nowMs = (deps.now ?? Date.now)();
  const running = (deps.isAppRunning ?? isThingsRunning)();
  const walStaleSeconds = deps.walStaleSeconds ?? DEFAULT_WAL_STALE_SECONDS;

  // App running.
  const appRunning: SyncHealth["appRunning"] = {
    running,
    verdict: running
      ? "the Things app is running — the database is live and receiving writes"
      : "the Things app is NOT running — the database is frozen (there is no background sync " +
        "daemon); launch Things to resume syncing and writes",
  };

  // WAL freshness.
  const walMtimeMs = (deps.walMtimeMs ?? defaultWalMtimeMs)(`${dbPath}-wal`);
  const walAge = ageSecondsFrom(nowMs, walMtimeMs);
  let wal: SyncHealth["wal"];
  if (walMtimeMs === null) {
    wal = {
      mtime: null,
      ageSeconds: null,
      stale: null,
      verdict:
        "no write-ahead-log sidecar found next to the database — launch Things once so it exists",
    };
  } else if (!running) {
    wal = {
      mtime: isoOrNull(walMtimeMs),
      ageSeconds: walAge,
      stale: null,
      verdict:
        `last database write ${describeAge(walAge)}; the app is not running, so no newer writes ` +
        "are expected (staleness cannot be judged while it is stopped)",
    };
  } else {
    const stale = walAge !== null && walAge > walStaleSeconds;
    wal = {
      mtime: isoOrNull(walMtimeMs),
      ageSeconds: walAge,
      stale,
      verdict: stale
        ? `no database write in ${describeAge(walAge)} even though the app is running — sync or ` +
          "writes may be stuck"
        : `last database write ${describeAge(walAge)} — write activity is fresh`,
    };
  }

  // Last local edit.
  let maxMod: number | null = null;
  try {
    const row = db.prepare("SELECT MAX(userModificationDate) AS m FROM TMTask").get() as
      | { m: number | null }
      | undefined;
    maxMod = row?.m ?? null;
  } catch {
    maxMod = null;
  }
  const editMs = maxMod === null ? null : maxMod * 1000;
  const editAge = ageSecondsFrom(nowMs, editMs);
  const lastLocalEdit: SyncHealth["lastLocalEdit"] = {
    at: isoOrNull(editMs),
    ageSeconds: editAge,
    verdict:
      editMs === null
        ? "no dated items in the library yet"
        : `last content change ${describeAge(editAge)}`,
  };

  // Last foreground.
  const plistPath = deps.foregroundPlistPath ?? defaultForegroundPlistPath(dbPath);
  const foregroundMs = (deps.readForegroundMs ?? defaultReadForegroundMs)(plistPath);
  const lastForeground: SyncHealth["lastForeground"] = {
    at: isoOrNull(foregroundMs),
    verdict:
      foregroundMs === null
        ? "the app's last-foreground time is not recorded on this machine"
        : `the app was last frontmost ${describeAge(ageSecondsFrom(nowMs, foregroundMs))}`,
  };

  return {
    appRunning,
    wal,
    lastLocalEdit,
    lastForeground,
    cloud: computeCloud(db, nowMs),
  };
}
