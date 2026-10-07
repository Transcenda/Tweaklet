import { canonicalRepoPath, matchesAllow } from "../guardrails/guardrails.js";

export interface PermissionAsked { permission?: string; patterns?: string[]; }
export type Decision = "approve" | "deny" | "ask";

/**
 * How Tweaklet answers opencode's permission requests.
 * - `auto` (the default whenever GitHub sign-in is configured, i.e. a shared
 *   server): Tweaklet decides everything. Risky actions are never approvable
 *   from the browser — the panel runs inside the host page, and any script
 *   there (including code the agent itself writes and hot-reloads) could click
 *   Allow. So a browser can never turn into a shell on the server.
 * - `ask`: the same rules, but risky actions go to the person in the panel
 *   instead of being denied. For a developer's own machine, where they are the
 *   machine's owner anyway.
 */
export interface Policy {
  allow: string[];
  mode: "auto" | "ask";
  safeCommands: string[];
  /** The repo opencode edits. When set, each edit path is judged by where it
   *  really points (symlinks resolved), not just how it is spelled — see
   *  canonicalRepoPath. Unset keeps the lexical check only. */
  repoRoot?: string;
}

/** Shell commands that only read or check code. Tests are deliberately absent:
 *  they execute test files, which the agent can write. Exact matches only — no
 *  extra arguments (`npm run lint -- --fix` could rewrite files anywhere). */
export const DEFAULT_SAFE_COMMANDS = [
  "git status",
  "git diff",
  "git diff --stat",
  "git log",
  "git log --oneline",
  "npm run typecheck",
  "npm run lint",
  "npx tsc --noEmit",
];

const EDIT_KINDS = new Set(["edit", "write", "patch", "multiedit"]);
const READ_ONLY_KINDS = new Set(["read", "glob", "grep", "list", "lsp", "todowrite", "question", "skill"]);
// Subagents run outside the session Tweaklet supervises; outside the repo is off-limits.
const NEVER_KINDS = new Set(["task", "external_directory"]);
// Anything that could chain, redirect, substitute or background a command.
const SHELL_META = /[;&|<>`$\n\r\\()]/;

const norm = (cmd: string) => cmd.trim().replace(/\s+/g, " ");

function isSafeCommand(cmd: string, safe: string[]): boolean {
  if (SHELL_META.test(cmd)) return false;
  const c = norm(cmd);
  return safe.some((s) => norm(s) === c);
}

function editAllowed(p: string, policy: Policy): boolean {
  // The spelled path must pass (it is what the person sees), AND, when we know
  // the repo, so must the real target: a symlink inside an allowed dir can't
  // carry an edit out of it, into .git, or out of the repo.
  if (!matchesAllow(p, policy.allow)) return false;
  if (policy.repoRoot === undefined) return true;
  const real = canonicalRepoPath(policy.repoRoot, p);
  return real !== null && matchesAllow(real, policy.allow);
}

export function decidePermission(p: PermissionAsked, policy: Policy): Decision {
  const kind = (p.permission ?? "").toLowerCase();
  const patterns = p.patterns ?? [];
  const risky: Decision = policy.mode === "ask" ? "ask" : "deny";

  if (EDIT_KINDS.has(kind)) {
    if (patterns.length === 0) return "deny";
    return patterns.every((x) => editAllowed(x, policy)) ? "approve" : "deny";
  }
  if (READ_ONLY_KINDS.has(kind)) return "approve";
  if (NEVER_KINDS.has(kind)) return "deny";
  if (kind === "bash") {
    if (patterns.length > 0 && patterns.every((cmd) => isSafeCommand(cmd, policy.safeCommands))) return "approve";
    return risky;
  }
  // webfetch, websearch, doom_loop and anything opencode adds later.
  return risky;
}

/** Inline opencode config (OPENCODE_CONFIG_CONTENT, which overrides the host
 *  repo's own opencode.json and .opencode/ agent files): make opencode ask
 *  Tweaklet before every tool use, so the policy above always applies. */
export function opencodePermissionConfig(): Record<string, unknown> {
  return {
    permission: "ask",
    agent: { assistant: { permission: "ask" } },
  };
}
