# Diagnosis Update and Consumption Protocol

Every producer of AWF diagnosis knowledge — humans, the Runner Doctor Updater,
the Auth Doctor Updater, CI Doctor, and any future domain updater — follows the
same protocol. Deterministic validation and rendering live in
`scripts/diagnostics/`, not in copied prompt text.

## Observe

- An issue, workflow run, merged PR, or provider documentation change is a
  **candidate**, not a diagnosis.
- Strip secrets. Record links plus the minimal redacted evidence (error class,
  configuration shape, topology). Never copy credentials, JWTs, `Authorization`
  headers, or environment dumps into a candidate.

## Classify

- Match an existing finding ID, or allocate a new stable ID in the correct
  namespace: `A*`/`B*`/`C*`/`D*` for `runner` (historical catalog IDs are
  retained), `RT-`, `NET-`, `AUTH-`, `CI-`, `SEC-` for the other boundaries.
- Distinguish root cause from symptom. Mark work that is genuinely unresolved
  as `unresolved` or `needs-evidence` rather than asserting a cause.
- Cross-link with `related` instead of duplicating a cause across boundaries.

## Verify

- Confirm the implementation and tests on the default branch, and the real fix
  status. An open PR or provider documentation alone is **not** a shipped fix;
  use `unknown` for unverified version ranges.
- Confirm the version scope, a safe discriminating probe, and primary citations.
- Check auth claims against `docs/auth-matrix.md` and provider guidance without
  treating guidance alone as shipped support.

## Propose

- Use a bounded pull request containing the exact canonical record changes plus
  any necessary support-doc changes, or a structured issue when the finding is
  uncertain and still needs investigation.
- Deduplicate by finding ID **plus** source citation, so overlapping scan
  windows never create duplicate findings. If a run has nothing new to propose,
  it must no-op rather than open an empty proposal.

## Review and publish

- A human-reviewed PR changes the canonical record. CI runs
  `npm run diagnostics:validate` and `npm run diagnostics:check` to validate
  schema, IDs, provenance, reference shape, safety constraints, generated
  parity, and representative routing fixtures before publishing.
- Never let an issue, cache-memory, or an updater's unreviewed text silently
  alter runtime diagnosis knowledge.

## Maintain

- Each record carries an `owner` and a `reviewBy` date. Boundary owners review
  their records on that cadence.
- Supersede a record **in place**: set `status: superseded` and `supersededBy`,
  and keep the ID. IDs are never recycled.
- To retract a wrong finding: correct or supersede the record, run
  `npm run diagnostics:render` to regenerate every consumer, and land both in
  the same reviewed PR. Recompile any affected gh-aw workflow with
  `gh aw compile`; never hand-edit a `.lock.yml`.

## Consume

- Agents resolve a finding through the registry index or
  `scripts/diagnostics/cli.ts search`, then report: observed symptom, matched
  finding ID and evidence, affected version/topology, safe next probe,
  fix/workaround, and citations.
- When nothing matches, report that plainly and name the smallest missing
  evidence. Never invent a fix.
- CI Doctor remains an incident investigator: it may cite existing finding IDs
  or propose candidates, but it is never an unreviewed writer of canonical
  state.
