// A git ref must not start with "-" (would be parsed as a CLI flag) and must
// contain only safe ref characters. Closes argv flag-smuggling on refs.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export function assertSafeRef(ref: string, label = "ref"): void {
  if (typeof ref !== "string" || ref.length === 0) throw new Error(`invalid ${label}: empty`);
  if (ref.startsWith("-")) throw new Error(`invalid ${label}: must not start with '-'`);
  if (!SAFE_REF.test(ref)) throw new Error(`invalid ${label}: illegal characters`);
}

// A commit id from a request: lowercase hex only, so it can never be a ref name,
// a revision expression (`HEAD~1`, `x^`), a pathspec or a flag.
const SHA = /^[0-9a-f]{7,40}$/;

export function assertSha(sha: string, label = "sha"): void {
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error(`invalid ${label}: expected a 7-40 character hex commit id`);
}

// `scheme://userinfo@` — the scheme is length-bounded and the userinfo can't
// contain "/", "@" or whitespace, so a match is linear in the input (no ReDoS).
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi;

/** Mask credentials embedded in URLs (`https://user:pass@`, `https://token@`)
 *  before echoing git output or remote URLs back to a user. */
export function redactUrlCredentials(text: string): string {
  return String(text).replace(URL_USERINFO, "$1***@");
}
