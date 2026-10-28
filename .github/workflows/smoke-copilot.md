---
description: Smoke Copilot
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Copilot
engine:
  id: copilot
  version: 1.0.101
  checksums-sha256: 018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be
network:
  allowed:
    - defaults
    - github
tools:
  bash: [cat]
  github:
    toolsets: [pull_requests]
    allowed: [list_pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-copilot]
  messages:
    footer: "> 📰 *BREAKING: Report filed by [{workflow_name}]({run_url})*"
    run-started: "📰 BREAKING: [{workflow_name}]({run_url}) is now investigating this {event_type}. Sources say the story is developing..."
    run-success: "📰 VERDICT: [{workflow_name}]({run_url}) has concluded. All systems operational. This is a developing story. 🎤"
    run-failure: "📰 DEVELOPING STORY: [{workflow_name}]({run_url}) reports {status}. Our correspondents are investigating the incident..."
timeout-minutes: 15
strict: false
jobs:
  verify_token_usage:
    needs: agent
    if: needs.agent.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Build local AWF smoke images
    timeout-minutes: 35
    run: bash "${RUNNER_TEMP}/awf-smoke/build-smoke-images.sh"
  - name: Pre-compute smoke test data
    run: |
      echo "::group::Fetching last 2 merged PRs"
      PR_DATA=$(gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt \
        --jq '.[] | "PR #\(.number): \(.title) (by @\(.author.login), merged \(.mergedAt))"')
      echo "$PR_DATA"
      echo "::endgroup::"

      echo "::group::GitHub.com connectivity check"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com)
      echo "github.com returned HTTP $HTTP_CODE"
      echo "::endgroup::"

      echo "::group::File write/read test"
      TEST_DIR="/tmp/gh-aw/agent"
      TEST_FILE="$TEST_DIR/smoke-test-copilot-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "Smoke test passed for Copilot at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      PR_AUTHOR=""
      PR_ASSIGNEES=""
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        PR_AUTHOR=$(jq -r '.pull_request.user.login // ""' "$GITHUB_EVENT_PATH")
        PR_ASSIGNEES=$(jq -r '[.pull_request.assignees[]?.login] | join(", ")' "$GITHUB_EVENT_PATH")
      fi

      {
        printf 'Repository: %s\n' "$GITHUB_REPOSITORY"
        printf 'Trigger: %s\n' "$GITHUB_EVENT_NAME"
        printf 'github.com HTTP status: %s\n' "$HTTP_CODE"
        printf 'File write/read content: %s\n' "$FILE_CONTENT"
        printf 'Current pull request author: %s\n' "$PR_AUTHOR"
        printf 'Current pull request assignees: %s\n' "$PR_ASSIGNEES"
        printf 'Pre-fetched merged PRs:\n%s\n' "$PR_DATA"
      } > "$TEST_DIR/smoke-test-data.txt"
    env:
      GH_TOKEN: ${{ github.token }}
post-steps:
  - name: Validate safe outputs were invoked
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        echo "Checked path: $OUTPUTS_FILE"
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          echo "::error::Agent did not call add_comment on a pull_request trigger."
          exit 1
        fi
        echo "add_comment verified for PR trigger"
      fi
      echo "Safe output validation passed"
---

# Smoke Test: Copilot Engine Validation

The host preparation step builds the checked-out Squid, agent, and API proxy
images with a separate 35-minute budget. Repository post-processing selects
those run-specific local images with `--skip-pull`, leaving the 15-minute agent
execution budget for startup and the smoke checks rather than cold builds.

**CRITICAL: On pull_request triggers, call `add_comment` first. Keep all outputs extremely short, using single lines where possible.**

## Tests

### 1. GitHub MCP
Make exactly one GitHub MCP call: `github-list_pull_requests` for the repository listed in the pre-computed data, with `perPage: 1` and `fields: [number, title]`. Do not call `pull_request_read` or any other GitHub MCP tool. A successful response confirms MCP connectivity.

### 2. GitHub.com Connectivity
Use the pre-computed HTTP status; ✅ for 200 or 301, ❌ otherwise.

### 3. File Write/Read
Use the pre-step's write/read result.

## Output (MANDATORY)

If the pre-computed trigger is `pull_request`, call `add_comment` to post a very brief comment (max 5–10 lines) on the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL
- Mention the current pull request author and any assignees listed in the pre-computed data

If all tests pass on a `pull_request` trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-copilot` to the pull request

For a `workflow_dispatch` or `schedule` trigger, call `noop` with a concise PASS/FAIL summary instead. Do not attempt pull request comments or labels when there is no pull request.

## Pre-computed data

Read `/tmp/gh-aw/agent/smoke-test-data.txt` once with `cat` and use its results.