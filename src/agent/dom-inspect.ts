export interface DomResult {
  exists: boolean;
  outerHTML?: string;
  text?: string;
  computedStyle?: Record<string, string>;
}

type Ctx = { send: (e: unknown) => void; pending: Map<string, (r: DomResult) => void> };

// One active holder (booking model) → one widget → one live page. The active
// prompt's SSE `send` + a per-prompt pending map are set for the turn's duration
// (server wires this in the next task); the MCP tool handler calls
// requestDomInspect; the widget answers via resolveDomInspect.
let active: Ctx | null = null;
export function setActivePrompt(ctx: Ctx | null): void { active = ctx; }

let seq = 0;
export async function requestDomInspect(selector: string, opts: { timeoutMs?: number } = {}): Promise<DomResult> {
  const ctx = active;
  if (!ctx) return { exists: false }; // no live widget channel
  const requestId = `dom_${++seq}`;
  return await new Promise<DomResult>((resolve) => {
    const timer = setTimeout(() => { ctx.pending.delete(requestId); resolve({ exists: false }); }, opts.timeoutMs ?? 15000);
    ctx.pending.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
    ctx.send({ type: "dom_inspect", requestId, selector });
  });
}

export function resolveDomInspect(requestId: string, result: DomResult): boolean {
  const fn = active?.pending.get(requestId);
  if (!fn) return false;
  active!.pending.delete(requestId);
  fn(result);
  return true;
}
