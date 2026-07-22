# Drift runbook — what to do when a Things update changes the schema

Things app updates can change the database schema. things-api detects this by fingerprint (SHA-256 over the canonical structure of exactly the tables/columns in [src/db/schema.ts](../../src/db/schema.ts)) and **hard-blocks all writes** until a matching baseline ships. This is deliberate safety, not breakage — reads keep working with a warning wherever the depended columns survive.

The full block→accept→re-enable cycle is regression-tested end-to-end in [test/cli/drift-workflow.test.ts](../../test/cli/drift-workflow.test.ts).

## Symptoms

- `things doctor` exits 5, `fingerprint: drift` (or `unknown-version` for a new `databaseVersion`), with per-column detail.
- Every write returns `blocked:drift` (exit 5). Audit records log the blocked decisions.

## Revalidation workflow (the real fix)

1. **Capture the new surface.** `things doctor --json` → observed fingerprint + drift detail. Note the new Things version.
2. **Rebuild the lab golden** for the new Things version: download the new trial build (update `vendor/manifest.json` with version + SHA-256), run [`lab/scripts/golden-build.sh`](../../lab/scripts/golden-build.sh) `v<N+1>`, then the human session in [golden-runbook.md](golden-runbook.md) (~1 hour). Check trial-clock inheritance if updating in place (DRIFT-1: if the old clock carries over, rebuild from L0).
3. **Re-run the full regression** against the new golden: `npm run lab:regress`. Any verdict/tier delta = the update moved the write surface; reconcile suite expectations deliberately, updating the results docs and capability notes with evidence.
4. **Ship the baseline.** Regenerate the fixture DDL snapshot from the new schema, add `src/db/baselines/db-v<N>.ts` (databaseVersion, fingerprint, known app versions), release.
5. **Re-model the bench simulation chain in lockstep** (AGENTBENCH scaffolds an entire synthetic Things DB, so schema knowledge is load-bearing there too): update in order `docs/atlas/schema-v<N>.md` → `test/fixtures/schema-v<N>.sql` + seed builders → `src/write/vectors/simulator.ts` appliers → bump `SIMULATED_DATABASE_VERSION` (the simulator fence REFUSES to run against a fixture whose `databaseVersion` differs — the tripwire that makes forgetting this step loud, not silent) → `bench/world.ts` generator + corpus encodings (`bench/tasks/AUTHORING.md`) → **re-certify applier fidelity against the new golden with the SIMFID replay suite** (`npm run lab:simfid` for the host-side sim replay vs banked-evidence goldens; `bash lab/scripts/simfid.sh` for a fresh clone drive of the headless cases against the rebuilt golden; add `-- --gate` to fail on any DIVERGENT). Any new DIVERGENT means the update moved the write surface the appliers model — reconcile deliberately and update `docs/lab/simfid-results.md`. See [simfid-results.md](simfid-results.md) + bench/ROADMAP.md.
6. `things doctor` returns to `ok`; writes re-enable.

## Impatient escape hatch (at your own risk)

```sh
things doctor --json            # copy fingerprint.value
things config set accepted-fingerprint sha256:<observed>
```

Writes re-enable immediately; `doctor` reports `user-accepted` with a standing warning, and **every audit record carries `fingerprint: "user-accepted"`**. Acceptance is exact-hash: a further schema change re-blocks. There is no silent auto-acceptance, ever. Clear it with `things config set accepted-fingerprint ""` after upgrading to a release with a real baseline (any non-matching value is inert, but keep the config honest).

## What reads do under drift

Every read names explicit columns, so removals fail loudly at query time rather than returning silently-wrong shapes. Additions never break anything (extra columns are recorded by doctor, warn-only, excluded from the hash).
