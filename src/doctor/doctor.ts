import type { TweakletConfig } from "../config/config.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;
export type CheckStatus = "ok" | "warn" | "fail";
// Which setup-wizard step a check belongs to. The doctor stays a single flat
// diagnostic pass; the wizard groups checks by this so later-step concerns
// (repo/agent) don't surface as scary failures in the "System dependencies" step.
export type CheckCategory = "system" | "github" | "agent" | "repo";
// `category` is optional on the type (so test fixtures and older payloads stay
// valid), but runDiagnostics sets it on every check it emits — consumers that
// group by step treat a missing category as "system".
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;                 // prose: what to do
  installCommand?: string;      // a single install command (missing-binary case)
  commands?: string[];          // copy-able remediation commands to run on the server
  category?: CheckCategory;
}

const OPENCODE_FIX =
  "Install opencode (https://opencode.ai), then set agent.command to its absolute path if it isn't on PATH (note it may be a symlink under a Homebrew Cellar node bin).";
/** Result of probing whether the opencode agent server is up and responding. */
export interface AgentProbeResult { ok: boolean; detail: string }
export type AgentProbe = () => Promise<AgentProbeResult>;
export interface DoctorDeps {
  exec?: Exec;
  pathExists?: (p: string) => boolean;
  home?: string;
  probeAgent?: AgentProbe;
  /** Whether the GCE metadata server can mint a token (i.e. ADC via the VM's
   *  service account). Injected for tests; default probes the real endpoint. */
  gceMetadataAdc?: () => Promise<boolean>;
}

/**
 * Default GCE metadata-server ADC probe: ask the metadata server for the
 * default service account token. Returns true only on a GCE VM whose SA can
 * mint tokens (key-less ADC — how opencode reaches Vertex on the dev server).
 * Fails fast (1s) off-GCE.
 */
const defaultGceMetadataAdc = async (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const req = http.request(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { method: "GET", headers: { "Metadata-Flavor": "Google" } },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.end();
  });

/**
 * Default agent probe: connect to (starting if needed) the opencode SDK server
 * and confirm it comes up within a timeout. `serve` warms this singleton at
 * startup, so during setup this usually returns the already-running server.
 * A spawn failure (binary missing) or timeout → not responding.
 */
const defaultProbeAgent: AgentProbe = async () => {
  try {
    const { getServer } = await import("../agent/opencode-server.js");
    await Promise.race([
      getServer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for opencode server")), 8000)),
    ]);
    return { ok: true, detail: "opencode server responding" };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message ?? String(e) };
  }
};

export interface PackageManager {
  /** the detected package-manager binary, e.g. "apt-get" / "dnf" / "unknown" */
  name: string;
  installCmd: (pkg: string) => string;
}

// Probe order: prefer the modern manager when several could coexist
// (e.g. dnf over yum). The first whose binary is on PATH wins.
const PACKAGE_MANAGERS: { bin: string; install: (pkg: string) => string }[] = [
  { bin: "apt-get", install: (p) => `apt-get install -y ${p}` },
  { bin: "dnf", install: (p) => `dnf install -y ${p}` },
  { bin: "yum", install: (p) => `yum install -y ${p}` },
  { bin: "zypper", install: (p) => `zypper install -y ${p}` },
  { bin: "pacman", install: (p) => `pacman -S --noconfirm ${p}` },
  { bin: "apk", install: (p) => `apk add ${p}` },
  { bin: "brew", install: (p) => `brew install ${p}` },
];

const UNKNOWN_PM: PackageManager = {
  name: "unknown",
  installCmd: (pkg) => `# install ${pkg} with your system package manager`,
};

/**
 * Detect the system package manager by probing for its binary on PATH
 * (`command -v`) — more robust than parsing /etc/os-release, since it
 * confirms the tool is actually installed and covers the full distro range.
 * `exec` is injected so this is unit-testable without real binaries. The
 * probed binary names are a fixed allowlist, so the `sh -c` is injection-safe.
 */
export async function detectPackageManager(exec: Exec): Promise<PackageManager> {
  for (const pm of PACKAGE_MANAGERS) {
    const { code } = await exec("sh", ["-c", `command -v ${pm.bin}`]);
    if (code === 0) return { name: pm.bin, installCmd: pm.install };
  }
  return UNKNOWN_PM;
}

