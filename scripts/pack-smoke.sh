#!/bin/bash
# Release smoke: pack the tarball, install it into a scratch project, and
# prove the installed `things` bin works end-to-end against a throwaway
# fixture DB (no Things install needed). Guards the files/exports/bin wiring
# that unit tests can't see.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)

npm run build >/dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARBALL=$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)
echo "[pack-smoke] packed $TARBALL"

cd "$WORK"
npm init -y >/dev/null 2>&1
npm install "./$TARBALL" >/dev/null 2>&1

# The prebuilt helper bundle (CI-produced; present only during a release run
# or a local rehearsal) must survive packing INTACT: a directory name with a
# space, and executables that arrive without their +x bit are a bundle launchd
# cannot start. npm normalizes modes on pack, so this is asserted, not assumed.
PREBUILT="$REPO/deputy/prebuilt/Things API Helper.app"
if [ -d "$PREBUILT" ]; then
  echo "[pack-smoke] prebuilt helpers present — asserting they survive packing"
  if [ -n "$(find "$PREBUILT" -type l)" ]; then
    echo "[pack-smoke] FAIL — the bundle contains symlinks; npm tarballs are not a safe carrier for them" >&2
    exit 1
  fi
  INSTALLED="node_modules/things-api/deputy/prebuilt/Things API Helper.app"
  for exe in "Contents/MacOS/things-deputy" \
    "Contents/Helpers/things-reader.app/Contents/MacOS/things-reader"; do
    # Only assert what the source bundle actually carries: a host without an
    # Apple-issued chain builds a deputy-only bundle (no nested reader).
    [ -e "$PREBUILT/$exe" ] || continue
    if [ ! -x "$INSTALLED/$exe" ]; then
      echo "[pack-smoke] FAIL — $exe missing or not executable after install" >&2
      exit 1
    fi
  done
  echo "[pack-smoke] prebuilt helper executables survived the tarball"
fi

# Build the fixture and KEEP THE HANDLE OPEN while the CLI runs: read-only
# WAL opens require the -wal/-shm sidecars, which a clean close checkpoints
# away (same reason doctor tells users to launch Things once).
REPO="$REPO" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const ddl = readFileSync(process.env.REPO + '/test/fixtures/schema-v26.sql', 'utf8');
const db = new DatabaseSync('fixture.sqlite');
db.exec('PRAGMA journal_mode = WAL;');
db.exec(ddl);
db.prepare(\"INSERT INTO Meta (key, value) VALUES ('databaseVersion', ?)\").run(
  '<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><integer>26</integer></plist>');

const bin = 'node_modules/.bin/things';
const run = (args) => execFileSync(bin, args, { encoding: 'utf8' });
run(['--help']);
const doctor = run(['doctor', '--db', 'fixture.sqlite', '--json']);
if (!doctor.includes('\"status\":\"ok\"')) throw new Error('doctor fingerprint not ok: ' + doctor);
const today = run(['today', '--db', 'fixture.sqlite', '--json']);
if (!today.includes('\"ok\":true')) throw new Error('today read failed: ' + today);
const caps = run(['capabilities', '--op', 'todo.add', '--json']);
if (!caps.includes('\"support\":\"yes\"')) throw new Error('capabilities missing: ' + caps);
db.close();
console.log('[pack-smoke] GREEN — tarball installs and the bin works');
"
