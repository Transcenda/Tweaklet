#!/usr/bin/env node
import { runInit, type InitOptions } from "./wizard/init.js";
import { resolveConfig } from "./config/config.js";
import { serve } from "./server/server.js";
import { stopServer } from "./agent/opencode-server.js";
import { runDiagnostics, type CheckStatus } from "./doctor/doctor.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "init") {
    const publicUrl = flag("public-url") ?? "http://localhost:4319";
    const id = flag("github-client-id");
    const secret = flag("github-client-secret");
    const basePath = flag("base-path") ?? "/tweaklet";
    const opts: InitOptions = {
      // GitHub creds are optional — omit them to write a server-only config and
      // finish GitHub/agent/repo in the web setup wizard (the fresh-box path).
      githubClientId: id,
      githubClientSecret: secret,
      publicUrl,
      // Listen port is internal and independent of publicUrl (which may be a
      // proxied https host on 443). Default to 4319 unless --port is given.
      port: Number(flag("port") ?? "4319"),
      githubOauthBaseUrl: flag("github-oauth-base-url"),
      githubApiBaseUrl: flag("github-api-base-url"),
    };
    const path = runInit(opts);
    console.log(`Wrote config to ${path}`);
    if (!id || !secret) {
      console.log(
        [
          "",
          "Server-only config written (no GitHub OAuth yet). Next:",
          "  1. tweaklet serve",
          `  2. open ${publicUrl}${basePath}/  and finish setup in the wizard`,
          "     (it walks you through GitHub OAuth, the AI agent, and the repo).",
          "",
        ].join("\n"),
      );
    }
    return;
  }
  if (cmd === "serve") {
    const config = resolveConfig();
    if (!config.access?.allowedLogins?.length && !config.access?.allowedUserIds?.length) {
      console.warn("tweaklet WARNING: no access allowlist configured — any authenticated GitHub user can sign in. Set access.allowedLogins in your config.");
    }
    serve(config);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig as NodeJS.Signals, () => { stopServer().finally(() => process.exit(0)); });
    return;
  }
  if (cmd === "doctor") {
    let config;
    try {
      config = resolveConfig();
    } catch (e) {
      console.error("Could not resolve a tweaklet config (auto-detection failed). Run `tweaklet init` to write one.");
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    const checks = await runDiagnostics(config);
    const icon: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
    for (const c of checks) {
      console.log(`${icon[c.status]} ${c.name}: ${c.detail}`);
      if ((c.status === "warn" || c.status === "fail") && c.fix) {
        console.log(`  fix: ${c.fix}`);
      }
    }
    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    console.log(`\n${checks.length} checks — ${fails} failed, ${warns} warnings`);
    if (fails > 0) process.exitCode = 1;
    return;
  }
  console.error("Usage: tweaklet <init|serve|doctor> [flags]");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
