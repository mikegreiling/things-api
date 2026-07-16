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

/** Delete stray run VMs (crashed prior runs wedge the 2-VM ceiling). */
export function gcRunVms(): string[] {
  const strays = tartList().filter((name) => name.startsWith(RUN_VM_PREFIX));
  for (const vm of strays) {
    tartStop(vm);
    tartDelete(vm);
  }
  return strays;
}
