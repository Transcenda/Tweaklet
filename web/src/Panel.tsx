import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, streamPrompt, getBase, type User, type DoctorCheck, type Branches, type ChangeBranch } from "./api.js";
import { signIn, lastSignInMessage } from "./auth.js";
import { formatContext, type PickedElement, type PageContext } from "./contextCapture.js"; // PageContext used in getPageContext return type
import { startPick, highlightElement, clearHighlight } from "./picker.js";
import { inspectDom } from "./dom-inspect.js";

// One entry in the rendered stream. Assistant prose / tool activity arrive as
// "parts" keyed by opencode's part id; the rest (you/note/error/approval) are
// appended directly as the run unfolds.
type Row =
  | { kind: "you"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail?: string; input?: unknown; output?: string; diff?: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  | { kind: "approval"; id: string; permission: string; patterns: string[]; diff?: string; answer?: "approve" | "deny" };

// Plain-English action, mimicking Cursor/Copilot ("Read package.json", "Edited AppShell.tsx").
function describeTool(name: string, detail?: string): string {
  const n = (name || "").toLowerCase();
  const t = (detail || "").trim();
  if (n === "bash" || n === "shell") return t ? `Ran ${t}` : "Ran a command";
  if (n === "grep" || n === "search") return t ? `Searched the code for “${t}”` : "Searched the code";
  if (n === "glob") return t ? `Looked for files matching ${t}` : "Looked through the files";
  if (n === "read" || n === "cat") return t ? `Read ${t}` : "Read a file";
  if (n === "edit" || n === "patch" || n === "multiedit") return t ? `Edited ${t}` : "Edited a file";
  if (n === "write") return t ? `Wrote ${t}` : "Created a file";
  if (n === "list" || n === "ls") return t ? `Listed ${t}` : "Listed the files";
  if (n === "webfetch" || n === "fetch") return t ? `Fetched ${t}` : "Fetched a page";
  if (n === "task") return "Worked through a sub-task";
  if (n.startsWith("todo")) return "Updated its plan";
  return t ? `${name} · ${t}` : name || "Working";
}

const GLYPH: Record<string, string> = {
  look: "⌕", edit: "✎", run: "❯", plan: "◔", net: "ↆ",
};
function glyphFor(name: string): string {
  const n = (name || "").toLowerCase();
  if (["read", "cat", "glob", "grep", "search", "list", "ls"].includes(n)) return GLYPH.look;
  if (["edit", "patch", "multiedit", "write"].includes(n)) return GLYPH.edit;
  if (["bash", "shell"].includes(n)) return GLYPH.run;
  if (["webfetch", "fetch"].includes(n)) return GLYPH.net;
  if (n === "task" || n.startsWith("todo")) return GLYPH.plan;
  return "▸";
}
function summaryFor(name: string): string {
  const n = (name || "").toLowerCase();
  if (["edit", "patch", "multiedit", "write"].includes(n)) return "Show changes";
  if (["bash", "shell"].includes(n)) return "Show output";
  if (["read", "cat", "list", "ls", "glob", "grep"].includes(n)) return "Show what it saw";
  return "Show details";
}

// Strip opencode's machine wrappers so the expand reads like a file/diff, not XML.
function cleanOutput(output?: string): string {
  if (!output) return "";
  const m = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  let s = m ? m[1] : output;
  s = s.replace(/\n*\(End of file[^)]*\)\s*$/, "");
  return s.trim();
}

// What to show inside the expand: an explicit diff, the cleaned output, or a
// synthesised diff for edits.
function toolBody(row: Extract<Row, { kind: "tool" }>): string {
  if (row.diff && row.diff.trim()) return row.diff.trim();
  const out = cleanOutput(row.output);
  if (out) return out;
  const i = row.input as Record<string, unknown> | undefined;
  if (i && typeof i === "object") {
    const before = typeof i.oldString === "string" ? i.oldString : "";
    const after = typeof i.newString === "string" ? i.newString : "";
    if (before || after) {
      const minus = before ? before.split("\n").map((l) => "- " + l).join("\n") : "";
      const plus = after ? after.split("\n").map((l) => "+ " + l).join("\n") : "";
      return [minus, plus].filter(Boolean).join("\n");
    }
    if (typeof i.content === "string") return i.content;
    if (typeof i.command === "string") return i.command;
  }
  return "";
}

