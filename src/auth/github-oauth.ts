type FetchLike = typeof fetch;

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  oauthBaseUrl: string;
}): string {
  const u = new URL("/login/oauth/authorize", args.oauthBaseUrl);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  u.searchParams.set("scope", "repo read:user user:email");
  return u.toString();
}

export async function exchangeCodeForToken(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string; oauthBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const res = await fetchImpl(`${args.oauthBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`token exchange returned no token: ${body.error ?? "unknown"}`);
  return body.access_token;
}

export interface GithubUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

export async function fetchGithubUser(
  args: { token: string; apiBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<GithubUser> {
  const h = { Authorization: `Bearer ${args.token}`, Accept: "application/vnd.github+json" };
  const res = await fetchImpl(`${args.apiBaseUrl}/user`, { headers: h });
  if (!res.ok) throw new Error(`fetch user failed: ${res.status}`);
  const body = (await res.json()) as { login: string; id: number; name?: string | null; email?: string | null };
  let email = body.email ?? undefined;
  if (!email) {
    try {
      const er = await fetchImpl(`${args.apiBaseUrl}/user/emails`, { headers: h });
      if (er.ok) {
        const emails = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email;
      }
    } catch { /* fall through to noreply */ }
  }
  if (!email) email = `${body.id}+${body.login}@users.noreply.github.com`;
  return { login: body.login, id: body.id, name: body.name || body.login, email };
}
