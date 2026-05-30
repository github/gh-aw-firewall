---
name: Config Consistency Auditor
description: >
  Daily audit of recently merged PRs to verify new configuration is consistently
  represented across JSON schema, spec, TypeScript types, and env var wiring —
  with security-sensitive values via env vars and non-sensitive via stdin config.
on:
  schedule: daily on weekdays
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
  issues: read
engine: copilot
strict: true
timeout-minutes: 20
network:
  allowed:
    - defaults
    - node
    - github
tools:
  github:
    mode: gh-proxy
    toolsets: [default, pull_requests]
  cache-memory: true
  bash: ["*"]
  edit:
safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    max: 1
    labels: [automation, config-consistency]
    title-prefix: "fix: "
---

# Config Consistency Auditor

You are an AI agent that audits recently merged PRs for configuration consistency.
Your goal is to catch gaps where new configuration was added to one layer but not
propagated to all required layers.

## Configuration Layers

Every new AWF configuration field MUST be consistently represented across:

1. **JSON Schema** (`src/awf-config-schema.json` and `docs/awf-config.schema.json`)
   - Must be identical copies
2. **Spec** (`docs/awf-config-spec.md`)
   - Section 5 CLI Mapping table must list the config path and its CLI flag or env var mapping
3. **TypeScript Types** (`src/types/*.ts` and `src/config-file.ts`)
   - The config-file interface must include the field
   - The options type must include the mapped CLI option
4. **Env Var Wiring** (`src/services/api-proxy-service.ts` or other service files)
   - The field must be mapped to its corresponding `AWF_*` env var for the api-proxy
   - OR mapped to a CLI flag that the runtime handles

## Security Classification

Configuration fields MUST follow these rules:

- **Security-sensitive values** (API keys, tokens, credentials, OIDC client IDs/secrets):
  - Passed via environment variables (`-e` flag or `--env-file`)
  - MUST NOT appear in stdin config JSON (which may be logged)
- **Non-sensitive values** (domains, multipliers, model names, timeouts, strategies):
  - Passed via stdin config (`--config -`)
  - Mapped in `src/config-file.ts`

## Procedure

### 1. Load last-processed state

Read `/tmp/gh-aw/cache-memory/config-audit-state.json`. It stores:
```json
{ "last_audit_date": "YYYY-MM-DD", "last_pr_number": 1234 }
```

- If the file exists, audit PRs merged since `last_audit_date`.
- If the file does NOT exist (first run), audit PRs merged in the **last 7 days**.

### 2. Fetch recently merged PRs

```bash
gh pr list --repo github/gh-aw-firewall --state merged --limit 20 \
  --json number,title,mergedAt,files --jq '.[] | select(.mergedAt > "CUTOFF_DATE")'
```

Filter to PRs that modify any of these paths (likely to introduce config):
- `src/config-file.ts`
- `src/types/*.ts`
- `src/awf-config-schema.json`
- `docs/awf-config-spec.md`
- `docs/awf-config.schema.json`
- `src/services/api-proxy-service.ts`
- `src/cli-options.ts` or `src/cli.ts`
- `containers/api-proxy/server.js`
- `containers/api-proxy/guards/*.js`

If no relevant PRs are found, save state and exit with `noop`.

### 3. For each relevant PR, check consistency

For each PR, examine what new configuration was introduced by reading the diff:

```bash
gh pr diff <NUMBER> --repo github/gh-aw-firewall
```

Look for patterns indicating new config:
- New properties in schema JSON (`"propertyName": { "type":`)
- New rows in spec CLI mapping table
- New fields in TypeScript interfaces
- New `AWF_*` env var assignments
- New CLI `.option(` definitions

### 4. Cross-reference all layers

For each new configuration field found, verify it exists in ALL required layers:

| Check | How to verify |
|-------|---------------|
| JSON Schema (src) | `grep "fieldName" src/awf-config-schema.json` |
| JSON Schema (docs) | Schemas must be identical: `diff src/awf-config-schema.json docs/awf-config.schema.json` |
| Spec CLI mapping | `grep "fieldName" docs/awf-config-spec.md` |
| TypeScript type | `grep "fieldName" src/types/*.ts src/config-file.ts` |
| Env var wiring | `grep "AWF_FIELD_NAME" src/services/api-proxy-service.ts` (for api-proxy config) |

### 5. Check security classification

For each new field, determine if it's security-sensitive:
- Contains "key", "secret", "token", "credential", "password" → security-sensitive
- Is an OIDC client ID or tenant ID → security-sensitive
- Is a domain, multiplier, timeout, strategy, model name → non-sensitive

Verify:
- Security-sensitive fields are passed via env vars (not in config-file.ts stdin mapping)
- Non-sensitive fields are in config-file.ts (stdin config mapping)

### 6. Fix gaps and create a PR

If gaps are found, fix them directly:

- **Missing TypeScript type field**: Add the field to the appropriate interface in
  `src/types/*.ts` and/or `src/config-file.ts`
- **Missing spec CLI mapping row**: Add the row to Section 5 of `docs/awf-config-spec.md`
- **Missing schema field**: Add the property to `src/awf-config-schema.json` AND
  `docs/awf-config.schema.json` (they must stay identical)
- **Missing env var wiring**: Add the mapping in `src/services/api-proxy-service.ts`
- **Schema drift**: Copy `src/awf-config-schema.json` to `docs/awf-config.schema.json`

After making fixes, use the `create-pull-request` safe output with:
- Title: `"fix: propagate config fields to all layers"`
- Body: A summary table of what was fixed, organized by PR that introduced the gap

Example PR body:
```markdown
## Config Consistency Fixes

Automated fixes for configuration fields not fully propagated:

### From PR #1234 — "feat: add fooBar config"

| Field | Fix Applied |
|-------|-------------|
| `apiProxy.fooBar` | Added to TypeScript interface in `src/types/api-proxy-options.ts` |

### Verification

- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Config-file-mapping tests pass
- [ ] Schema validation tests pass
```

If no gaps are found, use `noop` safe output.

### 7. Save state

Write the current date and highest PR number to
`/tmp/gh-aw/cache-memory/config-audit-state.json`:
```json
{ "last_audit_date": "YYYY-MM-DD", "last_pr_number": 4063 }
```

## Important Notes

- Internal refactors (renaming files, moving code between modules) that don't add
  new user-facing config should be ignored.
- Test-only changes (new test files, test helpers) should be ignored.
- The `docs/awf-config.schema.json` and `src/awf-config-schema.json` MUST always be
  identical. If they differ, report that as a critical gap.
- Fields that are intentionally runtime-only (no config equivalent) should be noted
  but not flagged as gaps if documented in the spec as "CLI-only".
