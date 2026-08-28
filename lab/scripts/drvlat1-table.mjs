// DRVLAT1 — render one drive's trace JSONL as a per-HOP table (issue #633).
//
// The existing PERF2 aggregator grouped by (primitive, label), which hides the
// thing this campaign is about: a recipe STEP dispatches several osascript HOPS
// (a candidate-resolution probe, a focus-guard census, then the action), and the
// question is where the milliseconds live across all of them. So this prints
// every hop in dispatch order, plus the GAP before each hop — which is where the
// fixed settles and the in-JS sleeps show up — and the post-drive verify tail.
import { readFileSync } from "node:fs";

const [, , file, tag] = process.argv;
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
console.log("  |  # | at ms | gap ms | dur ms | primitive | label |");
console.log("  | ---: | ---: | ---: | ---: | --- | --- |");

let prevEnd = null;
let totalDur = 0;
let totalGap = 0;
for (let i = 0; i < ends.length; i += 1) {
  const end = ends[i];
  const start = starts[i];
  const at = start ? t(start) : t(end) - (end.durationMs ?? 0);
  const gap = prevEnd === null ? at : at - prevEnd;
  prevEnd = t(end);
  totalDur += end.durationMs ?? 0;
  if (i > 0) totalGap += gap;
  console.log(
    `  | ${i + 1} | ${at} | ${gap} | ${end.durationMs ?? "?"} | ${end.primitive} | ${end.label}${
      end.ok === false ? " [FAILED]" : ""
    } |`,
  );
}

// Hop counts by primitive — the headline number this campaign moves.
const byPrim = new Map();
for (const e of ends) byPrim.set(e.primitive, (byPrim.get(e.primitive) ?? 0) + 1);
const byPrimMs = new Map();
for (const e of ends)
  byPrimMs.set(e.primitive, (byPrimMs.get(e.primitive) ?? 0) + (e.durationMs ?? 0));

console.log(`  --- ${tag} hop budget ---`);
console.log("  | primitive | hops | total ms |");
console.log("  | --- | ---: | ---: |");
for (const [p, n] of [...byPrim].toSorted(
  (a, b) => (byPrimMs.get(b[0]) ?? 0) - (byPrimMs.get(a[0]) ?? 0),
)) {
  console.log(`  | ${p} | ${n} | ${byPrimMs.get(p) ?? 0} |`);
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
for (const s of stages) console.log(`  stage ${s.stage} @ ${t(s)} ms`);
const firstHop = ends.length > 0 ? t(starts[0] ?? ends[0]) : 0;
const lastHop = ends.length > 0 ? t(ends[ends.length - 1]) : 0;
if (inv) {
  console.log(
    `  invocation elapsedMs ${inv.elapsedMs}, exit ${inv.exitCode}  ` +
      `(pre-first-hop ${firstHop} ms; post-last-hop tail ${inv.elapsedMs - lastHop} ms)`,
  );
}
