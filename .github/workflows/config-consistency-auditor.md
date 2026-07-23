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
  copilot-requests: write
  contents: read
  pull-requests: read
  issues: read
engine: copilot
strict: true
timeout-minutes: 20
if: needs.fetch_prs.outputs.pr_count != '0'
jobs:
  fetch_prs:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      pr_count: ${{ steps.filter.outputs.pr_count }}
    steps:
      - name: Filter config-touching merged PRs
        id: filter
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          CUTOFF=$(date -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
          gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 50 \
            --json number,title,mergedAt,files > /tmp/all-prs.json
          PR_COUNT=$(jq --arg cutoff "$CUTOFF" '
            [.[] | select(.mergedAt >= $cutoff) | select(
              (.files // []) | map(.path) |
              any(test("src/config-file\\.ts|src/types/|src/awf-config-schema\\.json|docs/awf-config-spec\\.md|docs/awf-config\\.schema\\.json|src/services/api-proxy-service\\.ts|src/cli"))
            )] | length
          ' /tmp/all-prs.json)
          echo "Found $PR_COUNT relevant merged PRs"
          echo "pr_count=$PR_COUNT" >> "$GITHUB_OUTPUT"
network:
  allowed:
    - defaults
    - github
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests]
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
steps:
  - name: Fetch relevant merged PRs
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw
      CUTOFF=$(date -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
      gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 50 \
        --json number,title,mergedAt,files > /tmp/gh-aw/all-prs.json
      jq --arg cutoff "$CUTOFF" '
        [.[] | select(.mergedAt >= $cutoff) | select(
          (.files // []) | map(.path) |
          any(test("src/config-file\\.ts|src/types/|src/awf-config-schema\\.json|docs/awf-config-spec\\.md|docs/awf-config\\.schema\\.json|src/services/api-proxy-service\\.ts|src/cli"))
        )]
      ' /tmp/gh-aw/all-prs.json > /tmp/gh-aw/relevant-prs.json
      echo "Prepared $(jq length /tmp/gh-aw/relevant-prs.json) relevant PRs for audit"
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

Fields containing "key", "secret", "token", "credential", "password", or OIDC identifiers are
**security-sensitive** → env vars only (not in `src/config-file.ts`). All other fields
(domains, multipliers, timeouts, model names) are **non-sensitive** → stdin config via `src/config-file.ts`.

## Procedure

### 1. Load last-processed state

Read `/tmp/gh-aw/cache-memory/config-audit-state.json`. It stores:
```json
{ "last_audit_date": "YYYY-MM-DD", "last_pr_number": 1234 }
```

- If the file exists, note the `last_audit_date` for filtering the pre-fetched PR list.
- If the file does NOT exist (first run), treat PRs from the last 7 days as in scope.

### 2. Read pre-fetched relevant PRs

A pre-agent step already fetched and filtered config-touching merged PRs to
`/tmp/gh-aw/relevant-prs.json`. Read this file:

```bash
cat /tmp/gh-aw/relevant-prs.json
```

If the `last_audit_date` from cache-memory is more recent than 7 days ago, additionally
filter the list to PRs merged after that date. If no PRs remain after filtering, save
state and exit with `noop`.

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

For each new field, apply the security classification rules from the
[Security Classification](#security-classification) section above. Verify that
security-sensitive fields are NOT in `src/config-file.ts` and non-sensitive fields ARE.

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
- Body: A summary table of what was fixed, organized by PR that introduced the gap,
  with a verification checklist (`tsc --noEmit`, config-file-mapping tests, schema validation tests)

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
