import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { locateThingsDb, ThingsDbNotFoundError } from "../../src/db/locate.ts";

const CONTAINER = "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac";

let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "things-api-home-"));
  savedEnv = process.env["THINGS_DB"];
  delete process.env["THINGS_DB"];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env["THINGS_DB"];
  else process.env["THINGS_DB"] = savedEnv;
});

/**
 * Create a glob-matching candidate under `home` and return its absolute path.
 * `mtimeSec` sets the mtime explicitly so recency ordering is deterministic.
 */
function seedCandidate(tag: string, mtimeSec: number): string {
  const path = join(
    home,
    CONTAINER,
    `ThingsData-${tag}`,
    "Things Database.thingsdatabase",
    "main.sqlite",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

describe("locateThingsDb — precedence", () => {
  it("explicit dbPath option beats env beats glob", () => {
    process.env["THINGS_DB"] = "/env/path/main.sqlite";
    seedCandidate("A", 1_000);
    const result = locateThingsDb({ dbPath: "/explicit/main.sqlite", home });
    expect(result).toEqual({
      path: "/explicit/main.sqlite",
      source: "option",
      otherCandidates: [],
    });
  });

  it("env var beats glob when no dbPath given", () => {
    process.env["THINGS_DB"] = "/env/path/main.sqlite";
    seedCandidate("A", 1_000);
    const result = locateThingsDb({ home });
    expect(result).toEqual({ path: "/env/path/main.sqlite", source: "env", otherCandidates: [] });
  });
});

describe("locateThingsDb — glob discovery", () => {
  it("picks the most-recently-modified candidate and lists the rest as otherCandidates", () => {
    const old1 = seedCandidate("OLD1", 1_000);
    const newest = seedCandidate("NEW", 3_000);
    const old2 = seedCandidate("OLD2", 2_000);

    const result = locateThingsDb({ home });
    expect(result.source).toBe("container");
    expect(result.path).toBe(newest);
    // otherCandidates holds the remaining matches, still ordered newest-first.
    expect(result.otherCandidates).toEqual([old2, old1]);
  });

  it("otherCandidates is empty when exactly one candidate matches", () => {
    const only = seedCandidate("ONLY", 1_000);
    const result = locateThingsDb({ home });
    expect(result).toEqual({ path: only, source: "container", otherCandidates: [] });
  });

  it("throws ThingsDbNotFoundError naming the searched glob when nothing matches", () => {
    let caught: unknown;
    try {
      locateThingsDb({ home });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ThingsDbNotFoundError);
    expect((caught as Error).message).toContain(join(home, CONTAINER));
    expect((caught as Error).message).toContain("Things database not found");
  });
});
