#!/bin/bash
# SX5 — find-items filter REPAIR + malformed-predicate CRASH discrimination
# (the queued VM work in s-campaign-results.md "Real-hardware validation +
# corrections (2026-07-10)"). ONE clone.
#
# Zero-cost evidence already banked (host read of the Things 3.22.11 bundle,
# no app interaction): ThingsCommon.framework/…/Metadata.appintents/
# extract.actionsdata → TAIItemEntity properties include identifier "title"
# (display key "Title"); there is NO "name" property. TAIItemQuery gives
# title comparators [0,6,7,8] (equals/contains/begins/ends). So the prod
# crash used a NONEXISTENT property identifier; the repair candidate is
# Property "title".
#
# Strategy: DB surgery on the ALREADY-CONSENTED golden-resident
# things-proxy-find-items — Shortcuts consent is keyed to shortcut identity,
# not action content, so swapping ZSHORTCUTACTIONS.ZDATA for a candidate
# bplist should run headless (siriactionsd owns the DB; kill it first, it
# relaunches on demand and rereads).
#
#   SX5-0   baseline unmodified proxy: echoes input (consent inherited)
#   SX5-1   v-title-is, mis-cased query "lab-inbox-1" → stored casing
#           "LAB-INBOX-1" = REAL MATCH (the case-fold discriminator);
#           verbatim echo = surgery didn't take; empty = case-sensitive miss
#   SX5-2   v-title-is, exact query "LAB-INBOX-1"
#   SX5-3   v-title-is, no-match query (empty output vs error)
#   SX5-4/5 v-title-contains, mis-cased + no-match (fallback + extra evidence)
#   SX5-C1  v-name-is — the EXACT prod-crasher shape (Property "name") — x2:
#           Things alive? new .ips? reproducible = oddities §7 C4
#   SX5-C2  v-garbage-prop (Property "zzzNotAProperty")
#   SX5-C3  v-bad-operator (Operator 987654)
#   SX5-F   restore v-title-is, readback-verify blob, final sanity run
#
# Discovery: no assertions. All evidence lands in $OUT (report, per-probe
# outputs, any new DiagnosticReports .ips, post-surgery readback blobs).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-sx5-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx5] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx5] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# ---------------------------------------------------------------- extraction
note "== extract the golden-resident find-items ZDATA (base for all variants) =="
lab_ssh "$IP" 'mkdir -p /tmp/sx5 && sqlite3 -readonly ~/Library/Shortcuts/Shortcuts.sqlite "SELECT writefile(\"/tmp/sx5/orig.bplist\", ZDATA) FROM ZSHORTCUTACTIONS WHERE Z_PK=(SELECT ZACTIONS FROM ZSHORTCUT WHERE ZNAME=\"things-proxy-find-items\")" >/dev/null && ls -l /tmp/sx5/orig.bplist' </dev/null | tee -a "$REPORT"
lab_scp "$LAB_SSH_USER@$IP:/tmp/sx5/orig.bplist" "$OUT/orig.bplist" </dev/null

note "== host: build candidate variant bplists =="
mkdir -p "$OUT/variants"
python3 - "$OUT/orig.bplist" "$OUT/variants" <<'PYEOF' | tee -a "$REPORT"
import plistlib, sys, copy
src, outdir = sys.argv[1], sys.argv[2]
actions = plistlib.load(open(src, "rb"))
assert actions[1]["WFWorkflowActionIdentifier"] == "com.culturedcode.ThingsMac.TAIItemEntity"
DICT_UUID = actions[0]["WFWorkflowActionParameters"]["UUID"]  # detect.dictionary

def token_string(dict_key):
    return {"Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": {
        "Type": "ActionOutput", "OutputName": "Dictionary", "OutputUUID": DICT_UUID,
        "Aggrandizements": [{"Type": "WFDictionaryValueVariableAggrandizement",
                             "DictionaryKey": dict_key}]}}},
        "WFSerializationType": "WFTextTokenString"}

def build(prop, operator, unit=4, limit=True):
    out = copy.deepcopy(actions)
    p = out[1]["WFWorkflowActionParameters"]
    p.pop("WFContentItemInputParameter", None)  # the stray echo-maker
    if limit:
        p["WFContentItemLimitEnabled"] = True
        p["WFContentItemLimitNumber"] = 1.0
    p["WFContentItemFilter"] = {"Value": {
        "WFActionParameterFilterPrefix": 1,
        "WFContentPredicateBoundedDate": False,
        "WFActionParameterFilterTemplates": [{
            "Property": prop, "Operator": operator, "Removable": True,
            "Values": {"Unit": unit, "String": token_string("search")}}]},
        "WFSerializationType": "WFContentPredicateTableTemplate"}
    return out

variants = {
    "v-title-is": build("title", 4),         # Operator 4 = "is" (edit-title's working id op)
    "v-title-contains": build("title", 99),  # WF "contains" fallback
    "v-name-is": build("name", 4),           # the exact prod-crasher (nonexistent property)
    "v-garbage-prop": build("zzzNotAProperty", 4),
    "v-bad-operator": build("title", 987654),
}
for name, acts in variants.items():
    plistlib.dump(acts, open(f"{outdir}/{name}.bplist", "wb"), fmt=plistlib.FMT_BINARY)
    print("built", name)
