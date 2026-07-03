// Full probe-run orchestration:
//   preflight → clone → boot → bootstrap (pin clock BEFORE Things launches,
//   verify monitor, warm-up launch+quit, fingerprint assert) → execute suite
//   serially on the guest → collect artifacts → evaluate host-side → teardown.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { observeSchema } from "../../src/db/fingerprint.ts";
import type { AssertionContext } from "./assertions.ts";
import { evaluateRun } from "./evaluate.ts";
import { log, run, scp, sleep, ssh, sshStreaming, SSH_USER, TART_HOME } from "./sh.ts";
import { parseEventLog } from "./tier.ts";
import {
  gcRunVms,
  RUN_VM_PREFIX,
  tartClone,
  tartDelete,
  tartList,
  tartRunDetached,
  tartStop,
  waitForSsh,
} from "./tart.ts";
import type { DbSnapshot, ExecutionRecord, ProbeSpec, SuiteSpec, VerdictsFile } from "./types.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const GOLDEN = "things-lab-golden-v1";
const GUEST_HARNESS = "things-lab/harness";
const GUEST_RUN = "things-lab/run";
const MIN_FREE_GB = 10;

interface GoldenMetadata {
  golden: string;
  thingsVersion: string;
  pinnedDate: string;
  uriSchemeAuthToken: string;
  schemaFingerprint: string;
}

export interface RunOptions {
  suitePath: string;
  keepVm?: boolean;
  skipGc?: boolean;
}

export interface RunOutcome {
  runId: string;
  artifactsDir: string;
  ok: boolean;
  exitCode: number;
}

