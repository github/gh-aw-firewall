---
description: Weekly review that keeps the sbx and gVisor integration docs accurate against upstream documentation and recent repo changes
on:
  schedule: weekly
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs] sbx/gVisor"'
    max: 1
permissions:
  contents: read
  copilot-requests: write
  pull-requests: read
sandbox:
  agent:
    id: awf
max-turns: 40
engine:
  id: copilot
network:
  allowed:
    - defaults
    - github
    - docs.docker.com
    - "*.gvisor.dev"
    - gvisor.dev
tools:
  web-fetch:
  bash:
    - "git log*"
    - "git show*"
    - "git diff*"
    - "cat*"
    - "ls*"
    - "grep*"
    - "rg*"
    - "sed*"
    - "head*"
    - "tail*"
    - "find*"
  edit:
  github:
    mode: gh-proxy
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    title-prefix: "[docs] sbx/gVisor: "
    labels: [documentation, ai-generated]
    reviewers: copilot
    draft: false
    allowed-files:
      - docs/sbx-integration.md
      - docs/gvisor-integration.md
timeout-minutes: 25
steps:
  - name: Ensure recent git history is available
    run: |
      if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
        git fetch --prune --unshallow
      fi
---

# sbx & gVisor Documentation Updater

You keep two integration docs accurate and current:

- `docs/sbx-integration.md` — how AWF uses **Docker Sandboxes (`sbx`)** as a microVM backend
- `docs/gvisor-integration.md` — how AWF runs the agent under the **gVisor `runsc`** runtime

Each week you reconcile these docs against (a) the **latest upstream documentation** for sbx and gVisor and (b) the **current repository implementation**, then open a single pull request with any corrections. If both docs are already accurate, you call `noop` — do not open an empty or cosmetic PR.

## Step 1 — Read the current docs

Read both files in full before doing anything else:

```bash
cat docs/sbx-integration.md
cat docs/gvisor-integration.md
```

Note every concrete, verifiable claim: CLI flags, env var names (`DOCKER_SANDBOXES_PROXY`, `HTTPS_PROXY`, `COPILOT_*`), IPs/ports, source file paths, function names, gVisor platform names (Systrap/KVM/ptrace), the netstack DNS behavior, and the referenced issue numbers.

## Step 2 — Check upstream documentation

Use `web-fetch` to read the current upstream docs and compare them against the claims you noted:

**Docker Sandboxes (sbx):**
- `https://docs.docker.com/ai/sandboxes/`
- `https://docs.docker.com/ai/sandboxes/architecture/`
- `https://docs.docker.com/ai/sandboxes/security/isolation/`

**gVisor:**
- `https://gvisor.dev/docs/architecture_guide/intro/`
- `https://gvisor.dev/docs/architecture_guide/platforms/`
- `https://gvisor.dev/docs/architecture_guide/networking/`

Look specifically for changes that would make the docs **wrong** (not merely differently worded): renamed/added/removed env vars or flags, changed proxy/credential behavior, changed default platform, new or removed isolation layers, changed CLI commands or install steps. Ignore pure prose/marketing differences.

## Step 3 — Check the repository implementation

The docs cite specific source files. Verify the doc claims still match the code using read-only commands (`cat`, `grep`, `git log`). Key files:

- `src/container-runtime.ts` — the `RUNTIME_REGISTRY`, `executionModel`, and capability queries
- `src/sbx-manager.ts` — sbx lifecycle, `sanitizeEnvForSbx`, mounts, `DOCKER_SANDBOXES_PROXY` handling
- `src/commands/main-action.ts` — the sbx wiring (gateway IP, `host.docker.internal`, health checks)
- `src/services/agent-service.ts` — the `runtime: runsc` field and static-DNS `extra_hosts`
- `src/topology.ts` — the chroot `/host/etc/hosts` patching
- `src/services/agent-environment/tool-specific-environment.ts` — the Bun JIT shim
- `src/commands/validators/security-mode.ts` — microVM strict-mode handling

Also review changes merged in the **last 7 days** that touch these areas, so the docs reflect recent work:

```bash
git log --since="7 days ago" --oneline -- src/container-runtime.ts src/sbx-manager.ts src/commands/main-action.ts src/services/agent-service.ts src/topology.ts src/services/agent-environment/tool-specific-environment.ts src/commands/validators/security-mode.ts
```

For any recently changed file a doc references, read the relevant section and confirm the doc still matches (flag names, IPs, function names, env var names, behavior).

## Step 4 — Revise the docs

Using the `edit` tool, correct only what is actually inaccurate or newly missing:

- Fix outdated env vars, flags, IPs/ports, file paths, function names, and platform/behavior descriptions.
- Add a short note for genuinely new, relevant behavior; remove descriptions of behavior that no longer exists.
- Keep edits **minimal and surgical** — preserve the existing structure, headings, tone, mermaid diagrams, and the relative `./file.md` cross-links. Do not rewrite sections that are still accurate.
- Do not touch any file other than the two integration docs (the safe output only allows those two paths).

## Step 5 — Open a pull request (or noop)

If you made changes, the `create-pull-request` safe output opens the PR. Write a description that:

- lists each correction and whether it came from **upstream docs** or the **repo implementation**
- cites the upstream URL and/or the commit/PR or source file each change derives from
- notes anything you reviewed but deliberately left unchanged

If **both docs are already accurate** against upstream and the code, call `noop` with a one-line explanation. Do not open a PR just to reword accurate content.

## Guardrails

- Read-only analysis plus edits to the two docs only — never modify code or other files.
- Every factual change must be backed by an upstream URL or a repo source reference; do not invent behavior.
- Prefer the narrowest change; when in doubt whether something is a real inaccuracy versus a wording preference, leave it.
