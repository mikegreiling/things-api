/**
 * `--preserve-modified` — the timeline-silent-mutation lever (TAGMOD T5,
 * docs/reference/timestamps.md §4). Some writes re-stamp a row's
 * `userModificationDate` (`umd`) — the key the `changes` view and the future
 * `things watch` feature sort on (the "bump class", timestamps §2a). When the
 * flag is active, the pipeline captures each pre-existing target row's `umd`
 * BEFORE the mutation and, after the change verifies, restores it here through
 * the AppleScript `set modification date` property write — the ONLY surface that
 * writes `umd` (URL has no modification-date field; TAGMOD T5 / novel-paths #44).
 * Net effect: the intended change persists, but the row stays off the umd-keyed
 * timeline.
 *
 * ONE documented limit, carried in the surface copy rather than as
 * per-invocation noise — the 1-SECOND FLOOR: the AppleScript `date` type has no
 * sub-second, so the restore lands on `floor(umd0)`, always ≤ the original and
 * therefore the safe direction for a `changes --since` query (a restored row
 * never re-surfaces). The former "UNSYNCED-only" caveat is RETIRED: SYNC2B
 * (SY-2/SY-2M, golden-v2 / Things 3.22.12) measured the flag SYNC-SAFE — Things
 * Cloud treats `umd` as ordinary per-attribute synced data rather than a
 * monotonic clock, so a hand-written past `umd` propagates to the peer and
 * survives the round trip in both directions.
 *
 * A restore leg is BEST-EFFORT: the mutation has already verified and stands, so
 * a failed restore is disclosed per row (never fatal). One leg per touched
 * pre-existing row; a compound captures before its first leg and restores once
 * after its last.
 *
 * The same legs run on the UNDO side for a write made with the flag (undo.ts,
 * keyed on the audit record's `preModDates`), which is NATIVE PARITY rather than
 * a convenience: UMDZ1 (2026-08-28, golden-v4 / Things 3.23) measured the app's
 * own ⌘Z restoring `umd` to its exact pre-edit value — the stored float,
 * sub-second included — on every undoable gesture it could drive.
 * A `umd` that cannot be restored is disclosed and never changes an operation's
 * reversibility — see undo.ts.
 */
import type { DatabaseSync } from "node:sqlite";

import { escapeAppleScript } from "./vectors/applescript.ts";
import type { WriteVector } from "./vectors/types.ts";

/** A pre-existing row whose `userModificationDate` should be restored. */
export interface ModRestoreTarget {
  uuid: string;
  /** The pre-write `userModificationDate` (epoch seconds, possibly fractional). */
  preUmd: number;
}

/** Per-row failure to restore a `userModificationDate` (non-fatal). */
export interface PreserveModifiedFailure {
  uuid: string;
  detail: string;
}

export interface PreserveModifiedOutcome {
  /** Rows whose `userModificationDate` was restored to `floor(preUmd)`. */
  restored: number;
  /** Rows the restore leg could not neutralize (disclosed, never fatal). */
  failures: PreserveModifiedFailure[];
}

/**
 * A locale-proof AppleScript date literal built from an epoch-seconds instant's
 * HOST-LOCAL wall-clock components — the same construction the `set completion
 * date` / `set creation date` legs use (commands.ts `asDateBlockFromInstant`).
 * AS `current date` lives in the host zone, so re-stamping those components
 * reproduces exactly this instant (floored to the second) as the stored UTC
 * epoch, regardless of the effective zone.
 */
function asDateBlockFromEpoch(varName: string, epochSeconds: number): string[] {
  const d = new Date(Math.floor(epochSeconds) * 1000);
  return [
    `set ${varName} to current date`,
    `set time of ${varName} to ${d.getHours()} * hours + ${d.getMinutes()} * minutes + ${d.getSeconds()}`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
  ];
}

/** The AppleScript `set modification date` program for one row (id-addressed). */
function restorePayload(
  addressor: "to do" | "project",
  uuid: string,
  epochSeconds: number,
): string {
  const statements = [
    ...asDateBlockFromEpoch("umdDate", epochSeconds),
    `set modification date of ${addressor} id "${escapeAppleScript(uuid)}" to umdDate`,
  ];
  return `tell application "Things3"\n  ${statements.join("\n  ")}\nend tell`;
}

/**
 * Restore each target row's `userModificationDate` to `floor(preUmd)` through
 * the AppleScript vector, one `set modification date` leg per row. Every leg is
 * best-effort: a missing AppleScript vector, a vanished row, a non-zero exit, or
 * a `umd` that did not come back down is recorded as a per-row failure and the
 * next target is still attempted. A row addressed as a project (`type = 1`) uses
 * the `project` addressor; every other kind (to-do, id-addressable heading) uses
 * `to do`. Rows absent from the DB are skipped as failures.
 */
export async function restoreModDates(
  db: DatabaseSync,
  vectors: WriteVector[],
  targets: ModRestoreTarget[],
): Promise<PreserveModifiedOutcome> {
  const failures: PreserveModifiedFailure[] = [];
  let restored = 0;
  if (targets.length === 0) return { restored, failures };

  const as = vectors.find((v) => v.id === "applescript");
  if (as === undefined) {
    return {
      restored,
      failures: targets.map((t) => ({
        uuid: t.uuid,
        detail:
          "no AppleScript vector is available to restore the modification date (it is the only " +
          "surface that writes userModificationDate)",
      })),
    };
  }

  const readType = db.prepare("SELECT type FROM TMTask WHERE uuid = ?");
  const readUmd = db.prepare("SELECT userModificationDate AS umd FROM TMTask WHERE uuid = ?");

  for (const t of targets) {
    const row = readType.get(t.uuid) as { type: number } | undefined;
    if (row === undefined) {
      failures.push({
        uuid: t.uuid,
        detail: "the row no longer exists — cannot restore its modification date",
      });
      continue;
    }
    const addressor: "to do" | "project" = row.type === 1 ? "project" : "to do";
    const floored = Math.floor(t.preUmd);
    const payload = restorePayload(addressor, t.uuid, floored);

    let exec;
    try {
      exec = await as.execute({
        vector: "applescript",
        kind: "osascript",
        payload,
        redactedPayload: payload,
      });
    } catch (err) {
      failures.push({
        uuid: t.uuid,
        detail: `the restore leg threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (exec.exitCode !== 0) {
      const tail = exec.stderr.trim() !== "" ? `: ${exec.stderr.trim()}` : "";
      failures.push({
        uuid: t.uuid,
        detail: `the restore leg failed (exit ${exec.exitCode})${tail}`,
      });
      continue;
    }
    // Confirm the umd actually came back DOWN. A silent no-op leaves the row at
    // its post-mutation bump (> preUmd) — the exact signal a restore did not take.
    const post = (readUmd.get(t.uuid) as { umd: number | null } | undefined)?.umd ?? null;
    if (post === null || post > t.preUmd) {
      failures.push({
        uuid: t.uuid,
        detail: `the modification date did not come back down (now ${post ?? "null"}, expected ≤ ${floored})`,
      });
      continue;
    }
    restored += 1;
  }
  return { restored, failures };
}
