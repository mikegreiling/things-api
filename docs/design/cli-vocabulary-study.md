# Clean-room CLI-vocabulary study — multi-model replication (2026-07-27)

Independent, contamination-free replication of Mike's GPT-5.6/ChatGPT thought experiment, run against other frontier models to mine for vocabulary our reorder/move surface lacks. This memo is **input to the heading-demotion + sort-ergonomics design round (up-next §6)** — it proposes no final designs.

## Provenance & method

Phase 1 used the EXACT prompt verbatim (no project context, no tool names, no our-vocabulary), captured from a neutral `/private/tmp` cwd so no repo `CLAUDE.md`/`AGENTS.md` loaded. Raw responses live in `/private/tmp/cli-vocab-cleanroom/{codex_gpt,claude_opus,claude_sonnet,pi_gemini}.out`.

Models actually reached:

| Harness | Model (confirmed) | Notes |
|---|---|---|
| `codex exec` | **gpt-5.6-sol** (OpenAI) | needed `--skip-git-repo-check` in a non-git dir |
| `claude -p --model claude-opus-4-8` | **Claude Opus 4.8** | |
| `claude -p --model claude-sonnet-5` | **Claude Sonnet 5** | |
| `pi -p` | **gpt-5.6-sol** (again) | pi's default resolved to GPT, NOT Gemini — no Google API key on host; kept as a second GPT-5.6 pass through a different scaffold |

**No Gemini / third-family model was reachable** (no key; no `gemini`/`llm`/`ollama` on host). So the distinct model families are **GPT-5.6** (two independent scaffolds) and **Claude** (Opus 4.8 + Sonnet 5). The GPT-5.6 clean-room runs also let us cross-check the ChatGPT-run headlines recorded in §6.

Non-determinism note worth carrying into the round: the two fresh GPT-5.6 runs (codex, pi) **did NOT reproduce the ChatGPT run's "reorder reserved as a strict full-order reconciliation tool, no partial form" headline.** Both fresh GPT runs made `reorder` a *positional block-mover* (`reorder A B --after X`), identical in shape to `move` minus the container change — the same model as the two Claude runs. See the divergence row below; the strict-reorder idea is a minority position that did not replicate.

---

## 1. Convergence table

### Universal (all four runs independently proposed)

| Element | codex/GPT | opus | sonnet | pi/GPT | Our surface today |
|---|---|---|---|---|---|
| **Noun-first grammar** `todo <noun> <verb>` | ✓ | ✓ | ✓ | ✓ | ✓ (`things <type> <verb>`) |
| **move vs reorder split** — `move` = change container/parentage, `reorder` = position within current container | ✓ | ✓ | ✓ | ✓ | ✓ (separate `move`/`reorder` commands) |
| **`reorder` fails closed if operands span containers** (guard against a stale/cross-container anchor silently reparenting) | ✓ | ✓ (implied) | ✓ | ✓ | Partial — our reorder is `--scope`-driven, not target-inferred |
| **Shared position-anchor grammar** on both move and reorder: `--first/--last/--before <ref>/--after <ref>` (naming varies: `--top/--bottom`, `--at-start/--at-end`) | ✓ | ✓ | ✓ | ✓ | **Only `area reorder` speaks this** — everything else is front-insert-at-top |
| **`move` carries a position** (membership + placement in ONE call, via the same anchors) | ✓ | ✓ | ✓ | ✓ | Partial — `todo move` sets container but not intra-container position |
| **Bulk selection at destination = command-line ARGUMENT ORDER** (explicit ids land as listed) — and **all four** note this doubles as the free reversal mechanism | ✓ | ✓ | ✓ | ✓ | N/A (we require full permutations, no partial block) |
| **Bulk create in one call** — repeatable `--title` and/or positional titles, returns minted uuids in order | ✓ | ✓ | ✓ | ✓ | Single create per call |
| **Create echoes minted uuid(s)** for chaining (`--id-only`/`--porcelain`/`--json`) | ✓ | ✓ | ✓ | ✓ | ✓ (`--json`) |

### Strong (3 of 4)

