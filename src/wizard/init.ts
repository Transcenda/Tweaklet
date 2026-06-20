import { randomBytes } from "node:crypto";
import { saveConfig, configPath, type TweakletConfigInput } from "../config/config.js";

export interface InitOptions {
  // GitHub OAuth creds are OPTIONAL: when omitted, init writes a server-only
  // config so `serve` can start and the operator finishes GitHub/agent/repo in
  // the web setup wizard. This is the intended onboarding path on a fresh box.
  githubClientId?: string;
  githubClientSecret?: string;
  publicUrl: string;
  port: number;
  githubOauthBaseUrl?: string;
  githubApiBaseUrl?: string;
}

export function runInit(opts: InitOptions): string {
  const cfg: TweakletConfigInput = {
    server: {
      port: opts.port,
      publicUrl: opts.publicUrl,
      sessionSecret: randomBytes(32).toString("hex"),
    },
    guardrails: { allow: ["frontend/src/**"] },
  };
  // Only attach GitHub OAuth when both creds are supplied; otherwise the wizard
  // captures them (POST /setup/github).
  if (opts.githubClientId && opts.githubClientSecret) {
    cfg.github = {
      clientId: opts.githubClientId,
      clientSecret: opts.githubClientSecret,
      oauthBaseUrl: opts.githubOauthBaseUrl ?? "https://github.com",
      apiBaseUrl: opts.githubApiBaseUrl ?? "https://api.github.com",
    };
  }
  saveConfig(cfg);
  return configPath();
}
