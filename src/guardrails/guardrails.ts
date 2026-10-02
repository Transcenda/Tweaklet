import fs from "node:fs";
import path from "node:path";

/** Minimal glob: ** = any depth, * = within a single path segment. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (glob[i] === "*") re += "[^/]*";
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/**
 * True if `p` is inside one of the allow globs.
 *
 * SECURITY: the path is normalized (resolving `.`/`..`) BEFORE matching. Without
 * this, a traversal like `frontend/src/../../backend/x` slips past a
 * `frontend/src/**` glob — the glob's `.*` happily eats the `..`. Normalizing
 * first means the glob matches the *real* target location, so an escape resolves
 * to `backend/x` and fails the match. Absolute paths, Windows drive paths, and
 * any path that escapes the repo root (normalizes to start with `..`) are
 * rejected outright. This is the hard security boundary the Build-mode decider
 * relies on to keep the agent inside the allowed UI paths — see agent/decide.ts.
 */
export function matchesAllow(p: string, allow: string[]): boolean {
  if (!p) return false;
  const fwd = p.replace(/\\/g, "/");
  if (path.posix.isAbsolute(fwd) || /^[a-zA-Z]:/.test(fwd)) return false;
  const norm = path.posix.normalize(fwd);
  if (norm === ".." || norm.startsWith("../")) return false;
  // Git's own metadata (hooks, config) is code execution waiting to happen:
  // never editable, whatever the allow globs say. Case-insensitive because the
  // default macOS/Windows filesystems treat `.GIT` as `.git`.
  if (norm.split("/").some((seg) => seg.toLowerCase() === ".git")) return false;
  return allow.some((g) => globToRegExp(g).test(norm));
}

/** The filesystem calls canonicalRepoPath needs; injectable for tests. */
export interface CanonicalFs {
  realpath: (p: string) => string;
  lstat: (p: string) => unknown;
}
const nodeFs: CanonicalFs = { realpath: (p) => fs.realpathSync.native(p), lstat: (p) => fs.lstatSync(p) };
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Where a repo-relative path REALLY points, as a repo-relative POSIX path, or
 * null if it can't be proven to stay inside the repo.
 *
 * SECURITY: matchesAllow is lexical, so a symlink committed under an allowed
 * dir (`frontend/src/x -> ../../backend`, or `-> ../../.git`) would pass it while
 * the write lands elsewhere. This resolves the longest existing prefix with
 * realpath, appends the not-yet-existing tail, and requires the result to stay
 * inside the repo root's realpath; callers then re-run matchesAllow on it.
 * Fails closed on anything it can't resolve: a dangling symlink (writing
 * through it would create its target), ELOOP/EACCES/ENOTDIR, or a missing root.
 */
export function canonicalRepoPath(repoRoot: string, p: string, io: CanonicalFs = nodeFs): string | null {
  if (!p) return null;
  const fwd = p.replace(/\\/g, "/");
  if (path.posix.isAbsolute(fwd) || /^[a-zA-Z]:/.test(fwd)) return null;
  const norm = path.posix.normalize(fwd);
  if (norm === ".." || norm.startsWith("../")) return null;

  let root: string;
  try { root = io.realpath(repoRoot); } catch { return null; }

  const tail: string[] = [];
  let cur = path.join(root, ...norm.split("/"));
  let real: string | null = null;
  while (real === null) {
    try {
      real = io.realpath(cur);
    } catch (e) {
      if (!isEnoent(e)) return null;
      // ENOENT is also what a dangling symlink gives; lstat tells them apart.
      try { io.lstat(cur); return null; } catch (e2) { if (!isEnoent(e2)) return null; }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const rel = path.relative(root, path.join(real, ...tail));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export function partitionChanges(paths: string[], allow: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [], blocked: string[] = [];
  for (const p of paths) (matchesAllow(p, allow) ? allowed : blocked).push(p);
  return { allowed, blocked };
}
