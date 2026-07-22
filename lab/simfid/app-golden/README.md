# SIMFID app-golden overrides

Drop a `<caseId>.json` here (a serialized `NormalizedDelta`, matching a case id in
[`../cases.ts`](../cases.ts)) to OVERRIDE the banked-evidence derivation for that
case with a hand-authored app-side golden. This is the place to transcribe a
recurrence/subtree app delta uuid-by-uuid from the RSIM raw shapes
([`docs/lab/rsim-results.md`](../../../docs/lab/rsim-results.md)) — a stronger,
non-derived reference than the default sim+documented-extras layering in
[`../evidence.ts`](../evidence.ts).

Precedence (highest first): a fresh clone drive's `--app-deltas/<id>.json`
(`lab/scripts/simfid.sh`) → a file here → the evidence derivation.

The file must be an already-NORMALIZED delta (placeholders, date buckets, ranks),
i.e. the shape [`../ingest-clone.ts`](../ingest-clone.ts) and
[`../replay.ts`](../replay.ts) produce — not raw uuids.
