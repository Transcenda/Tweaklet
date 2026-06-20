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
  return allow.some((g) => globToRegExp(g).test(norm));
}

export function partitionChanges(paths: string[], allow: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [], blocked: string[] = [];
  for (const p of paths) (matchesAllow(p, allow) ? allowed : blocked).push(p);
  return { allowed, blocked };
}
