import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  detectRepoPath,
  detectBaseBranch,
  detectOpencode,
  detectVertexProject,
  detectGhLogin,
  generateSessionSecret,
} from "./detect.js";

// A git ref / branch name that gets passed to git on the CLI. Reject a
// leading '-' so a misconfigured value can't be read as an argv flag. This is
// defence-in-depth — the git invocations themselves also use `--` to separate
// options from operands; this just fails fast at config-load with a clear error.
const gitRefName = (s: z.ZodString) =>
  s.refine((v) => !v.startsWith("-"), "must not start with '-'");

export const ConfigSchema = z.object({
  github: z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      oauthBaseUrl: z.string().url().default("https://github.com"),
      apiBaseUrl: z.string().url().default("https://api.github.com"),
    })
    .optional(),
  server: z.object({
    port: z.number().int().positive(),
    publicUrl: z.string().url(),
    sessionSecret: z.string().min(16),
    basePath: z
      .string()
      .default("/tweaklet")
      .transform((v) => {
        // Normalize: ensure single leading slash, no trailing slash.
        const s = (v.startsWith("/") ? v : "/" + v).replace(/\/+$/, "");
        return s || "/tweaklet";
      })
      .refine(
        (v) => /^\/[A-Za-z0-9/_-]*$/.test(v),
        "server.basePath must start with '/' and contain only [A-Za-z0-9/_-]",
      ),
  }),
  agent: z
    .object({
      command: z.string().min(1).default("opencode"),
      cwd: z.string().min(1),
      vertexProject: z.string().optional(),
      vertexLocation: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  repo: z
    .object({
      path: z.string().default(""),
      baseBranch: gitRefName(z.string().min(1)).default("main"),
      branchPrefix: gitRefName(z.string()).default("tweaklet/"),
      prTarget: gitRefName(z.string().min(1)).default("main"),
      allowlist: z.array(z.string()).default([]),
      sourceDir: z.string().optional(),
    })
    .optional(),
  preview: z
    .object({
      serviceName: z.string(),           // systemd unit Tweaklet (re)starts, e.g. "t8a-frontend-dev"
      subdir: z.string(),                // dev-server cwd relative to repo.path, e.g. "frontend"
      installCheckDir: z.string(),       // if missing, run install before starting, e.g. "frontend/node_modules"
    })
    .optional(),
  run: z
    .object({
      liveUpdate: z.enum(["hot-reload", "rebuild-swap"]).default("hot-reload"),
      rebuildCommand: z.string().optional(),
    })
    .optional(),
  access: z
    .object({
      allowedLogins: z.array(z.string()).optional(),
      allowedUserIds: z.array(z.number()).optional(),
    })
    .optional(),
  guardrails: z
    .object({ allow: z.array(z.string()).default(["frontend/src/**"]) })
    .default({ allow: ["frontend/src/**"] }),
  setup: z.object({ completed: z.boolean().default(false) }).default({ completed: false }),
});

export type TweakletConfig = z.infer<typeof ConfigSchema>;
/** Input type — basePath and other defaulted fields are optional here. Use when constructing configs programmatically. */
export type TweakletConfigInput = z.input<typeof ConfigSchema>;

function configDir(): string {
  return join(process.env.TWEAKLET_HOME ?? homedir(), ".tweaklet");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}
export function configExists(): boolean {
  return existsSync(configPath());
}
export function saveConfig(cfg: TweakletConfigInput): void {
  const parsed = ConfigSchema.parse(cfg);
  const dir = dirname(configPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(parsed, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies on creation and is subject to umask, so
  // defensively lock down the dir + file (including ones left loose by prior runs).
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
    chmodSync(configPath(), 0o600);
  }
}
export function loadConfig(): TweakletConfig {
  if (!configExists()) {
    throw new Error(`No tweaklet config at ${configPath()}. Run \`tweaklet init\` first.`);
  }
  if (process.platform !== "win32" && (statSync(configPath()).mode & 0o077) !== 0) {
    console.warn(`Tweaklet: ${configPath()} was group/other-accessible; tightening to 0600 (it holds secrets).`);
    chmodSync(configPath(), 0o600);
  }
  return ConfigSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
}

/**
 * Does a config have what it needs to actually run? An agent command plus a repo
 * to work on (either a cloned `repo.path` or a non-empty allowlist the user can
 * clone from). Used to decide whether a config with `setup.completed === false`
 * is in fact functional and should stop showing the setup wizard/token.
 */
export function hasOperationalEssentials(cfg: TweakletConfig): boolean {
  return !!cfg.agent?.command && !!(cfg.repo?.path || (cfg.repo?.allowlist?.length ?? 0) > 0);
}

/**
 * Resolve a runnable config without requiring the user to hand-write one.
 *
 * - If a config file exists, load it (the file always wins — we never overwrite
 *   the user's values), then *heal* its setup-completion flag: a config that is
 *   operationally complete but still marked `setup.completed: false` gets flipped
 *   to true and persisted, so it stops printing the one-time setup token.
 * - If no config file exists, synthesize one from the ambient environment
 *   (git repo root, origin's default branch, the `opencode` binary, the active
 *   gcloud project, the logged-in gh user) plus schema defaults, persist it
 *   (so the generated session secret is stable and the user can inspect/edit it),
 *   and return it. A synthesized config is treated as configured for solo local
 *   use (`setup.completed: true`).
 */
export function resolveConfig(opts?: { cwd?: string }): TweakletConfig {
  if (configExists()) {
    const loaded = loadConfig();
    if (!loaded.setup.completed && hasOperationalEssentials(loaded)) {
      const healed = { ...loaded, setup: { completed: true } };
      saveConfig(healed);
      console.error(
        `tweaklet: existing config is operationally complete — marking setup as done (healed ${configPath()}).`,
      );
      return healed;
    }
    return loaded;
  }

  const cwd = opts?.cwd ?? process.cwd();
  const repoPath = detectRepoPath(cwd);
  const baseBranch = detectBaseBranch(repoPath);
  const opencode = detectOpencode();
  const vertexProject = detectVertexProject();
  const ghLogin = detectGhLogin();

  const input: TweakletConfigInput = {
    server: {
      port: 4319,
      publicUrl: "http://localhost:4319",
      sessionSecret: generateSessionSecret(),
    },
    agent: {
      command: opencode,
      cwd: repoPath,
      vertexProject,
      vertexLocation: "global",
      model: "google-vertex-ai/gemini-2.5-pro",
    },
    repo: {
      path: repoPath,
      baseBranch,
      prTarget: baseBranch,
    },
    access: ghLogin ? { allowedLogins: [ghLogin] } : undefined,
    setup: { completed: true },
  };

  const parsed = ConfigSchema.parse(input);
  saveConfig(parsed);

  console.error(
    [
      "tweaklet: no config found — auto-detected one from the environment:",
      `  repo path:      ${repoPath}`,
      `  base branch:    ${baseBranch}`,
      `  opencode:       ${opencode}`,
      `  vertex project: ${vertexProject ?? "none"}`,
      `  gh login:       ${ghLogin ?? "none"}`,
      `  written to:     ${configPath()}`,
    ].join("\n"),
  );

  return parsed;
}
