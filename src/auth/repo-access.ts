type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Does this GitHub user have write (push) access to owner/name? Asked with the
 * user's own OAuth token, so GitHub's own collaborator/team settings decide who
 * may use Tweaklet — add or remove someone on GitHub and Tweaklet follows.
 * Read-only access isn't enough: such a user couldn't push a change or open a
 * PR anyway. Any error (network, 403 for an unauthorised SSO token, 404 for a
 * repo they can't see) fails closed.
 */
export async function hasPushAccess(
  args: { token: string; owner: string; name: string; apiBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const bad = (s: string) => !SAFE_SEGMENT.test(s) || s === "." || s === ".." || s.startsWith("-");
  if (bad(args.owner) || bad(args.name)) return false;
  try {
    const r = await fetchImpl(`${args.apiBaseUrl}/repos/${args.owner}/${args.name}`, {
      headers: { Authorization: `Bearer ${args.token}`, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
    const p = body.permissions ?? {};
    return p.push === true || p.maintain === true || p.admin === true;
  } catch {
    return false;
  }
}
