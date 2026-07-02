/**
 * things-api — typed library for programmatic interaction with Things 3.
 *
 * Phase 0 scaffold: the public surface lands in Phase 1 (read layer) and
 * Phase 5 (write layer). See docs/design/architecture.md.
 */

export { API_VERSION } from "./cli/output.ts";
export type { Envelope, EnvelopeMeta, ErrorEnvelope, OkEnvelope } from "./cli/output.ts";
export { ExitCode } from "./cli/exit-codes.ts";
