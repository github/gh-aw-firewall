---
name: diagnose-awf
description: Diagnose AWF failures from symptoms, workflow runs, or errors using the canonical diagnostics registry.
---

# AWF Diagnosis Agent Playbook

Use this playbook to diagnose a GitHub Agentic Workflow Firewall (AWF) failure
from an error string, a workflow run URL, or a described symptom.

This playbook is **authored**; the finding catalog below it is **generated**
from the canonical registry in [`docs/diagnostics/findings/`](findings/).
Never edit the generated section by hand.

## Procedure

1. **Fingerprint** — establish AWF version (`awf --version`), runner type
   (GitHub-hosted / self-hosted / ARC+DinD / GHES / GHEC), `DOCKER_HOST`,
   `GITHUB_SERVER_URL`, container runtime, provider, and auth mode. Record
   `unknown` for anything you cannot establish; do not guess.
2. **Classify the failing boundary** — `runner`, `runtime`, `network`, `auth`,
   `ci`, or `security`. Use the phase at which the run failed (container
   create, egress, credential exchange, post-agent safe output).
3. **Match the narrowest finding** — use the symptom lookup table, then confirm
   the discriminating conditions. Prefer one specific ID over several loose
   matches. Check the finding's version scope against the fingerprint.
4. **Probe** — if the match is ambiguous, ask for the finding's read-only probe
   output. One probe at a time.
5. **Report** — always answer in this shape:
   - Observed symptom
   - Matched finding ID (or "no match") and the evidence that selected it
   - Affected version / topology scope
   - Safe next probe
   - Fix or workaround
   - Citations (finding provenance links)

## Safety rules

- Never ask for API keys, tokens, JWTs, `Authorization` headers, full
  environment dumps, or any token exchange or inference probe. Configuration
  **presence and shape**, route/health status, and redacted error classes only.
- Never recommend `--env-all`, disabling isolation or the firewall, or
  broadening the domain allowlist as a default remedy.
- A suspected isolation or credential-boundary regression routes to `SEC-001`
  and the repository security review process, not to a bypass.
- If no finding matches, say so, name the smallest missing evidence, and stop.
  Never invent a fix.

## Auth routing

Distinguish these three auth surfaces before matching:

1. **AWF api-proxy sidecar / provider token exchange** — provider credentials
   and OIDC exchange live in the sidecar (`AUTH-001`, `AUTH-002`).
2. **GitHub / Copilot enterprise and BYOK routing** — target host selection and
   Authorization prefix rules (`AUTH-001`, see `docs/auth-matrix.md`).
3. **gh-aw-launched mcpg HTTP MCP GitHub OIDC** — runner-to-gateway OIDC
   propagation (`AUTH-003`).

## Specialist references

Reuse these instead of duplicating their commands:

- `docs/diagnostics/README.md` — registry index and boundary routing
- `.github/workflows/shared/self-hosted-failure-modes.md` — full runner catalog
- `.github/skills/debug-firewall/SKILL.md` — Squid/iptables/container inspection
- `.github/skills/awf-debug-tools/SKILL.md` — log parsing helpers
- `.github/skills/debugging-workflows/SKILL.md` — GitHub Actions log retrieval
- `docs/auth-matrix.md` — supported auth combinations (authoritative)
- `docs/compatibility.md` — supported platforms (authoritative)
- `docs/troubleshooting.md` — broad troubleshooting guide
