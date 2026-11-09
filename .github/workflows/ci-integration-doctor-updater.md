---
name: CI and Integration Doctor Updater
description: Maintain AWF, gh-aw and mcpg integration diagnosis records without changing incident CI Doctor or dispatching CI.
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs] ci-doctor:"'
    max: 1
permissions:
  copilot-requests: write
  contents: read
  issues: read
  pull-requests: read
imports:
  - shared/diagnosis-maintenance.md
engine:
  id: copilot
  version: "1.0.98"
tools:
  github:
    toolsets: [default]
  bash: true
  edit:
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github
safe-outputs:
  create-pull-request:
    title-prefix: "[docs] ci-doctor: "
    labels: [documentation, ai-generated]
    max: 1
    allowed-files:
      - docs/diagnostics/findings/ci/*.json
      - docs/diagnostics/README.md
      - docs/github_actions.md
      - docs/INTEGRATION-TESTS.md
      - docs/diagnosing-awf-failures.md
  create-issue:
    title-prefix: "[ci-doctor] "
    labels: [documentation, ai-generated]
    max: 1
    expires: 30d
timeout-minutes: 30
---

# CI and Integration Doctor Updater

Maintain `CI-*` records in `docs/diagnostics/findings/ci/`. Follow the shared
merged intake, receipts, freshness, evidence and deduplication contract.
Complement the incident `ci-doctor.md`: that workflow investigates incidents
and remains a read-only canonical-registry consumer, not a publisher.

Read `docs/github_actions.md`, `docs/INTEGRATION-TESTS.md`,
`docs/enclaves-architecture.md`, existing CI records and relevant workflow
source/lock metadata. Inspect `scripts/ci/` collectors/harnesses, `src/enclave/`
handoff and readiness validation, and their tests. Supplement complete intake
with AWF/gh-aw/mcpg compatibility, compiler handoff contracts, safe-output
validation, artifact retention, version pins and integration failures. Read
upstream merged PRs/releases when relevant, but never infer AWF support from an
open upstream PR or a newer compiler's docs alone.

Separate source fixes from immutable released assets; record exact compiler,
AWF and gateway versions only when proven. Separate ordinary-workflow identity
admission from provider auth and guest execution. Collector absence is not
launch success; preserve startup evidence independently from invocation journals
and collection status, and keep audit/cleanup failures separate from the primary
failure. Cross-link runtime, auth and runner findings rather than copying causes.
Safe-output rejection needs a contract correction, not broader permissions.

Use existing read-only run metadata and tests. Never dispatch/rerun workflows,
mutate workflow/source/lock files, fetch raw secret-bearing logs, exchange tokens
or run inference. Restrict changes to approved docs and canonical CI records.
Validate records and regenerate the README index; trusted reviewers regenerate
prompt/agent consumers. Verified changes go in at most one bounded PR requiring
human review; uncertain changes instead go in one deduplicated evidence issue.

Use GFM headings starting at `###`. Report coverage/cursors/backlog, each
finding's status/version/probe/action, current-main implementation/tests,
provenance URLs, review evidence, validation and real acceptance gaps. Credit
human reviewers/mergers using automation. Never auto-merge. Complete reviews
with no correction call `noop`; unfinished coverage uses `report-incomplete`.
