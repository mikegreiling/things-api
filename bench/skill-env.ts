/**
 * A read-only {@link ExecutionEnv} over an in-memory file map, so the pi-agent-core
 * skills loader (`loadSkills`) reads the skill tree from the SAME bytes that seed the
 * just-bash VFS the subject model operates in.
 *
 * This is the seam that makes the `skill` arm 1-to-1 with real pi. In real pi, skills
 * live on a real filesystem: `loadSkills(env, dir)` records each skill's absolute
 * `filePath`, `formatSkillsForSystemPrompt` advertises it as `<location>`, and the
 * agent's tools read that exact path on demand. Our sandbox filesystem is the just-bash
 * VFS, so the skill "lives" at its VFS mount path (e.g. `/skills/things-cli/SKILL.md`).
 * Loading through this env — over the identical file map used to seed the VFS — makes the
 * library-emitted `<location>` resolve verbatim under `cat` in the sandbox, with NO path
 * remapping or fabrication: one source of truth feeds both the advertisement and the
 * agent's reads. Progressive disclosure is then native — only the name+description+location
 * are advertised; the body and references are read on demand from the mount.
 *
 * `loadSkills` uses only `fileInfo`, `listDir`, `readTextFile`, and (defensively)
 * `canonicalPath`; the remaining `ExecutionEnv` surface is implemented for type honesty
 * but never exercised here — writes and shell execution return stable failure Results
 * (the interface forbids throwing), and the loader never calls them.
 */
import type { ExecutionEnv, FileInfo, Result } from "@earendil-works/pi-agent-core";
import { ExecutionError, FileError } from "@earendil-works/pi-agent-core";

/** Normalize a path by stripping trailing slashes (keeping root "/"). */
function norm(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function basename(path: string): string {
  const p = norm(path);
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const notFound = <T>(path: string): Result<T, FileError> => ({
  ok: false,
  error: new FileError("not_found", `no such path: ${path}`, path),
});
const notSupported = <T>(op: string): Result<T, FileError> => ({
  ok: false,
  error: new FileError("not_supported", `${op} not supported by the skill-load env`),
});

/**
 * Build a read-only ExecutionEnv over `files` (absolute VFS path → contents). Directory
 * entries are derived from the file paths; every file's ancestor directories exist.
 */
export function createVfsSkillEnv(files: Record<string, string>): ExecutionEnv {
  const fileSet = new Set(Object.keys(files).map(norm));
  const dirSet = new Set<string>(["/"]);
  for (const p of fileSet) {
    const segs = p.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < segs.length - 1; i++) {
      cur += `/${segs[i]}`;
      dirSet.add(cur);
    }
  }

  const infoFor = (path: string): FileInfo | undefined => {
    const p = norm(path);
    if (fileSet.has(p)) {
      return {
        name: basename(p),
        path: p,
        kind: "file",
        size: (files[p] ?? "").length,
        mtimeMs: 0,
      };
    }
    if (dirSet.has(p)) {
      return { name: basename(p), path: p, kind: "directory", size: 0, mtimeMs: 0 };
    }
    return undefined;
  };

  const env: ExecutionEnv = {
    cwd: "/",
    async absolutePath(path) {
      return ok(norm(path.startsWith("/") ? path : `/${path}`));
    },
    async joinPath(parts) {
      return ok(norm(`/${parts.join("/")}`.replace(/\/+/g, "/")));
    },
    async readTextFile(path) {
      const p = norm(path);
      const content = files[p];
      return content === undefined ? notFound(p) : ok(content);
    },
    async readTextLines(path, options) {
      const p = norm(path);
      const content = files[p];
      if (content === undefined) return notFound(p);
      const lines = content.split(/\r?\n/);
      return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
    },
    async readBinaryFile() {
      return notSupported("readBinaryFile");
    },
    async writeFile() {
      return notSupported("writeFile");
    },
    async appendFile() {
      return notSupported("appendFile");
    },
    async fileInfo(path) {
      const info = infoFor(path);
      return info === undefined ? notFound(norm(path)) : ok(info);
    },
    async listDir(path) {
      const p = norm(path);
      if (!dirSet.has(p)) return notFound(p);
      const prefix = p === "/" ? "/" : `${p}/`;
      const children = new Map<string, FileInfo>();
      const add = (candidate: string): void => {
        if (!candidate.startsWith(prefix)) return;
        const seg = candidate.slice(prefix.length).split("/")[0];
        if (seg === undefined || seg === "") return;
        const full = p === "/" ? `/${seg}` : `${p}/${seg}`;
        const info = infoFor(full);
        if (info !== undefined) children.set(seg, info);
      };
      for (const f of fileSet) add(f);
      for (const d of dirSet) if (d !== p) add(d);
      return ok([...children.values()]);
    },
    async canonicalPath(path) {
      const p = norm(path);
      return fileSet.has(p) || dirSet.has(p) ? ok(p) : notFound(p);
    },
    async exists(path) {
      const p = norm(path);
      return ok(fileSet.has(p) || dirSet.has(p));
    },
    async createDir() {
      return notSupported("createDir");
    },
    async remove() {
      return notSupported("remove");
    },
    async createTempDir() {
      return notSupported("createTempDir");
    },
    async createTempFile() {
      return notSupported("createTempFile");
    },
    async exec() {
      return {
        ok: false,
        error: new ExecutionError("shell_unavailable", "exec not supported by the skill-load env"),
      };
    },
    async cleanup() {
      /* nothing to release */
    },
  };
  return env;
}