PYEOF
for v in "$OUT"/variants/*.bplist; do
  lab_scp "$v" "$LAB_SSH_USER@$IP:/tmp/sx5/" </dev/null
done
lab_ssh "$IP" 'ls -l /tmp/sx5/' </dev/null | tee -a "$REPORT"

# ------------------------------------------------------------------- helpers
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }

surgery() { # surgery <variant-basename>  (v-title-is | … | orig)
  note "== surgery: inject $1 =="
  lab_ssh "$IP" "pkill -x siriactionsd 2>/dev/null; pkill -x Shortcuts 2>/dev/null; pkill -f 'Shortcuts Events' 2>/dev/null; sleep 2
    for i in 1 2 3 4 5; do
      sqlite3 ~/Library/Shortcuts/Shortcuts.sqlite \"UPDATE ZSHORTCUTACTIONS SET ZDATA=readfile('/tmp/sx5/$1.bplist') WHERE Z_PK=(SELECT ZACTIONS FROM ZSHORTCUT WHERE ZNAME='things-proxy-find-items')\" 2>&1 && break
      echo \"[locked, retry \$i]\"; sleep 2
    done
    rm -f /tmp/sx5-readback.bplist
    sqlite3 -readonly ~/Library/Shortcuts/Shortcuts.sqlite \"SELECT writefile('/tmp/sx5-readback.bplist', ZDATA) FROM ZSHORTCUTACTIONS WHERE Z_PK=(SELECT ZACTIONS FROM ZSHORTCUT WHERE ZNAME='things-proxy-find-items')\" >/dev/null
    cmp -s /tmp/sx5/$1.bplist /tmp/sx5-readback.bplist && echo '[readback IDENTICAL]' || echo '[readback MISMATCH]'" </dev/null | tee -a "$REPORT"
}

run() { # run <label> <json>
  note "-- [$1] shortcuts run things-proxy-find-items  input=$2"
  lab_ssh "$IP" "ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null > /tmp/sx5-dr-pre.txt
    PRE_PID=\$(pgrep -x Things3 || echo none)
    printf '%s' $(printf '%q' "$2") > /tmp/sx5-in.json
    rm -f /tmp/sx5-out-$1.txt
    perl -e 'alarm 75; exec @ARGV' shortcuts run things-proxy-find-items --input-path /tmp/sx5-in.json --output-path /tmp/sx5-out-$1.txt 2>&1
    RC=\$?
    echo \"[exit \$RC]\"
    [ \$RC -eq 142 ] && { echo '[TIMEOUT — modal suspected, screenshotting]'; screencapture -x /tmp/sx5-modal-$1.png 2>/dev/null; }
    if [ -f /tmp/sx5-out-$1.txt ]; then echo \"[output] >>>\$(cat /tmp/sx5-out-$1.txt)<<<\"; else echo '[output] <no output file>'; fi
    POST_PID=\$(pgrep -x Things3 || echo DEAD)
    echo \"[things pid] pre=\$PRE_PID post=\$POST_PID\"
    NEW_DR=\$(ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | diff /tmp/sx5-dr-pre.txt - | sed -n 's/^> //p')
    echo \"[new diagnostic reports] \${NEW_DR:-none}\"" </dev/null 2>&1 | tee -a "$REPORT" || true
  sleep 2
}

things_up() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null || { open -g -a Things3; sleep 10; }' </dev/null; }

# ------------------------------------------------------------------ campaign
note "== warm-up: launch Things =="
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
note "fixture check (LAB-INBOX-1 stored casing):"
gq "SELECT uuid, title FROM TMTask WHERE uuid='2Zgf538GeSJDroZX1cFdEU'" | tee -a "$REPORT"

note "== [SX5-0] baseline: UNMODIFIED proxy (expect verbatim echo) =="
run "SX5-0" '{"search":"sx5 baseline echo probe"}'

surgery v-title-is
note "== [SX5-1] v-title-is, MIS-CASED query (the case-fold discriminator) =="
run "SX5-1" '{"search":"lab-inbox-1"}'
note "== [SX5-2] v-title-is, exact-cased query =="
run "SX5-2" '{"search":"LAB-INBOX-1"}'
note "== [SX5-3] v-title-is, no-match query =="
run "SX5-3" '{"search":"SX5-NO-SUCH-ITEM-XYZ"}'

surgery v-title-contains
note "== [SX5-4] v-title-contains, mis-cased substring =="
run "SX5-4" '{"search":"lab-inbox"}'
note "== [SX5-5] v-title-contains, no-match =="
run "SX5-5" '{"search":"SX5-NO-SUCH-ITEM-XYZ"}'

note "== crash discrimination =="
things_up
surgery v-name-is
note "== [SX5-C1a] v-name-is — the EXACT prod-crasher shape, run 1 =="
run "SX5-C1a" '{"search":"lab-inbox-1"}'
things_up
note "== [SX5-C1b] v-name-is, run 2 (reproducibility) =="
run "SX5-C1b" '{"search":"anything at all"}'
things_up
surgery v-garbage-prop
note "== [SX5-C2] v-garbage-prop =="
run "SX5-C2" '{"search":"lab-inbox-1"}'
things_up
surgery v-bad-operator
note "== [SX5-C3] v-bad-operator =="
run "SX5-C3" '{"search":"lab-inbox-1"}'
things_up

note "== [SX5-F] restore v-title-is + final sanity =="
surgery v-title-is
run "SX5-F" '{"search":"lab-inbox-1"}'

# ------------------------------------------------------------------ evidence
note "== ship evidence: outputs + screenshots + any Things3 .ips =="
lab_ssh "$IP" 'cd /tmp && tar cf - sx5-out-*.txt sx5-modal-*.png 2>/dev/null || true' </dev/null | (cd "$OUT" && tar xf - 2>/dev/null) || true
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null' </dev/null | tee -a "$REPORT" || true
lab_ssh "$IP" 'cd ~/Library/Logs/DiagnosticReports 2>/dev/null && tar cf - Things3*.ips 2>/dev/null || true' </dev/null | (cd "$OUT" && tar xf - 2>/dev/null) || true
ls -la "$OUT/" | tee -a "$REPORT"
note "DONE. Report: $REPORT"
