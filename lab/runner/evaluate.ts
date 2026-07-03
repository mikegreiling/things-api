// Evidence assembly + verdicts: joins guest execution records, snapshots,
// and the monitor event log into one evidence record per probe, then judges
// each against the suite's expectations.

import type { AssertionContext } from "./assertions.ts";
import { evaluateAssertions } from "./assertions.ts";
import { diffSnapshots } from "./differ.ts";
import { computeDisruption, sliceEvents } from "./tier.ts";
import type {
  DbSnapshot,
  EvidenceEnv,
  EvidenceRecord,
  ExecutionRecord,
  MonitorEvent,
  ProbeSpec,
  VerdictsFile,
} from "./types.ts";

export interface ProbeArtifacts {
  execution: ExecutionRecord;
  before: DbSnapshot;
  after: DbSnapshot;
}

export interface EvaluatedRun {
  evidence: EvidenceRecord[];
  verdicts: VerdictsFile;
  ok: boolean;
}

export function evaluateRun(
  probes: ProbeSpec[],
  artifacts: Map<string, ProbeArtifacts>,
  events: MonitorEvent[],
  context: AssertionContext,
  env: EvidenceEnv,
): EvaluatedRun {
  const evidence: EvidenceRecord[] = [];
  const verdicts: VerdictsFile = {};

  for (const probe of probes) {
    const art = artifacts.get(probe.id);
    if (art === undefined) {
      verdicts[probe.id] = {
        ok: false,
        verdict: "mismatch",
        tier: -1,
        crash: false,
        failures: ["no execution record (guest run incomplete)"],
      };
      continue;
    }

    const record = evaluateProbe(probe, art, events, context, env);
    evidence.push(record);
    verdicts[probe.id] = {
      ok: record.failures.length === 0,
      verdict: record.verdict,
      tier: record.disruption.tier,
      crash: record.crash?.pidDied ?? false,
      failures: record.failures,
    };
  }

  const ok = probes.every((p) => verdicts[p.id]?.ok === true);
  return { evidence, verdicts, ok };
}

export function evaluateProbe(
  probe: ProbeSpec,
  art: ProbeArtifacts,
  events: MonitorEvent[],
  context: AssertionContext,
  env: EvidenceEnv,
): EvidenceRecord {
  const { execution, before, after } = art;
  const failures: string[] = [];

  const delta = diffSnapshots(before, after);
  const disruption = computeDisruption(sliceEvents(events, probe.id));
  const expectCrash = probe.expect.crash ?? false;

  // Transport: every exec must have run; non-zero exits fail unless allowed.
  for (const err of execution.errors) failures.push(`guest error: ${err}`);
  if (probe.expect.allowNonzeroExit !== true) {
    for (const cmd of execution.commands) {
      if (cmd.exitCode !== 0) {
        failures.push(`command exited ${cmd.exitCode}: ${cmd.resolved}`);
      }
    }
  }
  for (const wait of execution.waits) {
    if (!wait.satisfied) failures.push(`wait not satisfied: ${wait.sql}`);
  }

  // Crash expectation must match observation exactly.
  if (execution.crash.pidDied !== expectCrash) {
    failures.push(
      expectCrash
        ? "expected a crash but Things survived"
        : `unexpected crash (ips: ${execution.crash.ipsFiles.join(", ") || "none"})`,
    );
  }

  // Disruption tier must match exactly — tier drift is a real finding.
  if (disruption.tier !== probe.expect.tier) {
    failures.push(`tier ${disruption.tier} observed, expected ${probe.expect.tier}`);
  }

  const results = evaluateAssertions(probe.expect.assertions, before, after, delta, {
    ...context,
    commands: execution.commands,
    before,
  });
  for (const r of results) {
    if (!r.ok) failures.push(`assertion ${r.assertion.kind} failed: ${r.detail}`);
  }

  const started = Date.parse(execution.startedAt);
  const ended = Date.parse(execution.endedAt);

  return {
    probe_id: probe.id,
    legacy_ref: probe.legacyRef ?? null,
    vector: probe.vector,
    operation: probe.operation,
    app_state_before: probe.appState,
    commands: execution.commands,
    waits: execution.waits,
    started_at: execution.startedAt,
    duration_ms: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : -1,
    db_delta: delta,
    disruption,
    crash: execution.crash.pidDied || execution.crash.ipsFiles.length > 0 ? execution.crash : null,
    verdict: failures.length === 0 ? probe.expect.verdict : "mismatch",
    expected: { verdict: probe.expect.verdict, tier: probe.expect.tier, crash: expectCrash },
    failures,
    env,
  };
}

/** Compare two runs' verdicts: the harness acceptance gate. */
export function compareVerdicts(
  a: VerdictsFile,
  b: VerdictsFile,
): { identical: boolean; diffs: string[] } {
  const diffs: string[] = [];
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of [...ids].sort()) {
    const va = a[id];
    const vb = b[id];
    if (va === undefined || vb === undefined) {
      diffs.push(`${id}: present in only one run`);
      continue;
    }
    if (va.ok !== vb.ok) diffs.push(`${id}: ok ${va.ok} vs ${vb.ok}`);
    if (va.verdict !== vb.verdict) diffs.push(`${id}: verdict ${va.verdict} vs ${vb.verdict}`);
    if (va.tier !== vb.tier) diffs.push(`${id}: tier ${va.tier} vs ${vb.tier}`);
    if (va.crash !== vb.crash) diffs.push(`${id}: crash ${va.crash} vs ${vb.crash}`);
  }
  return { identical: diffs.length === 0, diffs };
}
