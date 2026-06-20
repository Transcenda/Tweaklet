// A git ref must not start with "-" (would be parsed as a CLI flag) and must
// contain only safe ref characters. Closes argv flag-smuggling on refs.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export function assertSafeRef(ref: string, label = "ref"): void {
  if (typeof ref !== "string" || ref.length === 0) throw new Error(`invalid ${label}: empty`);
  if (ref.startsWith("-")) throw new Error(`invalid ${label}: must not start with '-'`);
  if (!SAFE_REF.test(ref)) throw new Error(`invalid ${label}: illegal characters`);
}
