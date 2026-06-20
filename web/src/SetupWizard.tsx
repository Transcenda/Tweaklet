import { useEffect, useState } from "react";
import { setupApi, api, getBase, type SetupStateResponse, type SetupCheck, type SetupStep } from "./api.js";
import { signIn } from "./auth.js";

interface Props {
  onComplete: () => void;
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button className="apz-btn" type="button" onClick={copy}>
      {copied ? "Copied!" : label}
    </button>
  );
}

const BADGE: Record<SetupCheck["status"], string> = { ok: "✓", warn: "!", fail: "✕" };

/**
 * Renders a list of doctor checks (failing first, then passing), with the
 * distro install command for any gap and an optional Re-check button. Shared by
 * the dependencies / agent / repo steps so each step shows only ITS checks.
 */
function CheckList({
  checks,
  onRecheck,
  allOkText = "All checks passed.",
}: {
  checks: SetupCheck[];
  onRecheck?: () => Promise<void>;
  allOkText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function recheck() {
    if (!onRecheck) return;
    setBusy(true);
    setErr("");
    try {
      await onRecheck();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Re-check failed");
    } finally {
      setBusy(false);
    }
  }

  const failing = checks.filter((c) => c.status !== "ok");
  const passing = checks.filter((c) => c.status === "ok");

  return (
    <div>
      {checks.length > 0 && failing.length === 0 && (
        <p className="apz-setup-instructions">{allOkText}</p>
      )}

      {failing.map((c) => (
        <div key={c.name} className="apz-setup-check">
          <span className={`apz-check-badge apz-check-badge--${c.status}`}>{BADGE[c.status]}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="apz-setup-check-name">{c.name}</div>
            <div className="apz-setup-check-detail">{c.detail}</div>
            {c.fix && <div className="apz-setup-check-fix">{c.fix}</div>}
            {c.installCommand && (
              <div className="apz-setup-check-cmd">
                <code className="apz-setup-check-code">{c.installCommand}</code>
                <CopyButton text={c.installCommand} />
              </div>
            )}
            {c.commands && c.commands.length > 0 && (
              <div className="apz-setup-check-cmd">
                <pre className="apz-setup-check-code apz-setup-check-codeblock">{c.commands.join("\n")}</pre>
                <CopyButton text={c.commands.join("\n")} />
              </div>
            )}
          </div>
        </div>
      ))}

      {passing.map((c) => (
        <div key={c.name} className="apz-setup-check apz-setup-check--ok">
          <span className="apz-check-badge apz-check-badge--ok">{BADGE.ok}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="apz-setup-check-name">{c.name}</div>
            <div className="apz-setup-check-detail">{c.detail}</div>
          </div>
        </div>
      ))}

      {err && <div className="apz-setup-error">{err}</div>}

      {onRecheck && (
        <div className="apz-setup-actions">
          <button className="apz-btn" type="button" onClick={recheck} disabled={busy}>
            {busy ? "Checking…" : "Re-check"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── step bodies ───────────────────────────────────────────────────────────────

function DepsStep({ checks, onRecheck }: { checks: SetupCheck[]; onRecheck: () => Promise<void> }) {
  return (
    <div>
      <p className="apz-setup-instructions">
        Install any missing tools on the server (over SSH), then Re-check. You can move on once
        everything here is green.
      </p>
      <CheckList checks={checks} onRecheck={onRecheck} allOkText="All system dependencies are satisfied." />
    </div>
  );
}

function GithubStep({ onSave }: { onSave: (state: SetupStateResponse) => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // getBase() is already an absolute origin+prefix (derived from the widget's
  // own <script src>), so the callback URL must NOT prepend window.location.origin
  // again — doing so produced a doubled-origin URL that broke OAuth.
  const callbackUrl = `${getBase()}/auth/callback`;

  async function save() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setErr("Both Client ID and Client Secret are required.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const state = await setupApi.github({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      onSave(state);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="apz-setup-instructions">
        Create a GitHub OAuth App at{" "}
        <a href="https://github.com/settings/developers" target="_blank" rel="noreferrer">
          github.com/settings/developers
        </a>
        . Set the callback URL below.
      </p>
      <div className="apz-setup-cb-url">
        <code>{callbackUrl}</code>
        <CopyButton text={callbackUrl} />
      </div>
      <div className="apz-setup-field">
        <label htmlFor="tw-gh-clientId">Client ID</label>
        <input
          id="tw-gh-clientId"
          type="text"
          placeholder="Ov23li…"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div className="apz-setup-field">
        <label htmlFor="tw-gh-clientSecret">Client Secret</label>
        <input
          id="tw-gh-clientSecret"
          type="password"
          placeholder="••••••••••••••••••••"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      {err && <div className="apz-setup-error">{err}</div>}
      <div className="apz-setup-actions">
        <button className="apz-btn apz-btn--ship" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save GitHub config"}
        </button>
      </div>
    </div>
  );
}

function AgentStep({
  checks,
  onSave,
  onRecheck,
}: {
  checks: SetupCheck[];
  onSave: (state: SetupStateResponse) => void;
  onRecheck: () => Promise<void>;
}) {
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!vertexProject.trim()) {
      setErr("Vertex project ID is required.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const body: { vertexProject: string; vertexLocation?: string; model?: string } = {
        vertexProject: vertexProject.trim(),
      };
      if (vertexLocation.trim()) body.vertexLocation = vertexLocation.trim();
      if (model.trim()) body.model = model.trim();
      const state = await setupApi.agent(body);
      onSave(state);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="apz-setup-field">
        <label htmlFor="tw-agent-project">Vertex AI Project ID</label>
        <input
          id="tw-agent-project"
          type="text"
          placeholder="my-gcp-project"
          value={vertexProject}
          onChange={(e) => setVertexProject(e.target.value)}
        />
      </div>
      <div className="apz-setup-field">
        <label htmlFor="tw-agent-location">Location (optional)</label>
        <input
          id="tw-agent-location"
          type="text"
          placeholder="us-central1"
          value={vertexLocation}
          onChange={(e) => setVertexLocation(e.target.value)}
        />
      </div>
      <div className="apz-setup-field">
        <label htmlFor="tw-agent-model">Model (optional)</label>
        <input
          id="tw-agent-model"
          type="text"
          placeholder="gemini-2.5-pro"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      {err && <div className="apz-setup-error">{err}</div>}
      <div className="apz-setup-actions">
        <button className="apz-btn apz-btn--ship" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save agent config"}
        </button>
      </div>
      {checks.length > 0 && <CheckList checks={checks} onRecheck={onRecheck} />}
    </div>
  );
}

function RepoStep({
  allowlist,
  onSave,
}: {
  allowlist: string[];
  onSave: (state: SetupStateResponse) => void;
}) {
  const [text, setText] = useState(allowlist.join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const parsed = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    setBusy(true);
    setErr("");
    try {
      const state = await setupApi.repo({ allowlist: parsed });
      onSave(state);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="apz-setup-instructions">
        List the repositories a signed-in user is allowed to work on (one
        <code> owner/name </code>per line). Each user clones their chosen repo
        with their own GitHub token after signing in — nothing is cloned here.
      </p>
      <div className="apz-setup-field">
        <label htmlFor="tw-repo-allowlist">Allowed repositories</label>
        <textarea
          id="tw-repo-allowlist"
          placeholder="owner/name (one per line)"
          value={text}
          rows={4}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {err && <div className="apz-setup-error">{err}</div>}
      <div className="apz-setup-actions">
        <button className="apz-btn apz-btn--ship" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save repositories"}
        </button>
      </div>
    </div>
  );
}

function FinishStep({ onComplete }: { onComplete: () => void }) {
  const [user, setUser] = useState<{ login: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [embedResult, setEmbedResult] = useState<{ embedded: boolean; widgetReachable: boolean; hostUrl: string; detail: string } | null>(null);
  const [agentResult, setAgentResult] = useState<{ ready: boolean; signedIn: boolean; opencodeOk: boolean; repoCloned: boolean; agentReplies?: boolean; detail: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  async function runVerify() {
    setVerifying(true);
    try {
      const [embed, agent] = await Promise.allSettled([
        setupApi.verifyEmbed(),
        setupApi.verifyAgent(),
      ]);
      if (embed.status === "fulfilled") setEmbedResult(embed.value);
      if (agent.status === "fulfilled") setAgentResult(agent.value);
    } finally {
      setVerifying(false);
    }
  }

  useEffect(() => {
    if (user) void runVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const result = await signIn();
      if (result === "signed-in") {
        const u = await api.me();
        setUser(u);
      }
    } finally {
      setSigningIn(false);
    }
  }

  async function finish() {
    setBusy(true);
    setErr("");
    try {
      await setupApi.complete();
      onComplete();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Finish failed");
    } finally {
      setBusy(false);
    }
  }

  const embedOk = !!(embedResult?.embedded && embedResult?.widgetReachable);

  if (user === undefined) {
    return <p className="apz-setup-instructions">Checking sign-in status…</p>;
  }

  return (
    <div className="apz-setup-finish">
      {user ? (
        <>
          <p>
            ✓ Your GitHub OAuth client works — signed in as <strong>{user.login}</strong>.
            Finish to save the configuration. (Day-to-day, each user signs in with
            their own GitHub account; this sign-in was just to verify the client.)
          </p>

          <div className="apz-setup-checks" style={{ margin: "12px 0" }}>
            <div className="apz-setup-check" style={{ marginBottom: 8 }}>
              <span className={`apz-check-badge apz-check-badge--${embedOk ? "ok" : "fail"}`}>
                {embedOk ? "✓" : "✕"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="apz-setup-check-name">Panel embedded in your app</div>
                {embedOk && embedResult && (
                  <div className="apz-setup-check-detail">
                    <a href={embedResult.hostUrl} target="_blank" rel="noreferrer">
                      Open in your app →
                    </a>
                  </div>
                )}
                {!embedOk && (
                  <div className="apz-setup-check-detail">
                    {embedResult?.detail
                      ? embedResult.detail
                      : "Add the Tweaklet snippet to your app and deploy it (see the install-tweaklet-widget skill), then Re-check."}
                  </div>
                )}
              </div>
            </div>

            <div className="apz-setup-check">
              <span className={`apz-check-badge apz-check-badge--${agentResult?.ready ? "ok" : "fail"}`}>
                {agentResult?.ready ? "✓" : "✕"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="apz-setup-check-name">Agent answers a test prompt</div>
                {agentResult && (
                  <div className="apz-setup-check-detail">{agentResult.detail}</div>
                )}
              </div>
            </div>
          </div>

          <div className="apz-setup-actions" style={{ marginBottom: 12 }}>
            <button className="apz-btn" type="button" onClick={runVerify} disabled={verifying}>
              {verifying ? "Checking…" : "Re-check"}
            </button>
          </div>

          {err && <div className="apz-setup-error">{err}</div>}
          <div className="apz-setup-actions" style={{ justifyContent: "center" }}>
            <button
              className="apz-btn apz-btn--primary"
              type="button"
              onClick={finish}
              disabled={busy || !embedOk || !agentResult?.ready}
            >
              {busy ? "Finishing…" : "Finish setup"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Sign in with GitHub to verify the OAuth client you configured works.</p>
          <button
            className="apz-btn apz-btn--primary"
            type="button"
            disabled={signingIn}
            onClick={handleSignIn}
          >
            {signingIn ? "Signing in…" : "Sign in with GitHub"}
          </button>
        </>
      )}
    </div>
  );
}

// ── wizard shell ─────────────────────────────────────────────────────────────

type StepId = "dependencies" | "github" | "agent" | "repo" | "finish";

interface WizardStep {
  id: StepId;
  label: string;
  serverStep: SetupStep | null;
}

function categoryOf(c: SetupCheck): SetupCheck["category"] {
  return c.category ?? "system";
}

export function SetupWizard({ onComplete }: Props) {
  const [stateResp, setStateResp] = useState<SetupStateResponse | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [openId, setOpenId] = useState<StepId | null>(null);

  async function loadState() {
    setLoadErr("");
    try {
      const s = await setupApi.state();
      setStateResp(s);
      if (openId === null) {
        setOpenId((s.firstIncompleteStepId as StepId | null) ?? "finish");
      }
    } catch (e: unknown) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load setup state");
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadState(); }, []);

  if (loadErr) {
    return (
      <div className="apz apz-setup">
        <div className="apz-setup-error" style={{ margin: 20 }}>{loadErr}</div>
      </div>
    );
  }

  if (!stateResp) {
    return (
      <div className="apz apz-setup">
        <div className="apz-auth">
          <div className="apz-mark" />
          <p>Loading setup…</p>
        </div>
      </div>
    );
  }

  const serverStepMap = new Map(stateResp.steps.map((s) => [s.id, s]));
  const allServerDone = stateResp.steps.every((s) => s.status === "done");

  const wizardSteps: WizardStep[] = [
    { id: "dependencies", label: "System dependencies", serverStep: serverStepMap.get("dependencies") ?? null },
    { id: "github", label: "GitHub OAuth", serverStep: serverStepMap.get("github") ?? null },
    { id: "agent", label: "AI agent", serverStep: serverStepMap.get("agent") ?? null },
    { id: "repo", label: "Repository", serverStep: serverStepMap.get("repo") ?? null },
    { id: "finish", label: "Finish", serverStep: null },
  ];

  function stepStatus(ws: WizardStep): "done" | "todo" {
    if (ws.id === "finish") return "todo";
    return ws.serverStep?.status ?? "todo";
  }

  // The first server step still to do is the "active" one. Steps AFTER it are
  // locked — you must clear the current red step before moving on. Done steps
  // (anywhere) stay reviewable; Finish unlocks only once all server steps pass.
  const firstTodoIdx = wizardSteps.findIndex((ws) => ws.serverStep && ws.serverStep.status === "todo");

  function isLocked(ws: WizardStep, idx: number): boolean {
    if (ws.id === "finish") return !allServerDone;
    if (ws.serverStep?.status === "done") return false;
    if (firstTodoIdx === -1) return false;
    return idx > firstTodoIdx;
  }

  async function handleRecheck() {
    const fresh = await setupApi.doctor();
    setStateResp(fresh);
  }

  function handleSave(fresh: SetupStateResponse) {
    setStateResp(fresh);
    // Advance to the next incomplete step (or Finish when all are done).
    const nextId = fresh.firstIncompleteStepId as StepId | null;
    if (nextId) setOpenId(nextId);
    else if (fresh.steps.every((s) => s.status === "done")) setOpenId("finish");
  }

  const systemChecks = stateResp.checks.filter((c) => categoryOf(c) === "system");
  const agentChecks = stateResp.checks.filter((c) => categoryOf(c) === "agent");

  return (
    <div className="apz apz-setup">
      <div className="apz-setup-header">
        <h1 className="apz-setup-title">
          <span className="apz-mark" />
          Tweaklet setup
        </h1>
        <p className="apz-setup-sub">Work through each step — clear the current one before the next unlocks.</p>
      </div>

      <div className="apz-setup-steps">
        {wizardSteps.map((ws, idx) => {
          const status = stepStatus(ws);
          const isDone = status === "done";
          const locked = isLocked(ws, idx);
          const isOpen = openId === ws.id && !locked;

          return (
            <div
              key={ws.id}
              className={[
                "apz-setup-step",
                isDone ? "apz-setup-step--done" : "",
                locked ? "apz-setup-step--locked" : "",
                isOpen ? "apz-setup-step--open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                className="apz-setup-step-head"
                type="button"
                disabled={locked}
                onClick={() => setOpenId(isOpen ? null : ws.id)}
                aria-expanded={isOpen}
              >
                <span
                  className={[
                    "apz-setup-step-status",
                    isDone ? "apz-setup-step-status--done" : "",
                    isOpen && !isDone ? "apz-setup-step-status--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isDone ? "✓" : locked ? "🔒" : ""}
                </span>
                <span
                  className={[
                    "apz-setup-step-label",
                    isDone ? "apz-setup-step-label--done" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {ws.label}
                </span>
                <span className="apz-setup-step-chevron">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen && (
                <div className="apz-setup-step-body">
                  {ws.id === "dependencies" && (
                    <DepsStep checks={systemChecks} onRecheck={handleRecheck} />
                  )}
                  {ws.id === "github" && <GithubStep onSave={handleSave} />}
                  {ws.id === "agent" && (
                    <AgentStep checks={agentChecks} onSave={handleSave} onRecheck={handleRecheck} />
                  )}
                  {ws.id === "repo" && (
                    <RepoStep allowlist={stateResp.allowlist} onSave={handleSave} />
                  )}
                  {ws.id === "finish" && <FinishStep onComplete={onComplete} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
