// Evidence assembly + verdicts: joins guest execution records, snapshots,
// and the monitor event log into one evidence record per probe, then judges
// each against the suite's expectations.

import { compareAppVersions } from "../../src/write/experimental.ts";
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
  ProbeExpectation,
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

/**
 * Probes the automated run actually executes and judges. "interactive" probes
 * (e.g. delete-class Shortcuts with no Always-Allow, oddities 5j) re-prompt
 * every run and cannot ride lab:run/regress — they stay in the suite JSON as
 * documentation for human sittings but are excluded from execution, evaluation,
 * and the green gate. The guest runner drops them from its execution list too,
 * so the two sides agree.
 */
export function activeProbes(probes: ProbeSpec[]): ProbeSpec[] {
  return probes.filter((p) => p.group !== "interactive");
}

export interface ResolvedExpectation {
  expect: ProbeExpectation;
  /** The `fromVersion` of the override that applied, or null for the base `expect`. */
  appliedFrom: string | null;
  because: string | null;
}

/**
 * Pick the expectation that describes THIS app version: the `expectFrom`
 * override with the highest `fromVersion` that the golden's version is at or
 * past, else the base `expect`.
 *
 * An unreadable/unparseable app version resolves to the base expectation —
 * the same fail-open posture the shipped version gate takes
 * (`privateReorderIsNoOp`): we never invent a behavioral claim about a version
 * we cannot identify.
 */
export function resolveExpectation(
  probe: ProbeSpec,
  thingsVersion: string | null,
): ResolvedExpectation {
  let best: ResolvedExpectation = { expect: probe.expect, appliedFrom: null, because: null };
  for (const candidate of probe.expectFrom ?? []) {
    if ((compareAppVersions(thingsVersion, candidate.fromVersion) ?? -1) < 0) continue;
    if (
      best.appliedFrom !== null &&
      (compareAppVersions(candidate.fromVersion, best.appliedFrom) ?? 0) <= 0
    ) {
      continue;
    }
    best = {
      expect: candidate.expect,
      appliedFrom: candidate.fromVersion,
      because: candidate.because,
    };
  }
  return best;
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
      appliedFrom: record.expected.appliedFrom,
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
  const resolved = resolveExpectation(probe, env.thingsVersion);
  const expect = resolved.expect;
  const expectCrash = expect.crash ?? false;

  // Transport: every exec must have run; non-zero exits fail unless allowed.
  for (const err of execution.errors) failures.push(`guest error: ${err}`);
  if (expect.allowNonzeroExit !== true) {
    for (const cmd of execution.commands) {
      if (cmd.exitCode !== 0) {
        failures.push(`command exited ${cmd.exitCode}: ${cmd.resolved}`);
      }
    }
  }
  if (expect.allowUnsatisfiedWaits !== true) {
    for (const wait of execution.waits) {
      if (!wait.satisfied) failures.push(`wait not satisfied: ${wait.sql}`);
    }
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
  if (disruption.tier !== expect.tier) {
    failures.push(`tier ${disruption.tier} observed, expected ${expect.tier}`);
  }

  const results = evaluateAssertions(expect.assertions, before, after, delta, {
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
    verdict: failures.length === 0 ? expect.verdict : "mismatch",
    expected: {
      verdict: expect.verdict,
      tier: expect.tier,
      crash: expectCrash,
      appliedFrom: resolved.appliedFrom,
      because: resolved.because,
    },
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
  for (const id of [...ids].toSorted()) {
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
