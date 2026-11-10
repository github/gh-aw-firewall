---
name: Runtime and Enclave Doctor Updater
description: Maintain evidence-backed runtime and enclave diagnosis records through bounded human-reviewed documentation PRs.
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs] runtime-doctor:"'
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
    title-prefix: "[docs] runtime-doctor: "
    labels: [documentation, ai-generated]
    max: 1
    allowed-files:
      - docs/diagnostics/findings/runtime/*.json
      - docs/diagnostics/README.md
      - docs/cloud-hypervisor-foundation.md
      - docs/enclaves-architecture.md
      - docs/gvisor-integration.md
      - docs/troubleshooting.md
  create-issue:
    title-prefix: "[runtime-doctor] "
    labels: [documentation, ai-generated]
    max: 1
    expires: 30d
timeout-minutes: 30
---

# Runtime and Enclave Doctor Updater

Maintain `RT-*` records in `docs/diagnostics/findings/runtime/`. Follow the
shared intake, evidence, freshness, deduplication and receipt contract before
proposing changes. Runtime scope includes Docker/chroot, gVisor/Kata, Cloud
Hypervisor, startup checklists, bounded storage, mount propagation, enclave
admission, readiness and cleanup. Cross-link runner topology, network and auth
causes instead of duplicating them.

Read `docs/compatibility.md`, `docs/diagnostics/README.md`,
`docs/cloud-hypervisor-foundation.md` and `docs/enclaves-architecture.md`.
Verify relevant changes against `src/cloud-hypervisor/`, `src/enclave/`,
`src/container-runtime.ts`, `containers/agent/`, `containers/enclave/` and their
tests on the default branch. Supplement merged intake with issues about
startup, runsc, Kata, chroot, ENOSPC, mount propagation, session logs, admission
and cleanup. Read old unresolved investigation sections as historical evidence,
not proof that current code is still broken.

Review every candidate in `reviewQueue.firstTime` before the rotated deferred
queue. The intake file contains metadata only: for each reviewed PR, fetch and
read its body and changed-file list, then inspect relevant implementation and
test changes on the default branch. Do not classify a PR from its title alone;
each receipt must cite the source and tests that support its disposition. If
evidence is unavailable, leave the candidate pending as `needs-evidence`.

Distinguish host preparation from guest execution; AWF host readiness from
harness readiness; primary failure from cleanup failure; missing observations
from success. A merged fix proves source behavior, not a released version or
live KVM acceptance. Never dispatch a workflow, start a container/VM, change
mounts, run inference, expose private artifacts, or relax isolation to verify a
claim. Use code/tests and existing bounded, protected diagnostics only.

For verified corrections, open at most one narrow documentation PR, only in
the configured allowed files. Validate records and regenerate the README index;
leave generated prompt/agent files to a trusted reviewer. Never author workflow,
agent, skill, schema or runtime code. If evidence is insufficient, instead
create one deduplicated issue with the exact missing safe probe, affected
finding IDs and source links; do not assert a root cause.

Use GFM with report headings starting at `###`. Include coverage/cursors and
backlog, each finding's status/version/probe/action, current-main code and test
citations, historical versus current behavior, review evidence and validation.
Credit the humans who reviewed/merged the source changes, not bots as
independent actors. Never auto-merge. If review is complete with no change,
call `noop`; for unfinished coverage use `report-incomplete`.
