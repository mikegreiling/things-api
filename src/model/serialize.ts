/**
 * The emit-time omit-empty transform for entity/data payloads (the "Omit-empty"
 * contract in docs/design/contracts.md). Applied at the JSON emit boundary of
 * the read surfaces ONLY — the CLI `--json` read envelope (src/cli/read-driver.ts)
 * and the MCP read tool results (src/mcp/server.ts) — never to the in-memory
 * entities the library returns, and never to the error envelope.
 *
 * The rule: an ENTITY object omits any optional field whose value is empty —
 * null, undefined, "" (empty string), or [] (empty array). A consumer MUST
 * read an absent key as unset/empty/default and MUST NOT distinguish absent
 * from empty. Values that are semantically meaningful when "empty" are kept:
 * booleans (a real `false`) and numbers (a `0` count) are never omitted, and
 * the identity keys ({@link IDENTITY_KEYS}) are always present.
 *
 * Why entity-scoped, not a blanket deep prune: the same key means opposite
 * things on different shapes. A to-do's `area: null` is "no area" (omit), but a
 * sidebar section's `area: null` is the load-bearing "top-level/loose block"
 * discriminant (keep). So pruning is gated to the recognized entity shapes;
 * the view scaffolding that CARRIES entities (today/evening split, project/area
 * card sections, grouped blocks) is structural and passes through untouched —
 * only its nested entities are pruned.
 */

/**
 * Keys never omitted from an entity even when empty: the identity a consumer
 * always keys on. `uuid`/`type` are never empty in practice; `title`/`name`
 * can be "" (an untitled to-do) and MUST still be present.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["uuid", "type", "title", "name"]);

type Obj = Record<string, unknown>;

/** A to-do/project/heading row: uuid + a task-type discriminant. */
function isTaskEntity(o: Obj): boolean {
  return (
    typeof o["uuid"] === "string" &&
    (o["type"] === "to-do" || o["type"] === "project" || o["type"] === "heading")
  );
}

/** An area: uuid + the `visible` flag (distinguishes it from a bare Ref). */
function isAreaEntity(o: Obj): boolean {
  return typeof o["uuid"] === "string" && typeof o["visible"] === "boolean";
}

/** A taxonomy tag row (uuid-free): a title plus the parent/shortcut columns. */
function isTagEntity(o: Obj): boolean {
  return (
    o["uuid"] === undefined && typeof o["title"] === "string" && "parent" in o && "shortcut" in o
  );
}

/** Whether this object's empty optional fields should be omitted. */
function prunesEmpties(o: Obj): boolean {
  return isTaskEntity(o) || isAreaEntity(o) || isTagEntity(o);
}

/** null | undefined | "" | [] — the values an entity omits the key for. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function prune(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // Dates serialize to ISO strings via JSON.stringify — never recurse into them.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(prune);
  if (typeof value === "object") {
    const o = value as Obj;
    const omitEmpties = prunesEmpties(o);
    const out: Obj = {};
    for (const key of Object.keys(o)) {
      const v = o[key];
      if (omitEmpties && !IDENTITY_KEYS.has(key) && isEmpty(v)) continue;
      out[key] = prune(v);
    }
    return out;
  }
  return value;
}

/**
 * Return a deep copy of `payload` with every entity's empty optional fields
 * omitted (the "Omit-empty" contract). Pure — the input is never mutated, so
 * the human-render path keeps the full entity beside the JSON emit.
 */
export function omitEmpty<T>(payload: T): T {
  return prune(payload) as T;
}