export async function executeRun(options: RunOptions): Promise<RunOutcome> {
  const suite = JSON.parse(readFileSync(options.suitePath, "utf8")) as SuiteSpec;
  const metadata = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs/lab/golden-v1-metadata.json"), "utf8"),
  ) as GoldenMetadata;
  const seed = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs/lab/seed-manifest.json"), "utf8"),
  ) as Record<string, { uuid: string }>;

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const runId = `${suite.suite}-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
  const vm = `${RUN_VM_PREFIX}${runId}`;
  const artifactsDir = join(REPO_ROOT, "lab/artifacts", runId);
  mkdirSync(join(artifactsDir, "evidence"), { recursive: true });

  preflight();
  if (options.skipGc !== true) {
    const strays = gcRunVms();
    if (strays.length > 0) log(`gc: removed stray run VM(s): ${strays.join(", ")}`);
  }

  const startedAt = new Date().toISOString();
  log(`run ${runId}: cloning ${GOLDEN} -> ${vm}`);
  tartClone(GOLDEN, vm);

  let ok = false;
  let exitCode = 1;
  try {
    log("booting (headless, NAT; airgapped guest-side at bootstrap)…");
    tartRunDetached(vm, join(artifactsDir, "tart-run.log"));
    let ip: string;
    try {
      ip = await waitForSsh(vm);
    } catch (err) {
      const bootLog = readFileSync(join(artifactsDir, "tart-run.log"), "utf8").trim();
      throw new Error(
        `${(err as Error).message}${bootLog ? `\ntart run output:\n${bootLog}` : ""}`,
      );
    }
    log(`ssh up at ${ip}`);

    await bootstrap(ip, metadata, artifactsDir);

    log(`executing suite "${suite.suite}" (${suite.probes.length} probes)…`);
    pushBundle(ip, options.suitePath, metadata, seed);
    const guestExit = await sshStreaming(
      ip,
      `python3 ${GUEST_HARNESS}/probe-runner.py --suite ${GUEST_HARNESS}/suite.json ` +
        `--context ${GUEST_HARNESS}/context.json --out ~/${GUEST_RUN}`,
    );
    if (guestExit !== 0) throw new Error(`guest probe-runner exited ${guestExit}`);

    log("collecting artifacts…");
    collect(ip, artifactsDir);

    log("evaluating evidence…");
    const verdicts = evaluate(suite, metadata, seed, artifactsDir, runId);
    ok = suite.probes.every((p) => verdicts[p.id]?.ok === true);
    exitCode = ok ? 0 : 1;

    writeFileSync(
      join(artifactsDir, "run-meta.json"),
      JSON.stringify(
        {
          runId,
          suite: suite.suite,
          golden: GOLDEN,
          vm,
          startedAt,
          endedAt: new Date().toISOString(),
          ok,
        },
        null,
        2,
      ),
    );
  } finally {
    if (options.keepVm === true) {
      log(`--keep-vm: ${vm} left running for debugging`);
    } else {
      log(`teardown: stopping + deleting ${vm}`);
      tartStop(vm);
      tartDelete(vm);
    }
  }

  log(`run ${runId}: ${ok ? "GREEN" : "RED"} — artifacts in ${artifactsDir}`);
  return { runId, artifactsDir, ok, exitCode };
}

function preflight(): void {
  for (const tool of ["tart", "sshpass"]) {
    const r = run(["which", tool], { allowFailure: true });
    if (r.exitCode !== 0) throw new Error(`preflight: ${tool} not found on PATH`);
  }
  if (!tartList().includes(GOLDEN)) {
    throw new Error(`preflight: golden image "${GOLDEN}" not found (TART_HOME=${TART_HOME})`);
  }
  const df = run(["df", "-g", TART_HOME]);
  const lastLine = df.stdout.trim().split("\n").at(-1) ?? "";
  const freeGb = Number(lastLine.split(/\s+/)[3] ?? "0");
  if (freeGb < MIN_FREE_GB) {
    throw new Error(`preflight: only ${freeGb}GB free on ${TART_HOME} (need ${MIN_FREE_GB})`);
  }
}

async function bootstrap(
  ip: string,
  metadata: GoldenMetadata,
  artifactsDir: string,
): Promise<void> {
  // Airgap FIRST: delete the guest's default route. SSH survives (host and
  // guest share the directly connected vmnet subnet); internet, updaters,
  // and any phone-home become unroutable. (--net-host would need Softnet
  // with host root — see tartRunDetached.)
  log("airgapping guest (deleting default route)…");
  ssh(ip, "sudo route -n delete default", { allowFailure: true });
  const net = ssh(ip, "ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo up || echo down");
  if (net.stdout.trim() !== "down") {
    throw new Error("bootstrap: guest still has internet access after route deletion");
  }

  // Pin the clock BEFORE Things ever launches in this clone: neutralizes
  // trial expiry and freezes Today/Upcoming semantics (docs/design/lab.md §1.6).
  const [y = "2026", m = "07", d = "05"] = metadata.pinnedDate.split("-");
  log(`pinning guest clock to ${metadata.pinnedDate} 12:00`);
  ssh(ip, "sudo systemsetup -setusingnetworktime off");
  ssh(ip, `sudo date ${m}${d}1200${y}`);

  const agent = ssh(ip, "launchctl print gui/$(id -u)/com.thingslab.disruption-monitor", {
    allowFailure: true,
  });
  if (agent.exitCode !== 0 || !agent.stdout.includes("state = running")) {
    throw new Error("bootstrap: disruption-monitor LaunchAgent is not running in the Aqua session");
  }
  log("disruption-monitor: running");

  // Push the harness early so its utility modes drive the warm-up checks.
  ssh(ip, `mkdir -p ${GUEST_HARNESS} ${GUEST_RUN}`);
  scp([
    join(REPO_ROOT, "lab/guest/probe-runner.py"),
    `${SSH_USER}@${ip}:${GUEST_HARNESS}/probe-runner.py`,
  ]);

  // Warm-up: one background launch so the app recomputes Today buckets and
  // repeat instances for the pinned date, then a clean quit. The baseline
  // snapshot (and every probe) sees steady state.
  log("warm-up: launching Things in background…");
  ssh(ip, "open -g -a Things3");
  await waitForGuest(ip, `python3 ${GUEST_HARNESS}/probe-runner.py --check-db`, 60);
  await sleep(10_000);
  ssh(ip, `osascript -e 'tell application "Things3" to quit'`);
  await waitForGuest(ip, "! pgrep -x Things3", 30);
  log("warm-up complete (Things quit cleanly)");

  ssh(ip, `python3 ${GUEST_HARNESS}/probe-runner.py --copy-db ~/${GUEST_RUN}/db-baseline.sqlite`);
  scp([
    `${SSH_USER}@${ip}:${GUEST_RUN}/db-baseline.sqlite`,
    join(artifactsDir, "db-baseline.sqlite"),
  ]);

  const db = new DatabaseSync(join(artifactsDir, "db-baseline.sqlite"), { readOnly: true });
  let fingerprint: string;
  try {
    fingerprint = observeSchema(db).fingerprint;
  } finally {
    db.close();
  }
  if (fingerprint !== metadata.schemaFingerprint) {
    throw new Error(
      `bootstrap: schema fingerprint mismatch — golden metadata ${metadata.schemaFingerprint}, ` +
        `observed ${fingerprint}. Refusing to probe against drifted schema (exit 5).`,
    );
  }
  log(`schema fingerprint verified (${fingerprint.slice(0, 20)}…)`);
}

async function waitForGuest(ip: string, command: string, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const r = ssh(ip, command, { allowFailure: true });
    if (r.exitCode === 0) return;
    await sleep(2000);
  }
  throw new Error(`guest condition never became true (${timeoutSeconds}s): ${command}`);
}

function pushBundle(
  ip: string,
  suitePath: string,
  metadata: GoldenMetadata,
  seed: Record<string, { uuid: string }>,
): void {
  const context = {
    ctx: {
      token: metadata.uriSchemeAuthToken,
      pinnedDate: metadata.pinnedDate,
    },
    seed,
  };
  const tmpContext = join(REPO_ROOT, "lab/artifacts", ".context.tmp.json");
  writeFileSync(tmpContext, JSON.stringify(context));
  scp([suitePath, `${SSH_USER}@${ip}:${GUEST_HARNESS}/suite.json`]);
  scp([tmpContext, `${SSH_USER}@${ip}:${GUEST_HARNESS}/context.json`]);
}

function collect(ip: string, artifactsDir: string): void {
  ssh(ip, `python3 ${GUEST_HARNESS}/probe-runner.py --copy-db ~/${GUEST_RUN}/db-final.sqlite`);
  scp(["-r", `${SSH_USER}@${ip}:${GUEST_RUN}`, join(artifactsDir, "guest-run")]);
  scp([`${SSH_USER}@${ip}:things-lab/events.ndjson`, join(artifactsDir, "events.ndjson")]);
}

function evaluate(
  suite: SuiteSpec,
  metadata: GoldenMetadata,
  seed: Record<string, { uuid: string }>,
  artifactsDir: string,
  runId: string,
): VerdictsFile {
  const guestRun = join(artifactsDir, "guest-run");
  const executions = readFileSync(join(guestRun, "execution.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ExecutionRecord);

  // A probe that died before snapshotting leaves no/partial files; it is
  // already red via its recorded guest errors — don't let the file kill
  // evaluation of the other probes.
  const loadSnapshot = (path: string): DbSnapshot => {
    try {
      return JSON.parse(readFileSync(join(guestRun, path), "utf8")) as DbSnapshot;
    } catch {
      return {};
    }
  };
  const artifacts = new Map(
    executions.map((execution) => {
      const before = loadSnapshot(execution.snapshotBefore);
      const after = loadSnapshot(execution.snapshotAfter);
      return [execution.probe, { execution, before, after }] as const;
    }),
  );

  // The monitor owns events.ndjson (its FileHandle offset would clobber a
  // second writer), so the guest writes MARK sentinels to marks.ndjson and
  // the two streams are merged by timestamp here. Stable sort keeps events
  // ahead of same-millisecond marks.
  const monitorEvents = parseEventLog(readFileSync(join(artifactsDir, "events.ndjson"), "utf8"));
  const marks = parseEventLog(readFileSync(join(guestRun, "marks.ndjson"), "utf8"));
  const events = [...monitorEvents, ...marks].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );

  const context: AssertionContext = {
    seed,
    ctx: { token: metadata.uriSchemeAuthToken, pinnedDate: metadata.pinnedDate },
  };
  const env = {
    thingsVersion: metadata.thingsVersion,
    golden: metadata.golden,
    schemaFingerprint: metadata.schemaFingerprint,
    pinnedDate: metadata.pinnedDate,
    runId,
  };

  const { evidence, verdicts } = evaluateRun(suite.probes, artifacts, events, context, env);

  for (const record of evidence) {
    writeFileSync(
      join(artifactsDir, "evidence", `${record.probe_id}.json`),
      JSON.stringify(record, null, 2),
    );
  }
  writeFileSync(join(artifactsDir, "verdicts.json"), JSON.stringify(verdicts, null, 2));

  printSummary(suite.probes, verdicts);
  return verdicts;
}

function printSummary(probes: ProbeSpec[], verdicts: VerdictsFile): void {
  console.log("\nprobe  legacy  verdict       tier  crash  status");
  console.log("-".repeat(64));
  for (const probe of probes) {
    const v = verdicts[probe.id];
    if (v === undefined) continue;
    const row = [
      probe.id.padEnd(6),
      (probe.legacyRef ?? "—").padEnd(7),
      String(v.verdict).padEnd(13),
      String(v.tier).padEnd(5),
      String(v.crash).padEnd(6),
      v.ok ? "ok" : "FAIL",
    ].join(" ");
    console.log(row);
    if (!v.ok) for (const f of v.failures) console.log(`         · ${f}`);
  }
  console.log();
}
