import { randomBytes, timingSafeEqual } from "node:crypto";

// A random bearer token for the DOM-inspect MCP endpoint, fresh per server
// process. Tweaklet writes it into opencode's config (mode 0600) and the
// endpoint refuses any request that doesn't present it, so only the opencode
// this process launched can call the tool — never a request relayed by a
// reverse proxy, a browser, or another local user.
let token: string | null = null;

export function mcpToken(): string {
  if (!token) token = randomBytes(32).toString("hex");
  return token;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function isValidMcpAuth(header: string | undefined): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(mcpToken());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