| Element | Who | Note |
|---|---|---|
| **Contiguous-block insertion; the anchor may NOT be a member of the moved selection** (error) | codex, opus, pi | Sonnet implies block, doesn't state anchor-exclusion |
| **Selector/query source preserves SOURCE order** (as opposed to arg order) | codex, opus, pi | The two ordering rules: explicit ids → arg order; `--all`/query → source order. Sonnet proposed no selector form at all |
| **Container INFERRED from the target ids** (no explicit scope flag) — "the container is already implied by the ids" | codex, sonnet, (opus via anchor) | Directly contradicts our required `--scope <today\|project\|area\|…>` + `--project/--area`. See novel-idea #1 |

### Split / divergent

| Question | Positions |
|---|---|
| **Is `reorder` a partial block-mover or a strict full-order replace?** | **Block-mover: all 4 fresh runs** (codex, opus, sonnet, pi). Strict-full-order: only the earlier ChatGPT run recorded in §6. Our shipped "place listed at TOP, rest keep order" front-insert is closest to opus `reorder --top` / codex `reorder --first` — i.e. the clean-room majority validates a *partial* reorder, not the strict one. |
| **Do anchors ever need a TYPE prefix?** | Sonnet: **never** — "uuids are globally unique across all four entity types… the CLI resolves what kind of thing a uuid points to." pi: **yes for heterogeneous lists** — `--after task:"$T"` when a container mixes types. Reconcilable: a uuid self-types; a *name/ref* does not. Load-bearing for the "unheaded to-dos + headings intermixed at project top level" problem. |
| **Selector flags** (`--from-heading … --all`) | opus + pi propose them; codex mentions query selection; sonnet omits entirely. |
| **Atomicity of a multi-item op stated explicitly** | codex only. |

---

## 2. Novel ideas we currently lack (each with a verdict-shaped note)

