---
name: Auth Doctor Updater
description: Daily workflow that reviews provider authentication guidance and repository changes, updates approved AWF authentication and API-proxy docs, and opens a pull request.
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs] auth:"'
    max: 1
permissions:
  copilot-requests: write
  contents: read
  issues: read
  pull-requests: read
tools:
  github:
    toolsets: [default]
  web-fetch:
  bash: true
  cache-memory: true
  edit:
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github
    - platform.openai.com
    - learn.microsoft.com
    - docs.aws.amazon.com
    - cloud.google.com
    - docs.anthropic.com
    - platform.claude.com
    - ai.google.dev
    - docs.github.com
safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    title-prefix: "[docs] auth: "
    labels: [documentation, ai-generated]
    reviewers: copilot
    draft: false
    allowed-files:
      - README.md
      - docs/api-proxy-sidecar.md
      - docs/auth-matrix.md
      - docs/authentication-architecture.md
      - docs/awf-config-spec.md
      - docs/environment.md
      - docs/github_actions.md
      - docs/security.md
      - docs/usage.md
timeout-minutes: 20
steps:
  - name: Compute scan window
    run: |
      # Look back two days so a missed daily run does not create a coverage gap.
      # Overlap is de-duplicated against existing documentation and proposals.
      SINCE=$(date -u -d '2 days ago' +%Y-%m-%d)
      mkdir -p /tmp/gh-aw/agent
      echo "$SINCE" > /tmp/gh-aw/agent/scan-since.txt
      echo "Scanning for authentication guidance updated since $SINCE"
---

# Auth Doctor Updater

You maintain this repository's documentation for AWF authentication, API-proxy routing, and related gh-aw HTTP MCP GitHub OIDC behavior. Each day, reconcile current repository implementation and recent changes with official provider guidance, apply precise corrections to approved documentation files, and open one pull request.

Your only visible output is one documentation pull request through the configured safe output, or a `noop`.

## Scan Window

- **Repository:** ${{ github.repository }}
- **Since (UTC date):** read from `/tmp/gh-aw/agent/scan-since.txt`

Consider relevant issues, pull requests, releases, and documentation updates on or after the scan window. The window overlaps the previous daily run; de-duplicate anything already documented or covered by an open updater pull request.

## Step 1 — Read the Current Documentation and Implementation

Read these documentation files in full:

```bash
cat README.md
cat docs/auth-matrix.md
cat docs/authentication-architecture.md
cat docs/api-proxy-sidecar.md
cat docs/environment.md
cat docs/awf-config-spec.md
cat docs/github_actions.md
```

Verify concrete claims against current code, especially:

```bash
cat src/services/api-proxy-env-config.ts
cat src/services/api-proxy-credential-env.ts
cat src/services/agent-environment/excluded-vars.ts
cat src/services/agent-environment/env-passthrough.ts
cat containers/api-proxy/management.js
cat containers/api-proxy/startup.js
cat containers/agent/api-proxy-health-check.sh
```

Use `rg` to locate provider adapters, OIDC token providers, schema fields, tests, and any additional documentation that makes the same claim. Treat implementation and tests on the default branch as the source of truth for shipped AWF behavior.

## Step 2 — Research Recent Repository Lessons

Read the scan date, then search this repository for issues and pull requests updated since that date. Search several combinations of:

`authentication`, `api-proxy`, `OIDC`, `WIF`, `OpenAI`, `Anthropic`, `Copilot`, `BYOK`, `Gemini`, `Vertex`, `Azure`, `Entra`, `AWS`, `Bedrock`, `GCP`, `workload identity`, `ACTIONS_ID_TOKEN`, `mcpg`, `github-oidc`, `authorization header`, `credential isolation`, `health`, `reflect`.

Include open and closed issues plus merged pull requests. Read bodies and key comments to establish whether behavior is shipped on `main`, pending on another branch, or still unresolved. In particular, verify the current status of github/gh-aw-firewall#6894 and github/gh-aw#50053 before describing their behavior or compatibility work.

## Step 3 — Check Official Provider Guidance

Use `web-fetch` only for the allowlisted official documentation sites:

- OpenAI API authentication and endpoints: `https://platform.openai.com/docs/`
- Azure OpenAI and Entra workload identity: `https://learn.microsoft.com/azure/ai-services/openai/` and `https://learn.microsoft.com/entra/workload-id/`
- AWS IAM OIDC federation and Bedrock runtime authentication: `https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html` and `https://docs.aws.amazon.com/bedrock/`
- GCP workload identity federation and Vertex AI authentication: `https://cloud.google.com/iam/docs/workload-identity-federation` and `https://cloud.google.com/vertex-ai/docs/authentication`
- Anthropic API authentication and WIF: `https://docs.anthropic.com/` and `https://platform.claude.com/docs/`
- Gemini API-key authentication: `https://ai.google.dev/gemini-api/docs/api-key`
- GitHub Actions OIDC: `https://docs.github.com/actions/concepts/security/openid-connect`

