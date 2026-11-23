# REORD3242 — the private reorder re-checked on Things 3.24.2: still accepted-and-inert

**Immutable evidence snapshot.** One disposable clone of **`things-lab-golden-v5`** (Things 3.24 build 32400006), **upgraded mid-sitting to Things 3.24.2 build 32402008, direct-download** on the DRPLC1 recipe ([harness.md](harness.md)). macOS 15.7.7 guest, database version **29**, guest clock pinned to **2026-07-05 12:00** and never rolled (trial wall 2026-07-18), airgapped. Run date **2026-11-23**, run twice (two fresh clones). Both clones were deleted at the end; the goldens were never booted. Fixtures fully synthetic.

**This is a TARGETED PROBE, not a certification.** It answers one question — did 3.24.2 restore `_private_experimental_ reorder to dos in …`? — plus the two structural checks (schema, sdef). It does not run `lab:regress`, mint a golden, walk the assumption register, or certify 3.24.2. That campaign (golden-v6 mint + `lab:regress` + the `certified-app-version` stamp) is still pending.

**Method:** `lab/scripts/research-reord3242.sh run`. Raw evidence: gitignored `lab/artifacts/reord3242-lab/` (run 2, the recorded run) and `lab/artifacts/reord3242-lab-run1/`.

---

## 1. Verdict

**The native reorder is STILL accepted-and-inert on 3.24.2, in every scope probed.** Each call parsed, exited 0 with empty stderr, and left the fixture rows byte-identical (full `SELECT *` rows) and the whole `TMTask` table digest unchanged. The ≥ 3.23 version gate (`privateReorderIsNoOp`, `src/write/experimental.ts`) stays correct; nothing lifts.

| Scope (specifier) | Ordering column | Before | Requested | After | osascript | Verdict |
|---|---|---|---|---|---|---|
| `list "Inbox"` | `index` | I3 < I2 < I1 (-2251 / -1704 / -1088) | I1 < I2 < I3 | unchanged | exit 0, no stderr | **INERT** |
| `project id <p>` | `index` | P1 < P2 < P3 (-464 / -252 / 0) | P3 < P2 < P1 | unchanged | exit 0, no stderr | **INERT** |
| `area "R3-AREA"` (by name) | `index` | A3 < A2 < A1 (-729 / -337 / 0) | A1 < A2 < A3 | unchanged | exit 0, no stderr | **INERT** |
| `area id <a>` | `index` | A3 < A2 < A1 (-729 / -337 / 0) | A1 < A2 < A3 | unchanged | exit 0, no stderr | **INERT** |
| `list "Today"` | `todayIndex` | T3 < T2 < T1 (-1435 / -1050 / -476) | T1 < T2 < T3 | unchanged | exit 0, no stderr | **INERT** |

Whole-`TMTask` digest across all five calls: `bbc63beabb6d7885` before and after every cell. Things was still running after the last cell and wrote no crash report. No dialog appeared (the AppleScript round-trips all returned promptly).

Run 1 (first clone) agreed on every scope. Its project cell is not cited above because its title-prefix filter swept the project row itself into the ids list; run 2 restricted every cell to `type = 0` to-dos.

Since the private command produced no change, the destructive side effects that come with it when it DOES act (oddities §9c / §9f / §9k, O06) had nothing to re-check and were not probed.

## 2. Structural checks

| Check | 3.24 (golden-v5) | 3.24.2 (32402008) | Same? |
|---|---|---|---|
| `Meta.databaseVersion` | 29 | 29 (the first 3.24.2 launch ran no migration) | yes |
| Schema fingerprint (`observeSchema`, `src/db/fingerprint.ts`) | `sha256:d2b7e98c…c7d4df` | `sha256:d2b7e98c…c7d4df` | yes — matches `golden-v5-metadata.json` |
| Full `sqlite_master` text (191 rows) | — | — | byte-identical pre vs post |
| `Things.sdef` sha256 | `1b675233…70cde0` | `1b675233…70cde0` | yes — unchanged since 3.22.11 |

## 3. The build

- Fetched from the unversioned direct-download URL (`static.culturedcode.com/things/Things3.zip`, see `vendor/manifest.json`) on 2026-11-23; it served **3.24.2 / CFBundleVersion 32402008**. Banked as `/Volumes/Workspace/things-releases/Things3-3.24.2-32402008.zip`, sha256 `dc6ac6cbc5ec6985e88219723cc5b8f3a6252ef9edd982e98d913a8bd1daa28d`.
- Host-side, without launching: `codesign --verify --deep --strict` passes; signing timestamp 2026-11-11; `LSMinimumSystemVersion` still 13.3.
- The maintainer's host runs the Mac App Store build of the same version, **3.24.2 / 32402507** (Info.plist read only), with a byte-identical sdef.
- `vendor/manifest.json` is NOT updated by this probe; that belongs to the golden-v6 mint.

## 4. Positive control (the trial wall is silent)

After the swap and a warm launch, `make new area` → read back in `TMArea` (2 → 3 rows) → `delete area` → 2 rows. Passed on both runs. The trial clock (`firstAppLaunchDate` 2026-07-03 03:14:28 +0000, read from the group-container plist) was unchanged by the swap.

## 5. Fixtures

All created by the URL scheme into the upgraded clone, synthetic titles only: an area `R3-AREA`, a project `R3-PROJ`, and three to-dos per scope — `R3-I1..3` (Inbox), `R3-P1..3` (in the project), `R3-A1..3` (`when=anytime` in the area), `R3-T1..3` (`when=today`). In each cell the requested order is the reverse of the current DB order, so any effect at all would have shown.

## 6. Notes

- `lab_ssh` absorbed a few password-auth flaps after boot (`Permission denied, please try again`, 2–3 per run), all retried successfully; every fixture landed and every query returned.
