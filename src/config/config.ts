import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

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
