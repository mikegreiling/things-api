// Tart VM lifecycle for probe runs: clone-per-run against the frozen golden.

import { run, sleep, spawnDetached, ssh } from "./sh.ts";

export const RUN_VM_PREFIX = "things-run-";

export function tartList(): string[] {
  const r = run(["tart", "list", "--quiet"]);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** One row of `tart list --format json`, reduced to what the gc discriminates on. */
export interface TartVmRow {
  name: string;
  running: boolean;
  /** Last-accessed timestamp as tart reports it (ISO-8601, UTC). */
  accessedAt: string;
}

export function tartListDetailed(): TartVmRow[] {
  const r = run(["tart", "list", "--format", "json"]);
  const rows = JSON.parse(r.stdout) as {
    Name?: string;
    Running?: boolean;
    Accessed?: string;
  }[];
  return rows
    .filter((row): row is { Name: string } & typeof row => typeof row.Name === "string")
    .map((row) => ({
      name: row.Name,
      running: row.Running === true,
      accessedAt: row.Accessed ?? "",
    }));
}

/**
 * Split the run VMs into the ones this run may reap and the ones it must leave
 * alone. The host has a 2-VM ceiling and campaigns run concurrently, so the gc
 * is as polite as `lab/scripts/simfid.sh` is: it never touches a slot a sibling
 * legitimately holds. A run VM is reapable only when BOTH hold:
 *
 *   - it is not running (a live VM is somebody's, always), and
 *   - tart last accessed it BEFORE this run started (anything touched since is
 *     a sibling that is mid-clone or between phases, not a crashed stray).
 *
 * Unparseable timestamps spare the VM: the gc fails closed, because deleting a
 * sibling's VM costs a whole campaign while leaving a stray costs one retry.
 */
export function selectReapableVms(
  vms: TartVmRow[],
  since: string,
): { reap: string[]; spared: string[] } {
  const cutoff = Date.parse(since);
  const reap: string[] = [];
  const spared: string[] = [];
  for (const vm of vms) {
    if (!vm.name.startsWith(RUN_VM_PREFIX)) continue;
    const accessed = Date.parse(vm.accessedAt);
    const stale = !Number.isNaN(cutoff) && !Number.isNaN(accessed) && accessed < cutoff;
    if (!vm.running && stale) reap.push(vm.name);
    else spared.push(vm.name);
  }
  return { reap, spared };
}

export function tartClone(source: string, target: string): void {
  run(["tart", "clone", source, target]);
}

/**
 * Boot headless on default NAT networking. `--net-host` is NOT used: on this
 * Tart build it is implemented via Softnet, which requires passwordless root
 * on the HOST ("root privileges are required … Softnet process terminated
 * prematurely"). The airgap is instead applied guest-side at bootstrap by
 * deleting the guest's default route (host↔guest SSH rides the directly
 * connected vmnet subnet and survives; everything else becomes unroutable).
 */
export function tartRunDetached(vm: string, logPath: string): void {
  spawnDetached(["tart", "run", vm, "--no-graphics"], logPath);
}

export function tartIp(vm: string): string | null {
  const r = run(["tart", "ip", vm], { allowFailure: true });
  const ip = r.stdout.trim();
  return r.exitCode === 0 && ip !== "" ? ip : null;
}

export function tartStop(vm: string): void {
  run(["tart", "stop", "--timeout", "30", vm], { allowFailure: true });
}

export function tartDelete(vm: string): void {
  run(["tart", "delete", vm], { allowFailure: true });
}

/** Poll until the guest answers SSH; returns its IP. */
export async function waitForSsh(vm: string, timeoutSeconds = 300): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const ip = tartIp(vm);
    if (ip !== null) {
      const probe = ssh(ip, "true", { allowFailure: true });
      if (probe.exitCode === 0) return ip;
    }
    // polling loop: each retry must wait for the prior SSH probe before re-checking
    await sleep(3000);
  }
  throw new Error(`timed out waiting for SSH on ${vm} (${timeoutSeconds}s)`);
}

/**
 * Delete stray run VMs (crashed prior runs wedge the 2-VM ceiling), sparing any
 * a concurrent campaign holds. `since` is the current run's start timestamp
 * (ISO-8601) — see selectReapableVms for the discrimination.
 */
export function gcRunVms(since: string): { removed: string[]; spared: string[] } {
  const { reap, spared } = selectReapableVms(tartListDetailed(), since);
  for (const vm of reap) {
    tartStop(vm);
    tartDelete(vm);
  }
  return { removed: reap, spared };
}