Look for factual changes only: required permissions, supported auth modes, provider field names, audiences/scopes, endpoint or header behavior, route requirements, credential precedence, and deprecations. Ignore marketing or prose-only differences.

Never submit credentials, repository data, workflow logs, or configuration values to provider documentation sites. These checks are public documentation reads only.

## Step 4 — Audit the Supported Auth Matrix

Confirm the documentation consistently covers:

- static OpenAI and Anthropic keys;
- GitHub Copilot/GitHub auth and Copilot BYOK;
- static Gemini and Vertex API-key routes;
- Azure, AWS Bedrock, GCP Vertex, and Anthropic WIF through API-proxy OIDC;
- API-proxy enablement, provider route/listener availability, `/health`, and `/reflect`;
- required `id-token: write` and provider-specific non-secret configuration;
- unsupported or conflicting combinations, including Gemini API-key mode versus GCP WIF/Vertex;
- GitHub.com, GHEC, and GHES Copilot routing where supported.

Keep the API proxy and MCP gateway as separate trust paths:

- AWF owns the API-proxy sidecar and provider credential injection.
- gh-aw launches/configures mcpg in a runner-owned workflow step for HTTP MCP `auth.type: github-oidc`.
- AWF does not launch or configure mcpg.
- Actions OIDC request tokens, minted JWTs, exchanged cloud credentials, API keys, and authorization headers must never be exposed to the agent or reproduced in documentation examples.

## Step 5 — Classify Each Finding

For every candidate, choose one:

- **Already accurate** — implementation and official guidance match the docs; skip.
- **Shipped behavior missing from docs** — make the narrowest addition and cite the merged source.
- **Stale or incorrect claim** — replace it with evidence-backed wording.
- **Pending behavior presented as shipped** — add a current-main caveat and link the pending work.
- **Cross-document inconsistency** — identify every file that must change together.
- **Unverified provider change** — do not propose an update; state what evidence is missing.

Do not infer support from an unmerged pull request, a feature request, or provider documentation alone. AWF support requires current default-branch implementation and tests.

## Step 6 — Avoid Duplicate Pull Requests

Search open pull requests with `[docs] auth:` in the title. If an existing updater pull request covers the same findings, call `noop` instead of opening another pull request.

## Step 7 — Apply and Validate Documentation Changes

Edit only the files allowed by `safe-outputs.create-pull-request.allowed-files`. Do not modify source code, tests, schemas, workflow files, generated files, or dependencies.

Before creating the pull request:

1. Review the diff and remove unrelated or cosmetic changes.
2. Confirm every factual change has current-main implementation evidence and an official or repository source.
3. Keep terminology and links consistent across every affected auth document.
4. Check Markdown structure, relative links, code fences, tables, and examples.
5. Search the diff for token/key/JWT values and credential-bearing URLs. Remove any such content.

## Output

If concrete corrections were applied, call `create-pull-request` once. The title prefix, labels, reviewer, draft state, and file allowlist are already configured.

Use this pull request body:

### Summary

- scan window and sources reviewed
- corrected authentication paths
- current-main versus pending behavior clarified

### Documentation Changes

List each changed file and the factual correction made.

### Validation

List the implementation/tests checked, Markdown/link review performed, and credential-leakage diff review.

### Sources

Link every repository issue/pull request and official provider page used. Use full URLs and do not include credential-bearing URLs or copied headers.

If no concrete corrections were applied, call `noop` with the scan window and a one-line explanation. Never open an empty, speculative, or prose-only pull request.

## Guardrails

- Modify approved documentation files only. Use the safe output for branch, commit, and pull-request creation; never run `git commit`, `git push`, or `gh pr create`.
- Never print, inspect, request, decode, hash, or reproduce secret values, Actions OIDC request tokens, minted JWTs, exchanged cloud credentials, API keys, cookies, or authorization headers.
- Never run credential probes, token exchanges, inference requests, broad environment dumps, `docker inspect`, or `docker compose config`.
- Treat identifiers such as tenant IDs, client IDs, role ARNs, service-account emails, and federation resource names as configuration metadata, but redact user-specific values in proposals.
- Prefer the smallest evidence-backed correction and preserve valid existing guidance.
- Fail closed: if a claim cannot be verified safely, classify it as unverified rather than guessing.
