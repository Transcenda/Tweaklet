import { describe, it, expect } from "vitest";
import { runDiagnostics, detectPackageManager, type Exec, type AgentProbe } from "./doctor.js";
import type { TweakletConfig } from "../config/config.js";

const base: TweakletConfig = {
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  agent: { command: "/abs/opencode", cwd: "/repo", vertexProject: "p", vertexLocation: "global", model: "google-vertex-ai/gemini-2.5-pro" },
  repo: { path: "/repo", baseBranch: "main", branchPrefix: "sandbox/", prTarget: "main", allowlist: [] },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};

function execOk() { return async () => ({ code: 0, stdout: "ok", stderr: "" }); }
// Default agent probe stub — "server responding". Inject a failing one to test
// the not-responding path without spawning a real opencode server.
const probeOk: AgentProbe = async () => ({ ok: true, detail: "responding" });
const probeFail: AgentProbe = async () => ({ ok: false, detail: "spawn opencode ENOENT" });

describe("runDiagnostics", () => {
  it("reports opencode fail when the server does not respond", async () => {
    const checks = await runDiagnostics(base, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeFail });
    const oc = checks.find((c) => c.name === "opencode")!;
    expect(oc.status).toBe("fail");
    expect(oc.fix).toBeTruthy();
    expect(oc.category).toBe("system");
  });

  it("all-ok when every dependency responds", async () => {
    const exec = async () => ({ code: 0, stdout: "opencode 1.2.3", stderr: "" });
    const checks = await runDiagnostics(base, { exec, pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "repo")!.status).toBe("ok");
    expect(checks.find((c) => c.name === "opencode")!.status).toBe("ok");
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("tags every check with a wizard-step category", async () => {
    const checks = await runDiagnostics(base, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.every((c) => ["system", "github", "agent", "repo"].includes(c.category ?? ""))).toBe(true);
    expect(checks.find((c) => c.name === "repo")!.category).toBe("repo");
    expect(checks.find((c) => c.name === "vertex credentials")!.category).toBe("agent");
    expect(checks.find((c) => c.name === "node version")!.category).toBe("system");
  });

  it("warns on missing ADC when vertex configured (no key, no file, not on GCE)", async () => {
    const checks = await runDiagnostics(base, {
      exec: execOk(),
      pathExists: (p) => !p.includes("application_default"),
      home: "/home/u",
      probeAgent: probeOk,
      gceMetadataAdc: async () => false,
    });
    expect(checks.find((c) => c.name === "vertex credentials")!.status).toBe("warn");
  });

  it("vertex ok via the GCE metadata server (no key file, but on a GCE VM)", async () => {
    const checks = await runDiagnostics(base, {
      exec: execOk(),
      pathExists: (p) => !p.includes("application_default"), // no ADC file
      home: "/home/u",
      probeAgent: probeOk,
      gceMetadataAdc: async () => true, // VM service account can mint a token
    });
    const v = checks.find((c) => c.name === "vertex credentials")!;
    expect(v.status).toBe("ok");
    expect(v.detail).toMatch(/metadata-server/i);
  });

  it("no longer emits gh-auth or git-identity checks (auth is per-user OAuth now)", async () => {
    const checks = await runDiagnostics(base, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "github cli")).toBeUndefined();
    expect(checks.find((c) => c.name === "git identity")).toBeUndefined();
    expect(checks.find((c) => c.name === "git")!.status).toBe("ok"); // the git BINARY check stays
  });

  it("opencode reflects the server probe, not agent config (no agent configured + server up → ok)", async () => {
    const noAgent: TweakletConfig = {
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
      guardrails: { allow: ["frontend/src/**"] },
      setup: { completed: false },
    };
    const up = await runDiagnostics(noAgent, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(up.find((c) => c.name === "opencode")!.status).toBe("ok");
    const down = await runDiagnostics(noAgent, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeFail });
    expect(down.find((c) => c.name === "opencode")!.status).toBe("fail");
  });

  it("fails agent model when model is not set", async () => {
    const noModel: TweakletConfig = {
      ...base,
      agent: { command: "/abs/opencode", cwd: "/repo", vertexProject: "p", vertexLocation: "global" },
    };
    const checks = await runDiagnostics(noModel, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "agent model")!.status).toBe("fail");
  });

  it("warns when repo is not configured", async () => {
    const noRepo: TweakletConfig = {
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
      guardrails: { allow: ["frontend/src/**"] },
      agent: base.agent,
      setup: { completed: false },
    };
    const checks = await runDiagnostics(noRepo, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "repo")!.status).toBe("warn");
  });

  it("fails repo when .git dir is absent", async () => {
    const checks = await runDiagnostics(base, {
      exec: execOk(),
      pathExists: (p) => !p.includes(".git"),
      home: "/home/u",
      probeAgent: probeOk,
    });
    expect(checks.find((c) => c.name === "repo")!.status).toBe("fail");
  });

  it("fails base branch when rev-parse returns non-zero", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args.includes("rev-parse")) return { code: 128, stdout: "", stderr: "unknown" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const checks = await runDiagnostics(base, { exec, pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "base branch")!.status).toBe("fail");
  });

  it("warns when no origin remote", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args.includes("get-url")) return { code: 128, stdout: "", stderr: "no origin" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const checks = await runDiagnostics(base, { exec, pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    expect(checks.find((c) => c.name === "git remote")!.status).toBe("warn");
  });

  it("warns when the widget bundle is not built", async () => {
    const checks = await runDiagnostics(base, {
      exec: execOk(),
      pathExists: (p) => !p.includes("widget.js"),
      home: "/home/u",
      probeAgent: probeOk,
    });
    const widget = checks.find((c) => c.name === "widget")!;
    expect(widget.status).toBe("warn");
    expect(widget.category).toBe("system");
    // The dead "panel"/index.html check is gone.
    expect(checks.find((c) => c.name === "panel")).toBeUndefined();
  });

  it("node version check is ok on current Node (20+)", async () => {
    const checks = await runDiagnostics(base, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    const nodeCheck = checks.find((c) => c.name === "node version")!;
    expect(nodeCheck.status).toBe("ok");
    expect(nodeCheck.detail).toMatch(/✓/);
  });

  it("publicUrl reachable check warns when url is unreachable", async () => {
    // Use a URL on a closed port so the TCP connection is refused quickly.
    const unreachable: TweakletConfig = {
      ...base,
      server: { ...base.server, publicUrl: "http://127.0.0.1:1" },
    };
    const checks = await runDiagnostics(unreachable, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
    const urlCheck = checks.find((c) => c.name === "publicUrl reachable")!;
    expect(urlCheck.status).toBe("warn");
  });
});

describe("detectPackageManager", () => {
  // exec stub: report only the named binary as present (`command -v <bin>` → 0).
  const onlyHas = (present: string): Exec => async (_cmd, args) => {
    const found = args.join(" ").includes(`command -v ${present}`);
    return { code: found ? 0 : 1, stdout: "", stderr: "" };
  };

  it("detects apt-get and builds an apt install command", async () => {
    const pm = await detectPackageManager(onlyHas("apt-get"));
    expect(pm.name).toBe("apt-get");
    expect(pm.installCmd("git")).toBe("apt-get install -y git");
  });

  it("detects dnf", async () => {
    const pm = await detectPackageManager(onlyHas("dnf"));
    expect(pm.name).toBe("dnf");
    expect(pm.installCmd("git")).toBe("dnf install -y git");
  });

  it("prefers dnf over yum when both are present", async () => {
    const both: Exec = async (_c, a) =>
      ({ code: /command -v (dnf|yum)/.test(a.join(" ")) ? 0 : 1, stdout: "", stderr: "" });
    expect((await detectPackageManager(both)).name).toBe("dnf");
  });

  it("detects pacman / apk / brew", async () => {
    expect((await detectPackageManager(onlyHas("pacman"))).installCmd("git")).toBe("pacman -S --noconfirm git");
    expect((await detectPackageManager(onlyHas("apk"))).installCmd("git")).toBe("apk add git");
    expect((await detectPackageManager(onlyHas("brew"))).installCmd("git")).toBe("brew install git");
  });

  it("falls back to unknown when no package manager is found", async () => {
    const pm = await detectPackageManager(async () => ({ code: 1, stdout: "", stderr: "" }));
    expect(pm.name).toBe("unknown");
    expect(pm.installCmd("git")).toContain("git");
  });
});
