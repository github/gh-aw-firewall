---
name: Network Doctor Updater
description: Reconcile Squid, DNS, proxy and topology diagnosis guidance with merged fixes and current policy.
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs] network-doctor:"'
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
    title-prefix: "[docs] network-doctor: "
    labels: [documentation, ai-generated]
    max: 1
    allowed-files:
      - docs/diagnostics/findings/network/*.json
      - docs/diagnostics/README.md
      - docs/egress-filtering.md
      - docs/troubleshooting.md
      - docs/logging_quickref.md
  create-issue:
    title-prefix: "[network-doctor] "
    labels: [documentation, ai-generated]
    max: 1
    expires: 30d
timeout-minutes: 30
---

# Network Doctor Updater

Maintain `NET-*` records in `docs/diagnostics/findings/network/` using the shared
intake, evidence, freshness, deduplication and receipt contract. Cover Squid
domain/port ACLs, trusted DNS, HTTP/HTTPS proxy behavior, upstream proxies,
network subnets, sidecar connectivity and topology-specific failures.

Read `docs/egress-filtering.md`, `docs/troubleshooting.md` and existing network
findings. Confirm claims in `src/squid/`, `src/squid-config.ts`,
`src/host-iptables.ts`, `src/services/`, `containers/squid/`,
`containers/agent/setup-iptables.sh` and their tests. Supplement complete merged
intake with issues about TCP_DENIED, SERVFAIL, CONNECT, DNS, cache_peer, custom
ports, subnet overlap and sidecar resolution.

An expected policy denial is not a regression. A TLS failure from a client that
ignores HTTPS_PROXY is not proof of a blocked domain or broken certificate.
Resolver failures do not all establish DNS filtering; separate trust-list
rejection from resolver outage, negative caching and daemon topology.
Differentiate agent and trusted sidecar policy and cross-link runner causes.
Never recommend wildcards, opening dangerous ports, switching off DNS/egress
filtering or bypassing the proxy. Suspected successful unauthorized egress
belongs to restricted human/security review, not an ordinary public issue.
Do not send test traffic, start containers, dump environments or publish URLs
with credentials/query contents. Use only safe, read-only projections.

Verified changes produce at most one allowed-files documentation PR; uncertain
non-security changes instead produce one deduplicated evidence-request issue.
Validate canonical records, regenerate the README index, and leave generated
prompt/agent consumers to trusted review. Do not modify code, workflows, skills,
agents or schemas. Keep stable IDs and unknown version ranges.

Use GFM headings starting at `###`; report coverage/cursors/backlog, finding
IDs, expected policy versus defect, status/version/probe/action, current-main
code/tests and source URLs, review evidence and validation. Attribute reviewed
changes to the humans using automation. No auto-merge. Call `noop` only after a
complete bounded review with no corrections; otherwise use `report-incomplete`.
