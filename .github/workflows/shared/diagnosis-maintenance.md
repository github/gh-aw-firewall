# Shared Diagnosis Maintenance Contract

This component defines the contract every AWF diagnosis-maintenance workflow
follows. Domain-specific source queries and official-documentation allowlists
stay in the runner/auth adapters that import this file; the deterministic
validation and rendering live in `scripts/diagnostics/`, never in prompt text.

The canonical diagnosis state is the registry in `docs/diagnostics/`:

- `docs/diagnostics/findings/<boundary>/<ID>.json` — canonical records
- `docs/diagnostics/schema.json` — the validated record schema
- `docs/diagnostics/patterns.md` — the full observe → classify → verify →
  propose → review → publish protocol (read it before proposing anything)

Generated consumers (`.github/workflows/shared/diagnosis-findings.md`,
`.github/agents/diagnose-awf.md`, and the registry index) are produced by
`npm run diagnostics:render`. Workflow updaters must not directly author
generated prompt or agent surfaces; refresh those in trusted CI or reviewer
context. Never hand-edit them, and never hand-edit a `.lock.yml`.

## Scan window

Read the scan date from `/tmp/gh-aw/agent/scan-since.txt`
(`cat /tmp/gh-aw/agent/scan-since.txt`). The window deliberately overlaps the
previous run, so overlapping scans must not produce duplicate findings.

## Candidate extraction

An issue, run, pull request, or provider-documentation change is a
**candidate**, not a diagnosis. For each candidate capture:

- the observable symptom or redacted error class
- the discriminating conditions (topology, provider, auth mode, version)
- the suspected root cause, distinguished from the symptom
- a **read-only, secret-safe** probe
- provenance: the issue/merged PR plus the implementation or test that proves
  current behaviour on the default branch

Strip secrets. Never copy credentials, JWTs, `Authorization` headers, or
environment dumps into a proposal, and never propose a probe that dumps the
environment, exchanges a token, or bypasses isolation.

## Verification

Before asserting a cause or a fix:

- confirm the implementation and tests on the default branch
- use `unknown` for version scope you have not verified; an open PR or provider
  documentation alone is **not** a shipped fix
- check auth claims against `docs/auth-matrix.md` and platform claims against
  `docs/compatibility.md` rather than duplicating those matrices

## Matching and deduplication

Search the registry before proposing:

```bash
npx tsx scripts/diagnostics/cli.ts search "<redacted symptom>" --boundary <boundary>
```

Then classify each candidate as:

- **already covered** — the finding ID already cites this source ⇒ skip
- **update to an existing finding** — add a citation, correct the version
  scope, improve the probe or action, or change status
- **new finding** — allocate the next free stable ID in the correct namespace
  (`A*`/`B*`/`C*`/`D*` for `runner`; `RT-`, `NET-`, `AUTH-`, `CI-`, `SEC-`
  otherwise). Never recycle or renumber an ID; supersede in place with
  `status: superseded` and `supersededBy`.

Deduplicate by **finding ID plus source citation**, and also against open
proposals from previous runs.

## Proposal format

Choose the single path that matches your confidence:

- **Verified** change ⇒ a bounded pull request containing the exact canonical
  record edits plus any allowed support docs. Generated prompt and agent
  consumers are refreshed separately by trusted CI or a reviewer.
- **Uncertain** finding needing investigation ⇒ a structured issue naming the
  candidate, the missing evidence, and the smallest probe that would resolve
  it. Mark such records `needs-evidence` rather than asserting a cause.

Every proposal must state, per change: finding ID, boundary, status, version
scope, probe, action, and provenance links.

## Validation before proposing

Any proposal that changes canonical records must be validated locally. If
rendering changes files outside the workflow's `allowed-files` set, leave those
generated artifacts to trusted CI or a reviewer rather than including them in
the updater-authored pull request:

```bash
npm run diagnostics:validate   # schema, IDs, provenance, safe probes
npm run diagnostics:render     # regenerate every consumer
npm run diagnostics:check      # fail if a generated artifact is stale
```

## Noop behaviour

If the scan window produced no new, verified, not-yet-captured candidate, call
`noop` with a one-line explanation. Never open an empty or speculative
proposal, and never let unreviewed text silently change runtime diagnosis
knowledge — a human-reviewed PR is the only way canonical state changes.
