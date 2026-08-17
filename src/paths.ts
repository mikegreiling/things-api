/**
 * XDG-style directory resolution for state (audit log, lockfile, local
 * acceptances) and config. Overridable via THINGS_API_* env for tests and
 * non-standard setups.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env["THINGS_API_STATE_DIR"]) return env["THINGS_API_STATE_DIR"];
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".local", "state"), "things-api");
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env["THINGS_API_CONFIG_DIR"]) return env["THINGS_API_CONFIG_DIR"];
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "things-api");
}

export function auditDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "audit");
}

export function mutationLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "mutation.lock");
}

/** Environment tuple recorded at the last verified mutation (consent-churn tripwire). */
export function environmentStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "environment.json");
}

/**
 * Dev-mode step-timeline trace directory (TRACE1, #487). One JSONL file per
 * write invocation lands here when tracing is on (a `-dev` build, or forced via
 * the `traceEnabled` config / `THINGS_API_TRACE` env). LOCAL-ONLY: a trace may
 * contain real task titles/uuids from the running database, so these files must
 * NEVER be committed to the public repo or attached to a public issue.
 */
export function traceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "trace");
}
