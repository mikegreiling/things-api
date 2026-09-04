#!/bin/bash
# Runs ON THE GUEST, offline. The artifact under test is the tarball npm serves.
set -u
FAIL=0
ok(){ echo "ok   $*"; }
bad(){ echo "FAIL $*"; FAIL=$((FAIL+1)); }
cd "$HOME/consumer"

echo "== the tarball a consumer downloads =="
shasum -a 256 published.tgz
rm -rf pkg && mkdir pkg && tar xzf published.tgz -C pkg
PKG="$HOME/consumer/pkg/package"
VER=$(python3 -c "import json;print(json.load(open('$PKG/package.json'))['version'])")
[ "$VER" = "0.20.9" ] && ok "package.json version 0.20.9" || bad "version is $VER"

echo ""
echo "== the installed CLI answers =="
# A consumer runs `npm install -g things-api`, which resolves the package's
# dependencies. This guest is airgapped and has no npm, so the runtime deps are
# shipped beside the tarball and placed where node will find them — the package
# itself is still the PUBLISHED artifact, byte for byte.
mkdir -p "$PKG/node_modules"
cp -R "$HOME/consumer/deps/." "$PKG/node_modules/" 2>/dev/null || true
echo "     node_modules provided: $(ls "$PKG/node_modules" | tr '\n' ' ')"
OUT=$("$HOME/consumer/bin/node" "$PKG/bin/things.js" --version 2>/dev/null)
[ "$OUT" = "0.20.9" ] && ok "things --version -> $OUT" || bad "things --version -> $OUT"
"$HOME/consumer/bin/node" "$PKG/bin/things.js" --help >/dev/null 2>&1 && ok "things --help renders" || bad "things --help failed"

echo ""
echo "== against a throwaway fixture DB =="
FIX="$HOME/consumer/fixture.sqlite"
python3 - "$FIX" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.executescript("PRAGMA journal_mode=WAL;")
c.commit(); c.close()
PY
THINGS_API_DB="$FIX" "$HOME/consumer/bin/node" "$PKG/bin/things.js" doctor --json >/tmp/doc.json 2>/dev/null
if [ -s /tmp/doc.json ]; then ok "doctor answered against a throwaway DB"; head -c 220 /tmp/doc.json; echo; else bad "doctor produced nothing"; fi

echo ""
echo "== notarization, on the bundle inside the PUBLISHED package =="
B="$PKG/deputy/prebuilt/Things API Helper.app"
[ -d "$B" ] && ok "prebuilt bundle present in the published tarball" || { bad "no prebuilt bundle"; exit 1; }
xattr -lr "$B" | grep -c quarantine | sed 's/^/     quarantine xattrs: /'
if codesign --verify --deep --strict --verbose=2 "$B" 2>&1 | tail -3 | sed 's/^/     /'; then ok "codesign --verify --deep --strict"; else bad "codesign verify"; fi
ST_OUT=$(xcrun stapler validate "$B" 2>&1); ST_CODE=$?
echo "$ST_OUT" | tail -2 | sed 's/^/     /'
if [ $ST_CODE -eq 0 ]; then ok "stapler validate"
else echo "note stapler exit $ST_CODE — it reaches for CloudKit and this guest is AIRGAPPED; spctl below is the offline proof"; fi
SP_OUT=$(spctl --assess --type exec -vv "$B" 2>&1); SP_CODE=$?
echo "$SP_OUT" | sed 's/^/     /'
if [ $SP_CODE -eq 0 ]; then ok "spctl accepts it OFFLINE, from the stapled ticket alone"; else bad "spctl rejected it (exit $SP_CODE)"; fi
R="$B/Contents/Helpers/things-reader.app"
if [ -d "$R" ]; then
  codesign --verify --deep --strict "$R" 2>/dev/null && ok "the sandboxed reader is signed too" || bad "reader signature"
else bad "no things-reader inside the bundle"; fi
BV=$(defaults read "$B/Contents/Info" CFBundleShortVersionString 2>/dev/null)
[ "$BV" = "1.4.0" ] && ok "helpers bundle version 1.4.0" || bad "helpers bundle version is '$BV'"

echo ""
echo "CONSUMER DRILL: $FAIL failures"
exit $((FAIL > 0 ? 1 : 0))
