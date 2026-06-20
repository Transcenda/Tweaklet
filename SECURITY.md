# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **security@transcenda.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- any affected versions / configuration.

You'll get an acknowledgement within a few business days, and we'll keep you updated
as we investigate and ship a fix. We'll credit you in the release notes unless you
prefer to remain anonymous.

## Scope notes

Tweaklet is **self-hosted** and gives an AI agent write access to a cloned repository
under a signed-in user's own GitHub token. Areas we care about most:

- the per-user OAuth token handling (held in-memory, injected via `GIT_ASKPASS`,
  never persisted/logged/placed on a command line),
- the agent guardrail (edits restricted to an allow-listed path set),
- the repo allow-list enforcement (server-side),
- the DOM-inspect MCP (read-only, scoped to the active session),
- the loopback-only surfaces (CLI auth, the MCP endpoint).

Reports touching any of these are especially welcome.

## Supported versions

Tweaklet is pre-1.0 and ships from `main`. Security fixes land on `main`; please run
a recent build.
