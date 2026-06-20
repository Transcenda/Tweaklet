import type { TweakletConfig } from "../config/config.js";
import type { Check } from "../doctor/doctor.js";

export interface SetupStep {
  id: string;
  label: string;
  status: "done" | "todo";
}

export interface SetupState {
  completed: boolean;
  steps: SetupStep[];
  firstIncompleteStepId: string | null;
}

export function computeSetupState(config: TweakletConfig, checks: Check[]): SetupState {
  const checkMap = new Map(checks.map((c) => [c.name, c]));

  function checkOk(name: string): boolean {
    const c = checkMap.get(name);
    return c?.status === "ok";
  }

  // Step: dependencies (node/git/opencode all ok)
  const depsOk =
    checkOk("node version") &&
    checkOk("git") &&
    checkOk("opencode");

  // Step: github (config.github present)
  const githubOk = !!config.github?.clientId && !!config.github?.clientSecret;

  // Step: agent (config.agent.vertexProject set AND opencode ok)
  const agentOk = !!config.agent?.vertexProject && checkOk("opencode");

  // Step: repo — the operator configures an ALLOWLIST of permitted repos here.
  // The actual clone is a per-user, post-sign-in action (POST /agent/clone), so
  // setup completion must NOT require a cloned repo (config.repo.path stays ""
  // until a signed-in user picks + clones one).
  const repoOk = (config.repo?.allowlist?.length ?? 0) > 0;

  const steps: SetupStep[] = [
    { id: "dependencies", label: "System dependencies", status: depsOk ? "done" : "todo" },
    { id: "github", label: "GitHub OAuth", status: githubOk ? "done" : "todo" },
    { id: "agent", label: "AI agent", status: agentOk ? "done" : "todo" },
    { id: "repo", label: "Repository", status: repoOk ? "done" : "todo" },
  ];

  const firstIncomplete = steps.find((s) => s.status === "todo") ?? null;

  return {
    completed: config.setup.completed,
    steps,
    firstIncompleteStepId: firstIncomplete?.id ?? null,
  };
}
