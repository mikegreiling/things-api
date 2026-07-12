# Shortcuts write vector — execution plan (roadmap §A.2)

Written 2026-07-11 for an executing agent (fresh context assumed). Orchestrator: the main session. Goal: wire Apple Shortcuts as a first-class write vector so the operations that exist on NO other surface become real pipeline ops.

## Read these first (authoritative context)

1. `CLAUDE.md` — safety rails. NON-NEGOTIABLE additions for this task: the agent must NEVER `shortcuts run` a MUTATING proxy on this host (prod Things). Only `things-proxy-find-items` reads are prod-safe. All executor code paths are validated through seams/mocks; live validation happens later (Mike, or a VM sitting — the lab runner has no Shortcuts support yet, probe-backlog §C).
2. `docs/roadmap.md` §A — what is Shortcuts-only and why.
3. `docs/lab/s-campaign-results.md` — the six proxies' CONTRACTS (input dict shapes, outputs, consent classes) + the SX5/SX6 repair campaign.
4. `docs/capability-matrix.md` — the op×vector matrix; the cells this task turns from "possible (Shortcuts)" to WIRED. Update it in the SAME change.
5. `src/write/` — pipeline architecture: `vectors/types.ts` (VectorId, CompiledInvocation), `vectors/registry.ts`, `operations.ts` (op catalog), `pipeline.ts` (execution + verification + failure classification), `availability.ts` (readShortcutProxies / EXPECTED_PROXIES), `failure-hints.ts`.

## Scope

Wire TWO headless capabilities (the third Shortcuts-only op — single-item permanent delete — has a consent class with no Always-Allow; it stays user-present and is OUT of scope):

1. **`heading.create`** (NEW op, the marquee gap): create a heading inside an EXISTING project via `things-proxy-create-heading`. Params: project ref + title (confirm the proxy's exact input dict in s-campaign-results). Verify via SQLite: a type=2 row with that title appears under the project. No transactional undo in v1 (AppleScript heading delete is dead, −1728; document that undo requires `heading.delete` via the delete proxy, which is interactive—consent class—so v1 records `undo: unsupported`).
2. **`todo.clear-dated-reminder`** (NEW op): clear a time-of-day reminder from a DATE-SCHEDULED item (P3b — URL scheme cannot, oddity 2e; AppleScript has no reminder property). Confirm which proxy carries this (set-detail per the S-campaign contracts) and its input shape. Verify via SQLite: `reminderTime` NULL, startDate unchanged.

## Implementation steps

1. **Vector plumbing**: extend `VectorId` with `"shortcuts"`; `CompiledInvocation` gains kind `"shortcuts-run"` with payload = `{ shortcut: string; input: unknown }` (JSON-serializable). Follow the existing registry pattern (`vectors/registry.ts`).
2. **Executor**: `shortcuts run <name> --input-path <tmp.json> --output-path <tmp.out>` — per-run temp files under os.tmpdir, generous timeout (~25s; first-run consent can stall), always cleanup. Inject through the existing `WriteDeps` seam pattern (like the osascript/open-url runners) so engine tests mock it. A TIMEOUT with the proxy INSTALLED classifies as "consent-needed" (failure hint: run the shortcut once interactively and click Always Allow); a missing proxy pre-checks as BLOCKED with remediation `things setup shortcuts` (reuse `readShortcutProxies`).
3. **Op catalog**: add both ops to `operations.ts` with the shortcuts vector as their ONLY vector; params typed + validated like neighboring ops; dry-run compiles the invocation without executing (existing `--dry-run` contract).
4. **Verification**: post-state checks via the existing SQLite verify machinery (state read → compare). heading.create returns the new heading's uuid (query by project + title + max index; handle duplicate-title candidates conservatively — newest creationDate).
5. **CLI + MCP**: `things heading add <project-ref> <title>` and `things todo clear-reminder <ref>` (match existing naming conventions in `writes.ts` — check them; MCP tools via the same registration path). All help text follows `docs/design/surface-copy.md` (behavior only; banned-vocab tests enforce).
6. **capabilities**: `things capabilities --json` reports the shortcuts vector with availability (installed proxies count) so agents can discover the gate.
7. **Tests**: unit param/compile goldens; engine tests through the mocked executor (success, missing-proxy blocked, timeout→consent-needed, verify-fail exit 3); help-contract pins; surface-copy scan. NO live/VM Shortcuts runs (see rails above). `npm run check` judged by exit code; `npm run fmt` before committing.
8. **Docs, SAME change**: capability-matrix cells → wired; CHANGELOG `## Unreleased`; `docs/gaps.md` §0 note (heading.create now shipped, capability-gated); README Shortcuts-setup section cross-reference; `docs/reference/suite-audit.md` (new ops listed; recurring e2e coverage PARKED until the lab runner grows Shortcuts support — probe-backlog §C); roadmap §A.2 marked done.
9. **Branch/PR**: work on `mg/shortcuts-write-vector`, push, open a PR, do NOT merge (Mike reviews). CI must be green.

## Verification limits (be explicit in the PR)

The executor is seam-tested only. The end-to-end live proof (real `shortcuts run` mutating a real library) is deferred to either (a) Mike smoke-testing on his machine post-review — his call, or (b) a VM sitting once the lab runner gains Shortcuts-vector support. State this plainly in the PR body; do not claim live validation.

## Open questions the agent may resolve autonomously

- Exact input dict key names per proxy: take them from s-campaign-results / the extracted blobs (`lab/artifacts/things-run-sx3-20260709-165344/sx3-out/*.ZDATA.blob` in the MAIN checkout — gitignored, read-only) rather than guessing.
- Whether `heading.create` should accept a position/index (only if the proxy supports it; do not invent).
- Result-shape details (returned uuid vs title echo) — the create-heading proxy's output contract is in the campaign doc.
