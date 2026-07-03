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
