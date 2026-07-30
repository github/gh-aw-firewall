---
name: Smoke Bounded Queries
description: Smoke test for declarative bounded queries in agentic workflow frontmatter
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
tools:
  github:
    toolsets: [repos]
    bounded-queries:
      private-repos:
        - repo: github/gh-aw
          sensitivity: internal
      runtime: docker
      memory-limit: 2g
      interpreter: python3
sandbox:
  agent:
    id: awf
    version: v0.28.0
safe-outputs:
  threat-detection:
    enabled: false
timeout-minutes: 15
strict: false
---

# Smoke Test: Bounded Queries

Use the generated `bounded-query` skill to answer exactly one finite question about
`github/gh-aw`: does the repository root contain a `go.mod` file?

The query must:

1. Use a boolean JSON schema.
2. Run a Python script inside the bounded-query environment that checks
   `/query/repo/go.mod`.
3. Return `true`.

Do not use GitHub tools, network requests, or the current checkout to answer the
question. The test passes only when the bounded query succeeds and returns `true`.

Call `noop` with a concise PASS result that includes the returned boolean. If the
skill is unavailable, the query fails, or the result is not `true`, call `noop`
with a concise FAIL result and clearly identify the failure.
