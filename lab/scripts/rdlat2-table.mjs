// RDLAT2 — render one drive's trace JSONL as a per-HOP table, with the AX
// ROUND-TRIP count each hop's own script reported (issue lineage: #633/DRVLAT1).
//
// DRVLAT1's table answered "where did the milliseconds go?" on a clone. That is
// the wrong question for the field, where the same hop costs ~12x more because
// each Accessibility round-trip does. So this table's headline column is
// `ax` — the round-trips the hop made — and the derived column is the FIELD
// PREDICTION: what the hop would cost at a per-call latency the clone cannot
// reproduce. Pass the field latency as the third argument (default 20 ms/call,
// the maintainer's 2026-09-02 measurement on his M1); the clone's own per-call
// cost is taken from the second-to-last argument (default 1.7 ms).
import { readFileSync } from "node:fs";

const [, , file, tag, fieldMsRaw, labMsRaw] = process.argv;
const FIELD_MS = Number(fieldMsRaw ?? 20);
const LAB_MS = Number(labMsRaw ?? 1.7);
const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const t = (r) => (typeof r.elapsedMs === "number" ? r.elapsedMs : 0);
const starts = rows.filter((r) => r.phase === "ui-dispatch" && r.event === "start");
const ends = rows.filter((r) => r.phase === "ui-dispatch" && r.event === "end");
const stages = rows.filter((r) => r.phase === "stage");
const inv = rows.find((r) => r.phase === "invocation-end");

console.log(`  ================= ${tag} — per-HOP dispatch table =================`);
console.log("  |  # | at ms | gap ms | dur ms | ax | elem | primitive | label |");
console.log("  | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");

let prevEnd = null;
let totalDur = 0;
let totalGap = 0;
let totalAx = 0;
let totalElems = 0;
let axKnown = 0;
for (let i = 0; i < ends.length; i += 1) {
  const end = ends[i];
  const start = starts[i];
  const at = start ? t(start) : t(end) - (end.durationMs ?? 0);
  const gap = prevEnd === null ? at : at - prevEnd;
  prevEnd = t(end);
  totalDur += end.durationMs ?? 0;
  if (i > 0) totalGap += gap;
  if (typeof end.axOps === "number") {
    totalAx += end.axOps;
    axKnown += 1;
  }
  if (typeof end.axElems === "number") totalElems += end.axElems;
  console.log(
    `  | ${i + 1} | ${at} | ${gap} | ${end.durationMs ?? "?"} | ${end.axOps ?? "—"} | ${
      end.axElems ?? "—"
    } | ${end.primitive} | ${end.label}${end.ok === false ? " [FAILED]" : ""} |`,
  );
}

// Hop + round-trip counts by primitive — the two headline numbers.
const byPrim = new Map();
const byPrimMs = new Map();
const byPrimAx = new Map();
const byPrimEl = new Map();
for (const e of ends) {
  byPrim.set(e.primitive, (byPrim.get(e.primitive) ?? 0) + 1);
  byPrimMs.set(e.primitive, (byPrimMs.get(e.primitive) ?? 0) + (e.durationMs ?? 0));
  byPrimAx.set(e.primitive, (byPrimAx.get(e.primitive) ?? 0) + (e.axOps ?? 0));
  byPrimEl.set(e.primitive, (byPrimEl.get(e.primitive) ?? 0) + (e.axElems ?? 0));
}

console.log(`  --- ${tag} hop budget ---`);
console.log("  | primitive | hops | total ms | ax round-trips | elements |");
console.log("  | --- | ---: | ---: | ---: | ---: |");
for (const [p, n] of [...byPrim].toSorted(
  (a, b) => (byPrimMs.get(b[0]) ?? 0) - (byPrimMs.get(a[0]) ?? 0),
)) {
  console.log(
    `  | ${p} | ${n} | ${byPrimMs.get(p) ?? 0} | ${byPrimAx.get(p) ?? 0} | ${byPrimEl.get(p) ?? 0} |`,
  );
}

// The census hops are the per-step focus guard + the MODALX1 preflight; they are
// "resolve" primitives with the census's own stable label, so name them apart.
const censusHops = ends.filter((e) => e.label === "read the window and focus state");
const censusMs = censusHops.reduce((s, e) => s + (e.durationMs ?? 0), 0);

console.log(`  --- ${tag} totals ---`);
console.log(
  `  hops: ${ends.length}   osascript wall: ${totalDur} ms   inter-hop gaps: ${totalGap} ms`,
);
console.log(`  census hops: ${censusHops.length} (${censusMs} ms)`);
console.log(`  ax round-trips: ${totalAx} (reported by ${axKnown}/${ends.length} hops)`);
console.log(
  `  ELEMENT REALIZATIONS: ${totalElems}  ->  at 115 ms/element that is ` +
    `${Math.round((totalElems * 115) / 100) / 10} s of a field drive`,
);
if (totalAx > 0) {
  // The FIELD PREDICTION. Everything that is not an AX round-trip — the process
  // spawns, the in-script settles, the app's own animation time — is taken as
  // host-independent and carried over unchanged; only the round-trip term is
  // rescaled. That is deliberately the CONSERVATIVE direction: a field host is
  // slower at the other terms too, so the prediction is a floor.
  const axLab = totalAx * LAB_MS;
  const rest = Math.max(0, (inv?.elapsedMs ?? totalDur) - axLab);
  console.log(
    `  cost model: ${totalAx} round-trips x ${LAB_MS} ms = ${Math.round(axLab)} ms here; ` +
      `host-independent remainder ${Math.round(rest)} ms`,
  );
  console.log(
    `  predicted at ${FIELD_MS} ms/call: ${Math.round(rest + totalAx * FIELD_MS)} ms end to end`,
  );
}
for (const s of stages) console.log(`  stage ${s.stage} @ ${t(s)} ms`);
const firstHop = ends.length > 0 ? t(starts[0] ?? ends[0]) : 0;
const lastHop = ends.length > 0 ? t(ends[ends.length - 1]) : 0;
if (inv) {
  console.log(
    `  invocation elapsedMs ${inv.elapsedMs}, exit ${inv.exitCode}  ` +
      `(pre-first-hop ${firstHop} ms; post-last-hop tail ${inv.elapsedMs - lastHop} ms)`,
  );
}