Our reorder rides app wire protocols with **anchor semantics and per-item legs** (native EXPERIMENTAL, or bounce ≤10 items, someday's two-call anchor-stack, projects bounce round-trip); **reads are unconstrained**. Verdicts map each idea into that reality.

1. **Container inference — drop the required `--scope`.** All fresh runs infer the container from the target ids/anchor; none demand a scope enum. Our `reorder <uuids…> --scope <today|evening|inbox|someday|project|headings|area|projects> [--project/--area <ref>]` is exactly the "know the right scope/container flags" burden §6 calls agent-hostile.
   *Verdict:* **Reads can resolve this for free** — given a target uuid we can already look up its container/membership (that's how pre-state builds the wire list). The scope could become inferred (with an optional explicit override to disambiguate genuinely ambiguous cases like a uuid that is both a loose Today item and a project child). No wire-protocol change; pure resolution-layer ergonomics. Highest-value, lowest-risk item.

2. **Relative single-item / block placement as the shared dialect** — `--before/--after/--first/--last` on BOTH move and reorder, block lands in arg order at the anchor. §6 already names this direction ("extend the `area reorder` dialect rather than invent a second one"); all four models independently landing on it is external validation.
   *Verdict:* Maps cleanly onto anchor-based wire protocols — a single `--after X` is one anchor-relative placement, which is what native/bounce already express per-item. The **minimal-move planner** (§6's "optimize" half) is the natural implementation: diff current vs. desired, emit the fewest anchor legs, stay under the ≤10 cap, shrink undo records.

3. **Selector-based bulk move — no id enumeration** — `move --from-heading H1 --all --to-heading H2` (opus); `move --all --from-project P --from-heading A --to-heading B` (pi). Directly serves example (d), "move the tasks from one heading into another," which today forces the caller to `list` then hand back a uuid permutation.
   *Verdict:* Read the source container's membership server-side (we already do for pre-state), feed as the wire list **preserving source order** (the convergent selector rule). Big ergonomic win; no new app surface. Note the O06 constraint: heading-scoped CHILD reorder is app-unautomatable, but heading-to-heading MOVE is a `todo.move --heading` per item — feasible.

4. **`--porcelain` / `--id-only` uuid-only output mode** — codex `--id-only`, pi `--porcelain`: newline-separated uuids ONLY, no envelope, for `mapfile`/`$(…)` chaining without `jq`.
   *Verdict:* Additive CLI output mode alongside `--json`. Cheap. Slightly in tension with the "one contract" doctrine, but it's a *rendering* of the same ids, not a third contract (same argument the `--markdown` item makes). Worth a ruling.

5. **Typed anchors for heterogeneous containers** — pi's `--after task:"$T"` / `--after heading:"$H"` when a list mixes types.
   *Verdict:* **Directly load-bearing for the heading-demotion round.** Mike's own §6 note says project top-level = unheaded to-dos + headings intermixed, keyed on direct containment. Once heading uuids are hidden and anchors speak title/`--index` refs, a bare name is ambiguous between a to-do and a heading at the same level — a type prefix (or separate `--after-heading`/`--after-todo` flags) is one clean disambiguator. Sonnet's counter ("a uuid self-types, no prefix needed") only holds while uuids are exposed; hiding heading uuids is exactly what breaks it.

6. **Immutable project-scoped KEY for headings** — codex: `heading add --key planning --title "Planning and discovery"`, then reference `--to-heading planning`. A stable human-authored slug, distinct from both uuid and mutable title.
   *Verdict:* The only scheme any model proposed that dodges BOTH failure modes at once (rename-safe like a uuid, reindex-safe like a title, human-typable). But it needs a new stored field Things doesn't give us (headings have only uuid + title in the schema), so it's likely out of reach without synthesizing/persisting our own mapping. Flag as the "ideal that the data model won't support" data point.

7. **Streaming bulk create from stdin/file** — codex `--titles-from tasks.txt`, pi `--jsonl -`, opus stdin lines.
   *Verdict:* Additive input path; dovetails with the §6 "multi-line notes as first-class CLI input" (`--notes -`) item — same stdin ergonomic. Each line still becomes one `todo.add` leg, so no protocol change, just an input adapter.

8. **`move` rejects a SAME-container target (mirror guard)** — codex: "a same-container move should be rejected with guidance to use reorder… catches mistaken destination IDs." The inverse of the convergent reorder-cross-container guard.
   *Verdict:* We already have `src/cli/move-hint.ts` redirecting mis-typed intent (e.g. scheduling-on-move → `update --when`); a same-container-move → reorder hint is the same machinery. Cheap, and it hardens the move/reorder split symmetrically.

9. **`--reverse` / `sort --by <key>` as read-computed sugar** — opus `heading reorder "$H1" --reverse`; §6 already lists `sort --by deadline|when|title|creation`.
   *Verdict:* Compute the target permutation on the read side, feed it through the same reorder wire protocol (+ minimal-move planner). No app surface needed. `--reverse` is the trivial special case of a read-computed permutation.

---

## 3. Heading-addressing answers (the deliberate no-uuid clause)

Every model was asked how the CLI should refer to headings **if** headings were not first-class uuid-addressed resources. Findings:

**Convergent scheme when uuids are hidden: `(project ref, exact heading title)`.** All four proposed this identically:
- codex: `--to-project "$P" --to-heading "Planning"`
- opus: `--project <id> --heading "<name>"` (or packed `"<project-id>:<name>"`)
- sonnet: `(project_uuid, title)` pairs; reject a bare `--heading` as a `--to` target (always require the paired `--project`)
- pi: `(project UUID, exact heading title)`; "internal heading UUID… not part of the public CLI contract"

**Convergent precondition:** heading titles must be **unique within a project**. codex, opus, sonnet, pi all state it; sonnet/codex would have the *store* reject duplicate titles rather than have the CLI disambiguate.

**Strong convergent WARNING — all four reject ORDINAL/INDEX addressing:**
- codex: *"I would not use ordinal references such as `heading:2`; reordering a heading would change what the reference means."*
- opus: names the **"reindex hazard"** — `--heading-index N` "silently re-targets when headings are reordered or inserted, so it's unsafe to reuse across mutations."
- sonnet: index form "strictly worse ergonomics than a UUID for zero benefit."
- pi: *"Reordering does not invalidate the reference, unlike an ordinal such as 'heading 2.'"*

**This is the sharpest finding for the design round, and it cuts AGAINST our planned checklist-model demotion.** Our checklist precedent (and the §6 heading-demotion sketch) addresses items by **title OR 1-based `--index`**, with `--index` as the escape hatch for duplicate titles. But headings, unlike checklist items in practice, are a **first-class reorder target** — and every model independently flagged that index/ordinal addressing is precisely the unsafe scheme *because reordering silently re-targets it*. The checklist model borrows an escape hatch (`--index`) whose failure mode is amplified for headings by the very reorder ops we want to ship. **Genuine tension to put in front of Mike:** either (a) accept the reindex hazard as a documented footgun (as checklists do), (b) require unique titles and drop the index escape hatch for headings specifically, or (c) find a stable key (codex's `--key`, novel-idea #6 — but the data model won't persist it).

**Divergence on whether to hide uuids at all:** both **Claude** models argued to KEEP headings uuid-addressed (rename-safe, collision-safe, uniform with "a uuid names a thing, full stop" — sonnet: "I'd push back on that constraint upstream rather than design around it"). Both **GPT-5.6** runs were more willing to hide the uuid behind a project-scoped name/key. Mike's demotion instinct aligns with the GPT camp; the Claude camp's robustness-under-scripting argument is the strongest recorded counter and should be answered explicitly (esp. §6's own open question: "whether read-side JSON keeps emitting heading uuids — agents may hold them today").

**Match against our planned checklist-model demotion:** partial. The `(project, title)` reference scheme and the "uuid hidden as an implementation detail" framing match well. The `--index` escape hatch does NOT match the clean-room consensus and is the one piece every model warned about.

---

## 4. Striking direct quotes (short)

- **Reorder-as-reversal (convergent), sonnet:** *"`reorder t3 t2 t1` **is** how you express 'reverse these three.' If bulk operations preserved original order instead, you'd need a separate mechanism entirely for expressing a new sequence, which is redundant."*
- **Arg-order is the only stateless contract, opus:** *"it's the only rule under which a command's output is a function of the command alone, not of current state."*
- **The two ordering rules, codex:** *"Explicit IDs retain command-line argument order. Query-based selections retain their displayed order unless an explicit sort is supplied."*
- **The CLI never invents an order, opus:** *"the CLI never invents an order. It never sorts by uuid, creation time, or title behind your back."*
- **Container inference, sonnet:** *"Because UUIDs are globally unique across all four entity types, `--to <uuid>` and `--after/--before <uuid>` never need a type prefix — the CLI resolves what kind of thing a UUID points to and infers the right containment rules from it."*
- **Why the verb split, sonnet:** *"`move` is the explicit, container-changing operation; `reorder` is the assertion that no reparenting will happen."*
- **Reindex hazard, opus:** *"the `--heading-index N` form silently re-targets when headings are reordered or inserted, so it's unsafe to reuse across mutations."*
- **Ordinal rejection, codex:** *"I would not use ordinal references such as `heading:2`; reordering a heading would change what the reference means."*
- **Same-container move guard, codex:** *"A same-container `move` should be rejected with guidance to use `reorder`; that keeps scripts clear and catches mistaken destination IDs."*
- **Keep headings first-class, sonnet:** *"given headings need their own `reorder`, I'd push back on that constraint upstream rather than design around it."*

---

## 5. One-paragraph read for the round

The clean-room strongly ratifies §6's own instincts: the move/reorder split, the shared `--before/--after/--first/--last` dialect (extend `area reorder`, don't invent a second grammar), arg-order-as-destination-order (reversal for free), and bulk create returning ids. The **two things we lack that every model assumes** are (i) *container inference* — none of them made the caller name a scope; and (ii) *relative block placement + selector-based bulk move* so example (d)/(e) don't require hand-built full permutations. The **heading-addressing consensus** is `(project, title)` with unique-title enforcement, and — the load-bearing surprise — a **unanimous warning against index/ordinal addressing** exactly because headings are reorderable, which puts the checklist model's `--index` escape hatch on the design table as a known footgun rather than a settled precedent.
