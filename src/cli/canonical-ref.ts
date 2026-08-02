/**
 * The CANONICAL ref an echoed (`≡`) or suggested command renders for a resolved
 * CONTAINER (area/project): its exact stored TITLE, bare, when that title
 * round-trips through its own resolver — the SAME `promoter.roundTrips`
 * predicate the JSON `*Uuid` promotion (src/read/shape.ts) and the inline
 * container mentions (src/cli/render.ts) consult, so the three never disagree —
 * else the fused decorated form `Title [8charPrefix]`, which re-resolves through
 * the uuid-prefix tier of `area show` / `project show`. Shell-quoted (the shared
 * ./shell-quote.ts rule) so a title with spaces or quotes stays copy-pasteable.
 * Every command it builds re-resolves to the same entity by construction.
 *
 * To-dos are deliberately NOT handled here: a to-do is never resolvable by title
 * (and its fused form has no read path — `todo show` / the loose router resolve
 * only uuid/partial-uuid/share-link), so the loose router keeps echoing the
 * uuid/partial-uuid it was given, already the shortest re-resolvable ref.
 */
import { fusedRef, type RefPromoter } from "../index.ts";
import { shellQuote } from "./shell-quote.ts";

export function canonicalRef(
  promoter: RefPromoter,
  kind: "area" | "project",
  entity: { title: string; uuid: string },
): string {
  const bare = promoter.roundTrips(kind, entity.title, entity.uuid);
  return shellQuote(bare ? entity.title : fusedRef(entity.title, entity.uuid));
}
