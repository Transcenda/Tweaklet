export interface User { login: string; id: number; }

// The base path/origin the widget was loaded from. `embed.ts` derives it from
// the <script src=".../widget.js"> URL at load and calls setBase() before the
// app renders; every request below is prefixed with it. (Replaces the old
// window.__TWEAKLET_BASE__ HTML injection — the bundle is now self-mounting.)
let _base = "";
export function setBase(b: string): void { _base = b; }
export function getBase(): string { return _base; }

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  async me(): Promise<User | null> {
    const res = await fetch(`${getBase()}/agent/me`, { credentials: "include" });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`/agent/me failed: ${res.status}`);
    return (await res.json()) as User;
  },
  startIdea: (idea: string) => post<{ branch: string }>(`${getBase()}/agent/idea`, { idea }),
  clone: (repoRef: string) => post<{ path: string }>(`${getBase()}/agent/clone`, { repoRef }),
  checkpoint: (message?: string) => post<void>(`${getBase()}/agent/checkpoint`, { message }),
  undo: () => post<void>(`${getBase()}/agent/undo`),
  reject: () => post<void>(`${getBase()}/agent/reject`),
  refresh: () => post<{ reloaded: boolean; ranCommand: string | null }>(`${getBase()}/agent/refresh`),
  createPr: (title?: string) => post<{ url: string }>(`${getBase()}/agent/pr`, { title }),
  prStatus: () => get<{ state: string; isDraft: boolean; url: string; reviews: { author: string; state: string; body: string }[] }>(`${getBase()}/agent/pr`),
  state: () => get<{ branch: string; base: string; onFeature: boolean; commits: { sha: string; message: string; relativeTime: string }[]; previewing: string | null }>(`${getBase()}/agent/state`),
  preview: (sha: string) => post<void>(`${getBase()}/agent/preview`, { sha }),
  exitPreview: () => post<void>(`${getBase()}/agent/preview/exit`),
  restore: (sha: string) => post<void>(`${getBase()}/agent/restore`, { sha }),
  doctor: () => get<{ checks: DoctorCheck[] }>(`${getBase()}/agent/doctor`),
  repos: () => get<{ allowlist: string[]; cloned: boolean }>(`${getBase()}/agent/repos`),
  stop: () => post<void>(`${getBase()}/agent/stop`),
  respondPermission: (permissionID: string, response: "approve" | "deny") =>
    post<void>(`${getBase()}/agent/permission`, { permissionID, response }),
  domResult: (requestId: string, result: unknown) =>
    post<void>(`${getBase()}/agent/dom-result`, { requestId, result }),
  history: () => get<{ events: any[]; sessionId?: string }>(`${getBase()}/agent/history`),
};

export interface DoctorCheck { name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string; }

// ── Setup wizard API ──────────────────────────────────────────────────────────

export const SETUP_TOKEN_KEY = "tweaklet.setupToken";

function getSetupToken(): string {
  return sessionStorage.getItem(SETUP_TOKEN_KEY) ?? "";
}

export class SetupAuthError extends Error {
  constructor() { super("setup token required"); }
}

async function setupFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSetupToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> ?? {}),
    "x-tweaklet-setup-token": token,
  };
  if ((init as RequestInit & { method?: string }).method === "POST") {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (res.status === 403) throw new SetupAuthError();
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export type SetupCheckCategory = "system" | "github" | "agent" | "repo";

export interface SetupCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;                 // prose: what to do to fix this check
  installCommand?: string;      // a single install command
  commands?: string[];          // copy-able remediation commands to run on the server
  // Which wizard step owns this check (set by the server's doctor). Older
  // payloads may omit it — callers treat a missing category as "system".
  category?: SetupCheckCategory;
}

export interface SetupStep {
  id: string;
  label: string;
  status: "done" | "todo";
}

export interface SetupStateResponse {
  completed: boolean;
  steps: SetupStep[];
  firstIncompleteStepId: string | null;
  checks: SetupCheck[];
  allowlist: string[];
}

export const setupApi = {
  state: () => setupFetch<SetupStateResponse>(`${getBase()}/setup/state`),
  github: (body: { clientId: string; clientSecret: string }) =>
    setupFetch<SetupStateResponse>(`${getBase()}/setup/github`, { method: "POST", body: JSON.stringify(body) }),
  agent: (body: { vertexProject: string; vertexLocation?: string; model?: string }) =>
    setupFetch<SetupStateResponse>(`${getBase()}/setup/agent`, { method: "POST", body: JSON.stringify(body) }),
  repo: (body: { allowlist: string[] }) =>
    setupFetch<SetupStateResponse>(`${getBase()}/setup/repo`, { method: "POST", body: JSON.stringify(body) }),
  doctor: () =>
    setupFetch<SetupStateResponse>(`${getBase()}/setup/doctor`, { method: "POST" }),
  complete: () =>
    setupFetch<{ completed: boolean }>(`${getBase()}/setup/complete`, { method: "POST" }),
  verifyEmbed: () =>
    setupFetch<{ embedded: boolean; widgetReachable: boolean; hostUrl: string; detail: string }>(`${getBase()}/setup/verify-embed`),
  verifyAgent: () =>
    setupFetch<{ ready: boolean; signedIn: boolean; opencodeOk: boolean; repoCloned: boolean; agentReplies?: boolean; detail: string }>(`${getBase()}/setup/verify-agent`),
};

export interface EndFrame { type: "end"; code: number; }

export async function streamPrompt(prompt: string, onEvent: (e: any) => void): Promise<EndFrame | null> {
  const res = await fetch(`${getBase()}/agent/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok || !res.body) throw new Error(`/agent/prompt failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let end: EndFrame | null = null;
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      buf += dec.decode(value ?? new Uint8Array(), { stream: !done }); // flush on final read
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith("data:")) continue; // skip SSE comments / event:/id: lines
        const line = frame.slice(frame.startsWith("data: ") ? 6 : 5).trim();
        if (!line) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type === "end") { end = obj as EndFrame; break outer; }
        onEvent(obj);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return end;
}