const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      const errCode = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : undefined;
      const code = err && typeof errCode === "number" ? errCode : err ? 127 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export async function runDiagnostics(config: TweakletConfig, deps: DoctorDeps = {}): Promise<Check[]> {
  const exec = deps.exec ?? realExec;
  const pathExists = deps.pathExists ?? existsSync;
  const home = deps.home ?? homedir();
  const probeAgent = deps.probeAgent ?? defaultProbeAgent;
  const gceMetadataAdc = deps.gceMetadataAdc ?? defaultGceMetadataAdc;
  const checks: Check[] = [];
  // Detect once; reused for the install hints on missing-tool checks.
  const pm = await detectPackageManager(exec);

  // 1. opencode server — a SYSTEM dependency. Probe whether the opencode agent
  //    server actually comes up and responds (not just that a binary exists),
  //    independent of whether an agent is configured — so a fresh box is told to
  //    install/fix opencode rather than seeing a misleading "no agent configured".
  {
    const probe = await probeAgent();
    if (probe.ok) {
      checks.push({ name: "opencode", status: "ok", detail: probe.detail || "responding", category: "system" });
    } else {
      checks.push({ name: "opencode", status: "fail", detail: probe.detail || "not responding", fix: OPENCODE_FIX, category: "system" });
    }
  }

  // 2. agent model (AGENT step)
  if (config.agent?.model) {
    checks.push({ name: "agent model", status: "ok", detail: config.agent.model, category: "agent" });
  } else {
    checks.push({
      name: "agent model",
      status: "fail",
      detail: "no model set",
      fix: "Set agent.model in ~/.tweaklet/config.json (e.g. google-vertex-ai/gemini-2.5-pro).",
      category: "agent",
    });
  }

  // 3. Vertex ADC (AGENT step)
  if (!config.agent?.vertexProject) {
    checks.push({ name: "vertex credentials", status: "ok", detail: "n/a (no vertexProject configured)", category: "agent" });
  } else {
    const hasEnvCreds = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const hasAdcFile = pathExists(join(home, ".config/gcloud/application_default_credentials.json"));
    // On a GCE VM there is no key file/env — ADC comes from the metadata server
    // (the VM's service account), which is exactly how opencode reaches Vertex
    // on the dev box. Only probe it when the cheaper checks miss.
    const hasGceAdc = !hasEnvCreds && !hasAdcFile ? await gceMetadataAdc() : false;
    if (hasEnvCreds || hasAdcFile || hasGceAdc) {
      const detail = hasEnvCreds
        ? "GOOGLE_APPLICATION_CREDENTIALS set"
        : hasAdcFile
          ? "ADC file found"
          : "GCE metadata-server ADC (VM service account)";
      checks.push({ name: "vertex credentials", status: "ok", detail, category: "agent" });
    } else {
      checks.push({
        name: "vertex credentials",
        status: "warn",
        detail: "no ADC credentials found",
        fix: "Run `gcloud auth application-default login` (or run on a GCE VM whose service account has Vertex access) so opencode can reach Vertex.",
        category: "agent",
      });
    }
  }

  // 5. repo path (REPO step)
  if (!config.repo) {
    checks.push({ name: "repo", status: "warn", detail: "no repo configured", category: "repo" });
  } else {
    const gitDir = join(config.repo.path, ".git");
    if (pathExists(gitDir)) {
      checks.push({ name: "repo", status: "ok", detail: config.repo.path, category: "repo" });
    } else {
      checks.push({
        name: "repo",
        status: "fail",
        detail: `no .git at ${config.repo.path}`,
        fix: "config.repo.path is not a git repository.",
        category: "repo",
      });
    }
  }

  // 6. base branch (REPO step)
  if (!config.repo) {
    checks.push({ name: "base branch", status: "ok", detail: "n/a (no repo configured)", category: "repo" });
  } else {
    try {
      const { code } = await exec("git", ["-C", config.repo.path, "rev-parse", "--verify", config.repo.baseBranch]);
      if (code === 0) {
        checks.push({ name: "base branch", status: "ok", detail: config.repo.baseBranch, category: "repo" });
      } else {
        checks.push({
          name: "base branch",
          status: "fail",
          detail: `branch '${config.repo.baseBranch}' not found`,
          fix: `Base branch '${config.repo.baseBranch}' not found in the repo.`,
          category: "repo",
        });
      }
    } catch (e) {
      checks.push({
        name: "base branch",
        status: "fail",
        detail: String(e),
        fix: `Base branch '${config.repo.baseBranch}' not found in the repo.`,
        category: "repo",
      });
    }
  }

  // 7. git remote (REPO step)
  if (!config.repo) {
    checks.push({ name: "git remote", status: "ok", detail: "n/a (no repo configured)", category: "repo" });
  } else {
    try {
      const { code, stdout } = await exec("git", ["-C", config.repo.path, "remote", "get-url", "origin"]);
      if (code === 0) {
        checks.push({ name: "git remote", status: "ok", detail: stdout.trim(), category: "repo" });
      } else {
        checks.push({
          name: "git remote",
          status: "warn",
          detail: "no origin remote",
          fix: "No 'origin' remote — PRs need a GitHub remote.",
          category: "repo",
        });
      }
    } catch (e) {
      checks.push({
        name: "git remote",
        status: "warn",
        detail: String(e),
        fix: "No 'origin' remote — PRs need a GitHub remote.",
        category: "repo",
      });
    }
  }

  // 8. widget bundle built (SYSTEM). The no-iframe re-architecture serves the
  //    React app as a single self-mounting widget.js (not the old panel HTML),
  //    so this checks for that bundle.
  const widgetBundle = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist/widget.js");
  if (pathExists(widgetBundle)) {
    checks.push({ name: "widget", status: "ok", detail: "widget bundle found", category: "system" });
  } else {
    checks.push({
      name: "widget",
      status: "warn",
      detail: "web/dist/widget.js not found",
      fix: "Run `npm --prefix web run build` to build the widget bundle.",
      category: "system",
    });
  }

  // 9. node version (SYSTEM)
  {
    const match = process.version.match(/^v(\d+)\.(\d+)/);
    const major = match ? parseInt(match[1], 10) : 0;
    const minor = match ? parseInt(match[2], 10) : 0;
    if (major >= 20) {
      checks.push({ name: "node version", status: "ok", detail: `Node v${major}.${minor}.x ✓`, category: "system" });
    } else {
      checks.push({
        name: "node version",
        status: "fail",
        detail: `Node v20+ required, found ${process.version}`,
        fix: "Install Node 20+ from https://nodejs.org or via nvm",
        category: "system",
      });
    }
  }

  // 10. git binary (SYSTEM)
  try {
    const { code, stdout } = await exec("git", ["--version"]);
    if (code === 0) {
      checks.push({ name: "git", status: "ok", detail: stdout.trim() || "ok", category: "system" });
    } else {
      checks.push({
        name: "git",
        status: "fail",
        detail: `exit ${code}`,
        fix: "Install git",
        installCommand: pm.installCmd("git"),
        category: "system",
      });
    }
  } catch (e) {
    checks.push({
      name: "git",
      status: "fail",
      detail: String(e),
      fix: "Install git",
      installCommand: pm.installCmd("git"),
      category: "system",
    });
  }

  // 11. package manager (SYSTEM — informational; drives the install hints above)
  checks.push({
    name: "package manager",
    status: pm.name === "unknown" ? "warn" : "ok",
    detail: pm.name,
    category: "system",
    ...(pm.name === "unknown" ? { fix: "No known package manager on PATH; install tools manually." } : {}),
  });

  // 12. publicUrl reachable (SYSTEM)
  {
    const url = config.server.publicUrl;
    try {
      await new Promise<void>((resolve, reject) => {
        const mod = url.startsWith("https") ? https : http;
        const req = mod.request(url, { method: "HEAD" }, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      checks.push({ name: "publicUrl reachable", status: "ok", detail: `${url} reachable`, category: "system" });
    } catch {
      checks.push({
        name: "publicUrl reachable",
        status: "warn",
        detail: `${url} not reachable`,
        category: "system",
      });
    }
  }

  return checks;
}