function ToolRow({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const body = toolBody(row);
  return (
    <div className="apz-row apz-tool-row">
      <div className="apz-tool-head">
        <span className="apz-tool-glyph">{glyphFor(row.name)}</span>
        <span className="apz-tool-label">{describeTool(row.name, row.detail)}</span>
      </div>
      {body && (
        <details className="apz-tool-more">
          <summary>{summaryFor(row.name)}</summary>
          <pre className="apz-pre">{body}</pre>
        </details>
      )}
    </div>
  );
}

// Say plainly what a permission request would do (ask mode).
function approvalTitle(permission: string): string {
  switch ((permission || "").toLowerCase()) {
    case "bash": return "Run this command on the server?";
    case "webfetch": return "Fetch this web page?";
    case "websearch": return "Search the web for this?";
    case "doom_loop": return "The agent keeps repeating the same step. Let it continue?";
    default: return `Allow the agent to use "${permission}"?`;
  }
}

// What the server refused on its own (auto mode), in plain words.
function deniedText(permission: string, patterns: string[]): string {
  const what = patterns.filter(Boolean).join(", ");
  const kind = (permission || "").toLowerCase();
  const action =
    kind === "bash" ? `run \`${what || "a command"}\`` :
    kind === "webfetch" ? `fetch ${what || "a web page"}` :
    kind === "websearch" ? "search the web" :
    kind === "edit" || kind === "write" || kind === "patch" ? `edit ${what || "files"} (outside the editable area)` :
    kind === "task" ? "hand work to a sub-agent" :
    kind === "external_directory" ? "touch files outside the project" :
    `use "${permission}"`;
  return `⛔ Not allowed here: ${action}. A developer needs to do this.`;
}

// A risky permission opencode is asking us to approve. Shows the command/diff and
// Allow/Deny; once answered it collapses to a short note via onAnswer.
function ApprovalCard({
  row,
  onAnswer,
}: {
  row: Extract<Row, { kind: "approval" }>;
  onAnswer: (id: string, response: "approve" | "deny") => void;
}) {
  if (row.answer)
    return (
      <div className="apz-row apz-note">
        {row.answer === "approve" ? "✓ allowed" : "✕ denied"}
      </div>
    );
  const title = approvalTitle(row.permission);
  const body = (row.diff && row.diff.trim()) || (row.patterns ?? []).join("\n");
  return (
    <div className="apz-row apz-approve">
      <div className="apz-approve-title">{title}</div>
      {body && <pre className="apz-pre">{body}</pre>}
      <div className="apz-approve-actions">
        <button className="apz-approve-allow" onClick={() => onAnswer(row.id, "approve")}>Allow</button>
        <button className="apz-approve-deny" onClick={() => onAnswer(row.id, "deny")}>Deny</button>
      </div>
    </div>
  );
}

// Map re-hydrated opencode events (GET /agent/history) to rendered rows.
function historyRows(events: any[]): Row[] {
  return events.flatMap((e: any): Row[] => {
    if (e.type === "message") {
      if (e.role === "user") return [{ kind: "you", text: String(e.text ?? "") }];
      if (e.role === "assistant") return [{ kind: "assistant", text: String(e.text ?? "") }];
    }
    if (e.type === "tool") return [{ kind: "tool", name: String(e.name ?? "tool"), detail: e.detail, input: e.input, output: e.output, diff: e.diff }];
    if (e.type === "note") return [{ kind: "note", text: String(e.text ?? "") }];
    if (e.type === "error") return [{ kind: "error", text: String(e.text ?? "") }];
    return [];
  });
}

function savesLabel(n: number): string { return n === 0 ? "no saves yet" : n === 1 ? "1 save" : `${n} saves`; }

// The change switcher: every change in progress, one click to switch, a bin to
// delete, and a way back to the live app. Switching never loses work — the
// server auto-saves the current change's unsaved edits first.
function ChangeSwitcher({
  branches, base, me, onFeature, busy, onSwitch, onDelete, onNew, onClose,
}: {
  branches: ChangeBranch[]; base: string; me: string; onFeature: boolean; busy: boolean;
  onSwitch: (b: string) => void; onDelete: (b: ChangeBranch) => void; onNew: () => void; onClose: () => void;
}) {
  return (
    <div className="apz-switcher" role="menu" aria-label="Your changes" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <button type="button" role="menuitem" className={"apz-change apz-change--live" + (!onFeature ? " is-current" : "")} disabled={busy || !onFeature} onClick={() => onSwitch(base)}>
        <span className="apz-change-dot apz-change-dot--live" />
        <span className="apz-change-main">
          <span className="apz-change-title">Live app</span>
          <span className="apz-change-meta">{base} · no changes</span>
        </span>
      </button>
      <div className="apz-switcher-head">
        {branches.length === 0 ? "No changes in progress" : `In progress · ${branches.length}`}
      </div>
      {branches.length === 0 ? (
        <div className="apz-switcher-empty">Describe a change below and Tweaklet starts one on a fresh copy of {base}.</div>
      ) : branches.map((b) => {
        const someoneElse = !!b.owner && b.owner.toLowerCase() !== me.toLowerCase();
        return (
        <div key={b.name} className={"apz-change-row" + (b.current ? " is-current" : "")}>
          <button type="button" role="menuitem" className="apz-change" disabled={busy || b.current} onClick={() => onSwitch(b.name)} title={b.name}>
            <span className="apz-change-dot" />
            <span className="apz-change-main">
              <span className="apz-change-title">{b.title}</span>
              <span className="apz-change-meta">
                {savesLabel(b.saves)} · {b.updated}{someoneElse && ` · @${b.owner}`}
                {b.dirty && <span className="apz-change-tag">unsaved</span>}
              </span>
            </span>
          </button>
          {!someoneElse && (
            <button type="button" className="apz-change-del" aria-label={`Delete ${b.title}`} title="Delete this change" disabled={busy} onClick={() => onDelete(b)}>✕</button>
          )}
        </div>
        );
      })}
      <button type="button" role="menuitem" className="apz-switcher-new" disabled={busy} onClick={onNew}>+ New change</button>
    </div>
  );
}

const INTRO =
  "Ask how things work, or describe a new thing you'd like to build.";
const EXAMPLES = [
  "How does the login flow work?",
  "Add a hello-world banner to the header",
  "Make the primary button larger and rounder",
];

// The feature-development workflow, shown as a timeline at the top of the panel.
const STEPS: { label: string; aria: string }[] = [
  { label: "Start", aria: "Start a new request" },
  { label: "Describe", aria: "Describe your change" },
  { label: "Save", aria: "Save your progress" },
  { label: "Submit", aria: "Submit for the team to review" },
];

type Health = "ok" | "warn" | "fail" | "unknown";
function overall(checks: DoctorCheck[]): Health {
  if (!checks.length) return "unknown";
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}
const HEALTH_LABEL: Record<Health, string> = {
  ok: "all systems go", warn: "warnings", fail: "needs attention", unknown: "checking…",
};

export function Panel() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  // `running` = an agent turn is streaming (Stop applies); `busy` also covers
  // quick git operations (switch / start / save), which show a quieter hint.
  const [running, setRunning] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cost, setCost] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [picked, setPicked] = useState<(PickedElement & { pickId: number })[]>([]);
  const pickCounter = useRef(0);
  const stopPickRef = useRef<(() => void) | null>(null);
  // Set to true the moment the user sends a prompt — guards the history seeder from
  // overwriting an in-progress conversation even before React commits the rows update.
  const sentRef = useRef(false);
  const [vcs, setVcs] = useState<Awaited<ReturnType<typeof api.state>> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const refreshState = () => Promise.all([
    api.state().then(setVcs).catch(() => {}),
    api.branches().then(setBranches).catch(() => {}),
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [repoState, setRepoState] = useState<{ allowlist: string[]; cloned: boolean } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState("");

  const [signInNote, setSignInNote] = useState("");
  useEffect(() => { api.me().then(setUser).catch(() => setUser(null)); }, []);
  // On the sign-in screen, say up front if a teammate is using Tweaklet.
  useEffect(() => {
    if (user !== null) return;
    api.authStatus().then((s) => {
      if (s.inUse) setSignInNote(`Tweaklet is in use by a teammate right now. It frees up when they sign out, or after ${s.idleMinutes} minutes of inactivity${s.freeInMinutes !== undefined ? ` (about ${s.freeInMinutes} min from now)` : ""}.`);
      else setSignInNote("");
    }).catch(() => {});
  }, [user]);
  useEffect(() => { if (user) api.doctor().then((d) => setChecks(d.checks)).catch(() => {}); }, [user]);
  useEffect(() => { if (user) refreshState(); }, [user]);
  useEffect(() => { if (user) api.repos().then(setRepoState).catch(() => {}); }, [user]);
  useEffect(() => {
    if (!user) return;
    api.history().then(({ events }) => {
      if (!events.length) return;
      // Only seed when the log is empty and no prompt has been sent — never clobber an active conversation.
      if (sentRef.current) return;
      setRows((current) => (current.length > 0 ? current : historyRows(events)));
    }).catch(() => {});
  }, [user]);
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [rows, busy]);
  // Read page context directly from the host document — no message bridge needed.
  // Path only: query strings and hashes often carry reset tokens, OAuth codes
  // and ids that must not go to the model.
  const getPageContext = (): PageContext => ({
    route: window.location.pathname,
    title: document.title,
  });

  if (user === undefined)
    return <div className="apz"><div className="apz-auth"><div className="apz-mark" /><p>Loading…</p></div></div>;
  if (user === null)
    return (
      <div className="apz">
        <div className="apz-auth">
          <div className="apz-mark" />
          <h1>Tweaklet</h1>
          <p>Build against a live app, hand off a clean PR.</p>
          <button
            className="apz-btn apz-btn--primary"
            onClick={async () => {
              const result = await signIn();
              if (result === "signed-in") {
                const u = await api.me();
                setUser(u);
              } else if (result === "denied") {
                setSignInNote(lastSignInMessage());
              }
            }}
          >
            Continue with GitHub
          </button>
          {signInNote && <p className="apz-signin-note" role="status">{signInNote}</p>}
        </div>
      </div>
    );

  if (repoState !== null && !repoState.cloned) {
    if (repoState.allowlist.length === 0) {
      return (
        <div className="apz">
          <div className="apz-auth">
            <div className="apz-mark" />
            <p className="apz-empty">No repositories configured — ask your admin to add one in setup.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="apz">
        <div className="apz-auth">
          <div className="apz-mark" />
          <p>Pick a repository to get started.</p>
          <div className="apz-chips">
            {repoState.allowlist.map((r) => (
              <button
                key={r}
                className="apz-chip"
                disabled={cloning}
                onClick={async () => {
                  setCloning(true);
                  setCloneErr("");
                  try {
                    await api.clone(r);
                    setRepoState({ ...repoState, cloned: true });
                  } catch (e) {
                    setCloneErr(e instanceof Error ? e.message : "Clone failed");
                  } finally {
                    setCloning(false);
                  }
                }}
              >
                {r}
              </button>
            ))}
          </div>
          {cloning && <p>Cloning…</p>}
          {cloneErr && <div className="apz-setup-error">{cloneErr}</div>}
        </div>
      </div>
    );
  }

  const push = (r: Row | null) => { if (r) setRows((x) => [...x, r]); };

  function answerPermission(id: string, response: "approve" | "deny") {
    setRows((x) => x.map((r) => (r.kind === "approval" && r.id === id ? { ...r, answer: response } : r)));
    void api.respondPermission(id, response).catch((e) => push({ kind: "error", text: String(e) }));
  }

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    sentRef.current = true;
    setBusy(true);
    setRunning(true);
    push({ kind: "you", text });
    setPrompt("");
    if (taRef.current) taRef.current.style.height = "auto";

    // Per-run state. The server forwards opencode SERVER events; we record each
    // message's role, and keep an ordered map of "parts" (assistant prose + tool
    // calls) so deltas/updates upsert the same row. The row index map lets us
    // mutate a part in place inside setRows without re-deriving order.
    const roles = new Map<string, "user" | "assistant" | string>();
    let deniedShown = false; // per-action denial notes replace the end-of-run summary
    const partIndex = new Map<string, number>(); // partID -> index into rows

    // Upsert a part row by id; render only if its message role is assistant.
    const upsertPart = (
      partID: string,
      messageID: string,
      mut: (prev: Extract<Row, { kind: "tool" }> | Extract<Row, { kind: "assistant" }> | undefined) => Row | null,
    ) => {
      setRows((rows) => {
        const role = roles.get(messageID);
        const idx = partIndex.get(partID);
        if (role === "user") return rows; // the prompt echo is already shown as the "you" row
        const prev = idx != null ? (rows[idx] as Extract<Row, { kind: "tool" | "assistant" }>) : undefined;
        const next = mut(prev);
        if (!next) return rows;
        if (idx != null) { const copy = rows.slice(); copy[idx] = next; return copy; }
        partIndex.set(partID, rows.length);
        return [...rows, next];
      });
    };

    try {
      const ctx = formatContext(picked.length > 0 ? getPageContext() : null, picked);
      const sent = ctx ? `${ctx}\n\n${text}` : text;
      await streamPrompt(sent, (e: any) => {
        switch (e?.type) {
          case "message.updated": {
            const info = e.raw?.info;
            if (info?.id) roles.set(info.id, info.role);
            break;
          }
          case "message.part.updated": {
            const part = e.raw?.part;
            if (!part?.id || !part.messageID) break;
            if (part.type === "text") {
              const text = String(part.text ?? "");
              upsertPart(part.id, part.messageID, (prev) =>
                text.trim() || (prev && prev.kind === "assistant")
                  ? { kind: "assistant", text }
                  : null,
              );
            } else if (part.type === "tool") {
              const st = part.state ?? {};
              const input = st.input ?? {};
              const detail = input.filePath ?? input.pattern ?? input.command;
              const out = st.output;
              const diff = typeof out === "string" ? undefined : (st.metadata?.diff ?? out?.metadata?.diff);
              const output = typeof out === "string" ? out : undefined;
              upsertPart(part.id, part.messageID, () => ({
                kind: "tool",
                name: part.tool ?? "tool",
                detail,
                input,
                output,
                diff,
              }));
            }
            break;
          }
          case "message.part.delta": {
            const r = e.raw ?? {};
            if (r.field !== "text" || !r.partID || !r.messageID) break;
            upsertPart(r.partID, r.messageID, (prev) => ({
              kind: "assistant",
              text: (prev && prev.kind === "assistant" ? prev.text : "") + String(r.delta ?? ""),
            }));
            break;
          }
          case "session.updated": {
            const info = e.raw?.info;
            if (info) {
              if (typeof info.cost === "number") setCost(info.cost);
              const t = info.tokens ?? {};
              setTokens((Number(t.input) || 0) + (Number(t.output) || 0));
            }
            break;
          }
          case "branch": {
            // The server started a fresh change for this prompt (we were on the base).
            push({ kind: "note", text: `◆ Started “${e.title}” on a fresh copy of ${vcs?.base ?? "main"}` });
            if (e.synced === false) push({ kind: "note", text: "⚠ Couldn't fetch the latest version — this change starts from the last one Tweaklet saw. Reconnect GitHub to refresh." });
            void refreshState();
            break;
          }
          case "permission_ask": {
            push({
              kind: "approval",
              id: e.permissionID,
              permission: e.permission,
              patterns: e.patterns ?? [],
              diff: e.diff,
            });
            break;
          }
          case "dom_inspect": {
            // Read the live host DOM (redacted) and POST the result back. Every
            // read is shown, so the user always sees what the agent looked at.
            const selector = String(e.selector ?? "");
            const result = inspectDom(selector);
            void api.domResult(e.requestId, result);
            const shown = selector.length > 80 ? selector.slice(0, 79) + "…" : selector;
            push({
              kind: "note",
              text: result.refused
                ? `👁 The agent's look at “${shown}” was refused: ${result.refused}`
                : `👁 The agent looked at “${shown}”`,
            });
            return;
          }
          case "denied": {
            deniedShown = true;
            push({ kind: "note", text: deniedText(String(e.permission ?? ""), Array.isArray(e.patterns) ? e.patterns.map(String) : []) });
            break;
          }
          case "guardrail": {
            if (deniedShown) break;
            const blocked = e.blocked ?? [];
            push({ kind: "note", text: `⚠ ${blocked.length} change(s) outside the UI zone were blocked: ${blocked.join(", ")}` });
            break;
          }
          case "error": {
            push({ kind: "error", text: e.message ?? "error" });
            break;
          }
          // end / session.idle / everything else: ignore (the promise resolves on end).
        }
      });
    } catch (err) {
      push({ kind: "error", text: String(err) });
    } finally {
      setBusy(false);
      setRunning(false);
      taRef.current?.focus();
      void refreshState();
    }
  }

  async function ctl(fn: () => Promise<unknown>, note: string) {
    if (busy) return;
    setBusy(true);
    try { await fn(); push({ kind: "note", text: note }); }
    catch (e) { push({ kind: "error", text: String(e) }); }
    finally { setBusy(false); void refreshState(); }
  }

  const previewing = vcs?.previewing ?? null;
  async function preview(sha: string) { await ctl(() => api.preview(sha), "👁 previewing an earlier save"); }
  async function restoreHere() { if (!previewing) return; await ctl(() => api.restore(previewing), "✓ restored"); setHistoryOpen(false); }
  async function backToLatest() { await ctl(() => api.exitPreview(), "↩ back to latest"); }

  const handleStartPick = () => {
    // Cancel any in-progress pick before starting a new one.
    stopPickRef.current?.();
    stopPickRef.current = startPick((el) => {
      stopPickRef.current = null;
      pickCounter.current += 1;
      setPicked((prev) => [...prev, { ...el, pickId: pickCounter.current }]);
    });
  };

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline. (⌘/Ctrl+Enter also sends.)
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  async function rejectChanges() {
    if (busy) return;
    const base = vcs?.base ?? "main";
    if (!window.confirm(`Discard this change and return to the live app? Everything in it — saved and unsaved — is deleted.`)) return;
    setBusy(true);
    try {
      await api.reject();
      setRows([{ kind: "note", text: `✕ Discarded — back on the live app (${base}).` }]);
      setPrUrl(null);
      void refreshState();
    } catch (e) {
      push({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Recovery: the app stopped responding after an edit → throw away the unsaved
  // edits (the agent's latest work). Saved points and the change itself stay.
  async function recoverRevert() {
    if (busy) return;
    if (!window.confirm("Undo the agent's unsaved edits? Your saved points are kept.")) return;
    await ctl(() => api.undo(), "↩ undid the unsaved edits");
  }

  /** Load a change's own conversation after switching to it. Never blocks the
   *  switch: the log clears at once and fills in when the agent answers. */
  function loadConversation() {
    setRows([]);
    api.history()
      .then(({ events }) => setRows((cur) => (cur.length > 0 ? cur : historyRows(events))))
      .catch(() => {});
  }

  async function startChange() {
    if (busy) return;
    setSwitchOpen(false);
    setBusy(true);
    try {
      const r = await api.startIdea(prompt.trim() || "New change");
      setRows([{ kind: "note", text: `◆ Started “${r.title}” on a fresh copy of ${vcs?.base ?? "main"}` }]);
      if (!r.synced) push({ kind: "note", text: "⚠ Couldn't fetch the latest version — this change starts from the last one Tweaklet saw. Reconnect GitHub to refresh." });
      setPrUrl(null);
      taRef.current?.focus();
    } catch (e) { push({ kind: "error", text: String(e) }); }
    finally { setBusy(false); void refreshState(); }
  }

  async function switchTo(branch: string) {
    if (busy) return;
    setSwitchOpen(false);
    setBusy(true);
    try {
      await api.switchBranch(branch);
      setPrUrl(null);
      loadConversation();
    } catch (e) { push({ kind: "error", text: String(e) }); }
    finally { setBusy(false); void refreshState(); }
  }

  async function deleteChange(b: ChangeBranch) {
    if (busy) return;
    if (!window.confirm(`Delete “${b.title}”? Its saved and unsaved work is removed for good.`)) return;
    setBusy(true);
    try {
      await api.deleteBranch(b.name);
      if (b.current) { setRows([{ kind: "note", text: `✕ Deleted “${b.title}” — back on the live app.` }]); setPrUrl(null); }
    } catch (e) { push({ kind: "error", text: String(e) }); }
    finally { setBusy(false); void refreshState(); }
  }

  async function reconnect() {
    const result = await signIn();
    if (result === "signed-in") setUser(await api.me());
    else if (result === "denied") push({ kind: "error", text: lastSignInMessage() });
  }

  const health = overall(checks);
  const onFeature = !!vcs?.onFeature;
  const saved = (vcs?.commits.length ?? 0) > 0;
  const stage = prUrl ? 3 : saved ? 2 : onFeature ? 1 : 0;
  const changeList = branches?.branches ?? [];
  const currentChange = changeList.find((b) => b.current);

  async function goStage(i: number) {
    if (busy) return;
    if (i === 0) { await startChange(); }
    else if (i === 1) { taRef.current?.focus(); }
    else if (i === 2) { await ctl(() => api.checkpoint(), "⚑ progress saved"); }
    else { await ctl(async () => { const { url } = await api.createPr(currentChange?.title ?? (prompt || undefined)); setPrUrl(url); }, "✓ submitted for review"); }
  }

  return (
    <div className="apz">
      <div className="apz-bar">
        <button
          type="button"
          className={"apz-switch" + (onFeature ? "" : " apz-switch--live")}
          aria-haspopup="menu"
          aria-expanded={switchOpen}
          aria-label={`Your changes — ${onFeature ? currentChange?.title ?? vcs?.branch : "viewing the live app"}`}
          onClick={() => setSwitchOpen((o) => !o)}
        >
          <span className={"apz-branch-dot" + (onFeature ? "" : " apz-branch-dot--live")} />
          <span className="apz-switch-title">
            {onFeature ? (currentChange?.title ?? vcs?.branch) : `Live app · ${vcs?.base ?? "main"}`}
          </span>
          {changeList.length > 0 && <span className="apz-switch-count" title={`${changeList.length} in progress`}>{changeList.length}</span>}
          <svg className="apz-switch-caret" aria-hidden="true" viewBox="0 0 10 6" width="10" height="6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {onFeature ? (
          <div className="apz-bar-actions">
            <button type="button" className="apz-bar-btn" onClick={() => setHistoryOpen((o) => !o)}>History</button>
            <button type="button" className="apz-reject" disabled={busy} onClick={rejectChanges}>Discard</button>
          </div>
        ) : (
          <button type="button" className="apz-bar-btn apz-bar-btn--primary" disabled={busy} onClick={startChange}>New change</button>
        )}
        {switchOpen && <div className="apz-switch-backdrop" aria-hidden="true" onClick={() => setSwitchOpen(false)} />}
        {switchOpen && (
          <ChangeSwitcher
            branches={changeList}
            base={vcs?.base ?? "main"}
            me={user.login}
            onFeature={onFeature}
            busy={busy}
            onSwitch={(b) => void switchTo(b)}
            onDelete={(b) => void deleteChange(b)}
            onNew={() => void startChange()}
            onClose={() => setSwitchOpen(false)}
          />
        )}
      </div>
      {user.needsReauth && (
        <div className="apz-reauth" role="status">
          <span>GitHub connection expired — reconnect to start from the latest version and submit.</span>
          <button type="button" className="apz-bar-btn apz-bar-btn--primary" onClick={() => void reconnect()}>Reconnect</button>
        </div>
      )}
      {historyOpen && vcs?.onFeature && (
        <div className="apz-history">
          {vcs.commits.length === 0 ? (
            <div className="apz-history-empty">No saved points yet — use Save to create one.</div>
          ) : vcs.commits.map((c, i) => (
            <div key={c.sha} className={"apz-saved" + (i === 0 && !previewing ? " is-current" : "")}>
              <span className="apz-saved-dot" />
              <span className="apz-saved-msg">{c.message}</span>
              <span className="apz-saved-time">{c.relativeTime}</span>
              {!(i === 0 && !previewing) && (
                <button type="button" className="apz-bar-btn" disabled={busy} onClick={() => preview(c.sha)}>Preview</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="apz-flow">
        <div className="apz-steps">
          {STEPS.map((s, i) => (
            <button
              key={s.label}
              type="button"
              className={"apz-step" + (i < stage ? " is-done" : "") + (i === stage ? " is-active" : "")}
              aria-label={s.aria}
              title={s.aria}
              disabled={busy}
              onClick={() => goStage(i)}
            >
              <span className="apz-step-dot" />
              <span className="apz-step-label">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="apz-flow-tools">
          <button type="button" className="apz-icon" aria-label="App not responding? Undo the unsaved edits" title="App not responding? Undo the unsaved edits" disabled={busy || !onFeature} onClick={recoverRevert}>↩</button>
          <button type="button" className="apz-icon" aria-label="Refresh app" title="Refresh app" disabled={busy} onClick={() => ctl(() => api.refresh(), "↻ refreshed")}>↻</button>
          <button
            type="button"
            className="apz-avatar"
            aria-label={`Account and status — @${user.login} · ${HEALTH_LABEL[health]}`}
            aria-expanded={menuOpen}
            title="Account & status"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {user.login.charAt(0).toUpperCase()}
            <span className={`apz-avatar-dot apz-avatar-dot--${health}`} />
          </button>
          {menuOpen && (
            <div className="apz-menu" role="menu">
              <div className="apz-menu-user">
                <span className="apz-avatar apz-avatar--static" aria-hidden="true">{user.login.charAt(0).toUpperCase()}</span>
                <div>
                  <b>{"@" + user.login}</b>
                  <span className="apz-menu-sub">Signed in</span>
                </div>
              </div>
              {(cost > 0 || tokens > 0) && (
                <div className="apz-menu-stat">
                  <span>Spend this session</span>
                  <b>${cost.toFixed(2)} · {Math.round(tokens / 1000)}k tokens</b>
                </div>
              )}
              <div className="apz-menu-section">
                <div className="apz-menu-section-head">
                  <span className={`apz-dot apz-dot--${health}`} />Doctor scan — {HEALTH_LABEL[health]}
                </div>
                {checks.length === 0 ? (
                  <div className="apz-check"><span>Running diagnostics…</span></div>
                ) : (
                  checks.map((c) => (
                    <div key={c.name} className="apz-check">
                      <span className="apz-dot" style={{ background: c.status === "ok" ? "var(--accent)" : c.status === "warn" ? "var(--warn)" : "var(--err)" }} />
                      <b>{c.name}</b>
                      <span>{c.detail}{c.fix ? <span className="apz-fix">{c.fix}</span> : null}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {previewing && (
        <div className="apz-preview-banner">
          <span>👁 Previewing an earlier save</span>
          <div className="apz-preview-actions">
            <button type="button" className="apz-bar-btn apz-bar-btn--primary" disabled={busy} onClick={restoreHere}>Restore here</button>
            <button type="button" className="apz-bar-btn" disabled={busy} onClick={backToLatest}>Back to latest</button>
          </div>
        </div>
      )}
      <div className="apz-stream" data-testid="log">
        {rows.length === 0 && !busy ? (
          <div className="apz-empty">
            <div className="apz-caret">▌</div>
            <p>{INTRO}</p>
            <div className="apz-chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="apz-chip" onClick={() => { setPrompt(ex); taRef.current?.focus(); }}>{ex}</button>
              ))}
            </div>
          </div>
        ) : (
          rows.map((r, i) => {
            if (r.kind === "you") return <div key={i} className="apz-row apz-you">{r.text}</div>;
            if (r.kind === "assistant") return <div key={i} className="apz-row apz-assistant">{r.text}</div>;
            if (r.kind === "tool") return <ToolRow key={i} row={r} />;
            if (r.kind === "approval") return <ApprovalCard key={i} row={r} onAnswer={answerPermission} />;
            if (r.kind === "note") return <div key={i} className="apz-row apz-note">{r.text}</div>;
            return <div key={i} className="apz-row apz-err">{r.text}</div>;
          })
        )}
        {busy && (
          <div className="apz-working">
            <div className="apz-run" aria-label="working"><i /><i /><i /></div>
            {running
              ? <button className="apz-stop" aria-label="Stop" onClick={() => { void api.stop(); }}>Stop</button>
              : <span className="apz-working-hint">One moment…</span>}
          </div>
        )}
        {prUrl && (
          <div className="apz-row apz-pr">
            <span>Submitted for the team to review</span>
            <a href={prUrl} target="_blank" rel="noreferrer">View submission ↗</a>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {picked.length > 0 && (
        <div className="apz-context-bar">
          {picked.map((el) => (
            <span className="apz-ctx-chip" key={el.pickId}>
              <span
                className="apz-ctx-label"
                title={el.selectorPath}
                onMouseEnter={() => highlightElement(el.selectorPath)}
                onMouseLeave={() => clearHighlight()}
              >📍 {el.tag}{el.id ? "#" + el.id : ""}{el.classes.length ? "." + el.classes.join(".") : ""}</span>
              <button
                type="button"
                className="apz-ctx-clear"
                aria-label="Clear selected element"
                onClick={() => { setPicked((prev) => prev.filter((x) => x.pickId !== el.pickId)); clearHighlight(); }}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="apz-composer">
        <div className="apz-input">
          <button type="button" className="apz-ctx-pick" aria-label="Pick an element on the page" title="Pick an element on the page" onClick={handleStartPick}>📍</button>
          <textarea
            ref={taRef}
            placeholder="Describe a change…"
            value={prompt}
            disabled={busy || !!previewing}
            rows={1}
            autoFocus
            onKeyDown={onKey}
            onChange={(e) => {
              setPrompt(e.target.value);
              const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px";
            }}
          />
          <button className="apz-send" aria-label="Send" disabled={busy || !!previewing || !prompt.trim()} onClick={send}>↑</button>
        </div>
      </div>
    </div>
  );
}
