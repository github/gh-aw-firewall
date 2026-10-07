---
name: diagnose-awf
description: Diagnose an AWF (Agentic Workflow Firewall) failure from an error, workflow run URL, or symptom. Covers auth (api-proxy, enterprise/BYOK Copilot, OIDC, mcpg), ARC/DinD and self-hosted runners, alternative runtimes (gVisor/Kata/chroot), Squid/DNS/egress denials, CI and gh-aw safe-output failures, and suspected security regressions. Routes to the canonical diagnosis registry in docs/diagnostics.
allowed-tools: Bash(docker:*), Bash(gh:*), Bash(npx:*), Bash(npm:*), Bash(grep:*), Read
---

# Diagnose AWF Failures

Single entry point for diagnosing AWF failures. The canonical knowledge lives in
the diagnosis registry — this skill only routes and reports.

## Procedure

1. **Read the index** — [`docs/diagnostics/README.md`](../../../docs/diagnostics/README.md)
   for boundary routing and specialist references, and
   [`docs/diagnostics/agent-playbook.md`](../../../docs/diagnostics/agent-playbook.md)
   for the report shape and safety rules.
2. **Fingerprint** the run: AWF version, runner type (GitHub-hosted /
   self-hosted / ARC+DinD / GHES / GHEC), `DOCKER_HOST`, `GITHUB_SERVER_URL`,
   container runtime, provider, auth mode. Use `unknown` where unverified.
3. **Classify the failing boundary**: `runner`, `runtime`, `network`, `auth`,
   `ci`, `security`.
4. **Load only matching records**:

   ```bash
   npx tsx scripts/diagnostics/cli.ts search "<redacted error string>" --boundary <boundary>
   ```

   Without a clone, use the portable artifact
   `.github/agents/diagnose-awf.md` (prefer a tag matching your AWF version).
5. **Probe** with the matched finding's read-only probe when the match is
   ambiguous — one probe at a time.
6. **Report**: observed symptom, matched finding ID and evidence, affected
   version/topology, safe next probe, fix/workaround, citations.

## Auth routing

- **api-proxy sidecar / provider token exchange** → `AUTH-001`, `AUTH-002`
- **GitHub/Copilot enterprise and BYOK routing** → `AUTH-001`, [`docs/auth-matrix.md`](../../../docs/auth-matrix.md)
- **gh-aw-launched mcpg HTTP MCP GitHub OIDC** → `AUTH-003`

Check configuration presence/shape, route and health status, and redacted error
classes only.

## Safety rules

- Never request API keys, tokens, JWTs, `Authorization` headers, environment
  dumps, inference probes, or token exchanges.
- Never recommend `--env-all`, disabling isolation, or broadening the domain
  allowlist by default.
- Suspected isolation or credential-boundary regressions route to `SEC-001` and
  the repository security review process.
- If no record matches, say so, name the smallest missing evidence, and stop.
  Never invent a fix.

## Specialist references

- `.github/workflows/shared/self-hosted-failure-modes.md` — full runner catalog
- `.github/skills/debug-firewall/SKILL.md` — Squid, iptables, container state
- `.github/skills/awf-debug-tools/SKILL.md` — log parsing helpers
- `.github/skills/debugging-workflows/SKILL.md` — GitHub Actions log retrieval
- `docs/auth-matrix.md`, `docs/compatibility.md`, `docs/troubleshooting.md`

## Updating knowledge

Follow [`docs/diagnostics/patterns.md`](../../../docs/diagnostics/patterns.md).
Edit the canonical record, run `npm run diagnostics:render`, and open a reviewed
PR. Never edit generated artifacts or `.lock.yml` files by hand.
