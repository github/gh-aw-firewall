---
description: Detects and comments on potentially duplicate issues using cache memory for persistent storage
on:
  issues:
    types: [opened]
  workflow_dispatch:
    inputs:
      issue_number:
        description: Issue number to analyze
        required: true
        type: number
permissions:
  copilot-requests: write
  contents: read
  issues: read
imports:
  - shared/mcp-pagination.md
sandbox:
  agent:
    id: awf
tools:
  github:
    toolsets: [issues, search]
  cache-memory:
    key: issue-duplication-detector
  bash:
    - cat
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    max: 1
timeout-minutes: 10
steps:
  - name: Fetch issue and cached signatures
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ISSUE_NUMBER: ${{ github.event.issue.number || inputs.issue_number }}
      REPOSITORY: ${{ github.repository }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh issue view "$ISSUE_NUMBER" --repo "$REPOSITORY" \
        --json number,title,body,labels,createdAt \
        > /tmp/gh-aw/agent/new-issue.json

      cache=/tmp/gh-aw/cache-memory/issues.json
      if [ -s "$cache" ]; then
        cp "$cache" /tmp/gh-aw/agent/cached-issues.json
      else
        printf '[]\n' > /tmp/gh-aw/agent/cached-issues.json
      fi
post-steps:
  - name: Update cached issue signatures
    if: always()
    run: |
      set -euo pipefail
      cache=/tmp/gh-aw/cache-memory/issues.json
      issue=/tmp/gh-aw/agent/new-issue.json
      [ -s "$issue" ] || exit 0

      mkdir -p "$(dirname "$cache")"
      [ -s "$cache" ] || printf '[]\n' > "$cache"
      jq -s '
        (.[0] | if type == "array" then .
          elif (.issues | type) == "array" then .issues
          else [] end) as $cached
        | .[1] as $issue
        | ($cached | map(select(
            ((.number // .issue_number) | tostring) != ($issue.number | tostring)
          )))
          + [$issue | {
            number,
            title,
            key_phrases: (
              [((.title // "") + " " + (.body // ""))
                | ascii_downcase
                | scan("[a-z0-9][a-z0-9_-]{3,}")
                | select(. as $word
                  | ["about", "after", "also", "been", "could", "from", "have",
                     "into", "issue", "just", "more", "other", "should", "some",
                     "than", "that", "their", "there", "these", "they", "this",
                     "those", "through", "using", "very", "what", "when", "where",
                     "which", "while", "will", "with", "would"]
                  | index($word) == null)]
              | unique | .[0:30]
            ),
            created_at: .createdAt
          }]
        | .[-100:]
      ' "$cache" "$issue" > "$cache.tmp"
      mv "$cache.tmp" "$cache"
---

# Issue Duplication Detector

You are an AI agent that detects potentially duplicate issues in this repository. You leverage cached memory to store issue signatures and efficiently identify duplicates across workflow runs.

## Your Task

When a new issue is opened, determine whether it might duplicate an existing issue.

1. **Read the prepared data** with bash:
   - `/tmp/gh-aw/agent/new-issue.json` contains the new issue's number, title, body, labels, and creation time.
   - `/tmp/gh-aw/agent/cached-issues.json` contains up to 100 previously cached issue signatures, or `[]` on a cold start.

2. **Compare with cached issues**:
   - Compare the new issue's title and body against cached issue data
   - Look for similar titles (considering typos, rephrasing, synonyms)
   - Look for similar problem descriptions in the body
   - Consider keyword overlap and semantic similarity

3. **Search for potential duplicates**: Always use GitHub search to find up to 10 open issues with similar key terms in `${{ github.repository }}`. Consider recently closed issues when relevant. Do not list all open issues.

## Duplicate Detection Criteria

Consider an issue a potential duplicate if ANY of these conditions are met:

- **Title similarity**: Titles share 70%+ of significant words (excluding common words like "the", "a", "is"). Calculate by: (shared significant words / total unique significant words) × 100
- **Key phrase match**: Both issues mention the same specific error messages, component names, or technical terms
- **Problem description overlap**: The core problem being described is essentially the same, even if worded differently

## Output Behavior

**If duplicates are found**: Add a helpful comment to the new issue:
- List the potential duplicate issues with links
- Briefly explain why they appear similar
- Be polite and acknowledge this is automated detection
- Suggest the author review the linked issues

**If no duplicates found**: Do not add a comment. Use the noop safe-output.

## Guidelines

- Be conservative: Only flag issues that are clearly similar
- Provide value: Don't spam with low-confidence matches
- Be helpful: Always explain why issues appear related
- Explain that detection is automated and suggest reviewing linked issues
- Respect the cached signatures and specify a result limit for every search