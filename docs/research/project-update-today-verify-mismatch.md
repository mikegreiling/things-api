# `project update --when today` false verification mismatch (2026-08-10)

> **FIXED in PR #440 (2026-08-11, branch `mg/when-today-verify-fix`).** Implemented the proposed fix (option 1, predicate form): the symbolic `when: today` UPDATE verify now asserts the arrived-date predicate `startDate != null && startDate <= today` (a new JSON-serializable `satisfies`/`FieldPredicate` form on `src/write/verify/delta.ts`, selected by a `whenAssertions({ mode: "update" })` flag) for both `todo.update` and `project.update`; adds and explicit ISO dates keep exact equality, and `when: evening` is unchanged (evening is date-anchored to today exactly, so exact equality is correct there). The full 5-case matrix below is covered for both update ops and both add ops. The report content is retained unchanged for the record.

## Summary

A production field observation found a false `verify-failed:mismatch` after a successful project update. An open to-do already in Today was first converted to a project successfully. A subsequent `project update` changed its title, notes, deadline, and symbolic schedule to `today`. Things saved every requested semantic property and kept the project in Today, but preserved the project's already-arrived historical `startDate` instead of normalizing that storage byte to the current date.

The verifier treated symbolic `when: today` as a raw-date rewrite and required `startDate == <today>`. Seven of eight assertions matched; only that exact-date assertion failed. This is an overly strict postcondition for an update of an item already in Today.

This is a privacy-safe field report, not immutable disposable-VM probe evidence. No production task title, notes, UUID, container name, deadline, or historical schedule is committed.

## Local evidence

Exact production evidence is retained only in the gitignored `lab/artifacts/today-canceled-grouping-2026-08-10/` directory:

| Local-only artifact | Contents | SHA-256 |
| --- | --- | --- |
| `project-update-verify-mismatch-tool-calls.ndjson` | Five exact session tool calls: discovery/help, blocked conversion, successful conversion, and failing update | `90271722ab4781a7d8a72aed176705418a0c7a27daa9b6fc12fb1a0b5a2b9c6a` |
| `project-update-verify-mismatch-audit.jsonl` | Five exact Things audit records: blocked conversion, conversion intent/final, update intent/final | `06ff4fbb4020ca33651eaad35c441d954246bbb3e176b039964b4e0a7778622e` |
| `project-update-verify-mismatch-error.json` | Exact CLI JSON error envelope, including private operands | `0f4e96fa3ef19fa23358659a6fcae1031391545547c5657fa605f7b32f08b830` |

## Chronology

Times are UTC.

| Time | Event and evidence |
| --- | --- |
| 22:31:54 | Searched for the open Today to-do and read `todo convert-to-project` / `project tags` help. |
| 22:31:58 | Read `project update` and `project move` help. |
| 22:32:01–22:32:02 | Tried conversion without the explicit GUI-drive acknowledgment; audit correctly recorded `blocked:H-UI-DRIVE`. No mutation occurred. |
| 22:32:23–22:32:27 | Retried with `--dangerously-drive-gui`; the native conversion action returned `ok` and verified on its first attempt. |
| 22:32:34 | Invoked the project update with private title/notes plus `--when today`, a deadline, and `--json`. |
| 22:32:34–22:32:40 | Things saved the update. Verification retried 35 times over 6,259 ms, then returned `verify-failed:mismatch`; the response elapsed time was 6,430 ms. |

Sanitized causal commands:

```text
things todo convert-to-project <todo-uuid> --json --dangerously-drive-gui
things project update <project-uuid> \
  --title <private-title> \
  --notes <private-notes> \
  --when today \
  --deadline <private-deadline> \
  --json
```

No retry of the failed update is needed to establish the result: the failure envelope itself contains the decoded post-write state.

## Error shape

The CLI returned its normal JSON error envelope (contract exit code 3), sanitized below:

