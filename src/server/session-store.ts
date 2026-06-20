import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionStore {
  get(login: string): string | undefined;
  set(login: string, id: string): void;
  delete(login: string): void;
}

/** Durable login→sessionId map (persisted JSON). opencode stores the actual
 *  message history; Tweaklet only needs to remember which session is whose so
 *  the conversation can be re-hydrated after a restart/crash. `io` injectable for tests. */
export function makeSessionStore(
  path: string,
  io: { read?: () => string | null; write?: (s: string) => void } = {},
): SessionStore {
  const read = io.read ?? (() => (existsSync(path) ? readFileSync(path, "utf8") : null));
  const write = io.write ?? ((s: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, s, { mode: 0o600 }); });
  let map: Record<string, string> = {};
  try { const raw = read(); if (raw) map = JSON.parse(raw); } catch { map = {}; }
  const persist = () => { try { write(JSON.stringify(map)); } catch { /* best-effort */ } };
  return {
    get: (l) => map[l],
    set: (l, id) => { map[l] = id; persist(); },
    delete: (l) => { delete map[l]; persist(); },
  };
}
