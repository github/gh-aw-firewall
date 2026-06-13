---
description: |
  Workflow triggered weekly (Monday 09:00 UTC) that audits the TypeScript and JavaScript
  surface of the codebase: unused exports, inconsistent naming conventions, circular
  dependencies, and test files importing from incorrect modules. Files actionable issues
  to keep the API surface clean and prevent dead-code accumulation.

on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 09:00 UTC
  workflow_dispatch:

permissions:
  contents: read
  issues: read

max-turns: 6
engine:
  id: copilot
  model: claude-sonnet-4-5
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github

tools:
  github:
    toolsets: [issues]
  bash: true

safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "[Export Audit] "
    labels: [code-quality]
    max: 5
    expires: 30d

timeout-minutes: 20

steps:
  - name: Install dependencies
    run: set -o pipefail && npm ci 2>&1 | tail -5

  - name: Build TypeScript
    id: build
    run: set -o pipefail && npm run build 2>&1 | tail -10

  - name: Run export audit analysis
    run: |
      set -o pipefail
      mkdir -p /tmp/gh-aw/agent
      npm install -g ts-prune@0.10.3 madge@8.0.0 2>&1 | tail -3
      bash scripts/ci/export-audit-analysis.sh > /tmp/gh-aw/agent/export-audit-context.md
      echo "Context: $(wc -c < /tmp/gh-aw/agent/export-audit-context.md) bytes"
---

# API Surface & Export Audit

Audit `${{ github.repository }}` for dead exports, naming inconsistencies, circular deps, and bad test imports.

Read `/tmp/gh-aw/agent/export-audit-context.md` (pre-computed findings from ts-prune, madge, grep).

**HARD LIMIT: You have at most 6 turns total.** Turn 1: read context + plan. Turns 2–5: verify and file. Turn 6: emit noop or final issue and stop.

**File issues for:**
- `VERIFIED_UNUSED` entries with `used_outside_defining_file=0_files` — use `VERIFIED_UNUSED` directly as pre-confirmed evidence; do not re-verify unless the section is empty
- Naming violations (non-PascalCase type/interface exports)
- Circular deps detected by madge
- Test files importing from `../../` or `dist/`

If `VERIFIED_UNUSED` is empty, fall back to the normal verification flow within the strict command budget.

**Verification budget (max 3 bash commands total):** Verify at most **3 candidates total** (not 5). Run **exactly 1 bash command** per candidate — `grep -rw <symbol> src/ --include="*.ts" | grep -vE "test|index"`. If not confirmed, skip immediately. **Total bash commands for verification: maximum 3** across all phases.

**Duplicate check:** Search `repo:${{ github.repository }} is:issue "[Export Audit] <symbol>" state:all`. Skip if open. Re-file if closed with `completed` reason and still reproducible.

**Issue format:** Title `[Export Audit] <description>`. Body: File, Symbol, Evidence grep, Dead code risk. Max 5 issues. Score ≥ 3: unused public API = 3, circular dep = 4, naming = 2, bad test import = 2, security-critical module = +2.

If the "TypeScript build output" section contains compiler errors, report them and exit without filing.

Read `/tmp/gh-aw/agent/export-audit-context.md` first. It contains the pre-computed sections for exported symbols, unused exports, verified unused exports, circular dependencies, naming issues, test imports, and api-proxy exports.