```json
{
  "apiVersion": 1,
  "ok": false,
  "kind": "error",
  "error": {
    "code": "verify-failed:mismatch",
    "message": "the database reached a state contradicting the expected delta",
    "detail": {
      "expected": {
        "mode": "update",
        "uuid": "<project-uuid>",
        "assert": [
          { "field": "title", "equals": "<requested-title>" },
          { "field": "notes", "equals": "<requested-notes>" },
          { "field": "start", "equals": "active" },
          { "field": "startDate", "equals": "<today>" },
          { "field": "today", "equals": true },
          { "field": "evening", "equals": null },
          { "field": "reminder", "equals": null },
          { "field": "deadline", "equals": "<requested-deadline>" }
        ]
      },
      "observed": {
        "title": "<requested-title>",
        "notes": "<requested-notes>",
        "start": "active",
        "startDate": "<historical-arrived-date>",
        "today": true,
        "evening": null,
        "reminder": null,
        "deadline": "<requested-deadline>"
      }
    }
  }
}
```

The pre-read and post-read carried the same historical `startDate`. The pre-read also already reported `start: active`, `today: true`, and no current Evening marker. Thus the native update preserved an existing arrived schedule; it did not leave a future, Anytime, Someday, or Evening project behind.

## Root cause

`src/write/commands.ts` uses one `whenAssertions()` helper for adds and updates. Its `today` branch currently emits four equality assertions:

```text
start == active
startDate == todayIso
today == true
evening == null
```

`projectUpdate.expectedDelta()` appends that complete set whenever `params.when` is present. The verifier supports equality assertions only, so the preserved historical date makes the whole update fail even though the three semantic placement assertions pass.

This confuses two distinct meanings:

- `today` is a symbolic membership request: active, visible in Today, outside the current Evening sub-bucket;
- `startDate` is storage history. An overdue/arrived item can retain an earlier original schedule while Things presents it in Today through `todayIndex`.

Exact date equality is correct for an explicit ISO-date request. It is not universally correct for symbolic `today` on an existing Today member.

## Expected verification behavior

For an update with `when: today`, verification should accept a non-Evening active item whose scheduled date has arrived:

```text
start == active
today == true
evening == null
startDate is non-null and <= today
```

That condition preserves an important distinction: an undated item pulled into Today only by a due deadline should not satisfy a request to schedule it for Today merely because it has `today: true`.

Adds can continue to require `startDate == today`, because a newly created Today item has no historical schedule to preserve. Explicit `YYYY-MM-DD` updates must also retain exact equality.

## Proposed fix

Split symbolic-Today update verification from add verification instead of weakening every `when` assertion:

1. Add a predicate-capable assertion (or a dedicated decoded verifier field) for `startDate != null && startDate <= today`.
2. Use it with `start == active`, `today == true`, and `evening == null` for `todo.update` and `project.update` when `when == today`.
3. Keep exact `startDate == today` for add operations, and exact equality for explicit ISO dates.
4. Preserve the current reminder assertion; it matched in this incident and is orthogonal.

A smaller pre-state-aware alternative is to expect the prior arrived `startDate` when the target was already scheduled in Today, and expect `todayIso` only when transitioning from another bucket. The predicate form is preferable because it states the consumer contract directly and tolerates any native arrived-date preservation rule without accepting undated deadline-only pulls.

## Regression coverage

Add engine cases for both to-dos and projects:

1. Historical scheduled date + already Today + `update --when today`: app preserves the date; verification succeeds.
2. Future/Anytime/Someday item + `update --when today`: the result must be active, scheduled, Today, and not Evening.
3. Undated deadline-pulled item + simulated no-op `when=today`: verification fails because `startDate` remains null.
4. `update --when YYYY-MM-DD`: a different observed date still fails exact verification.
5. `add --when today`: the created item still requires today's exact date.

Run the same matrix through `todo.update` because it shares `whenAssertions()` even though this field observation exercised `project.update`.
