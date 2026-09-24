# ADR 0003: Shell-free native repository profile

## Status

Proposed for implementation planning. This ADR defines a security contract, not
an available AWF tool profile. AWF MUST NOT accept, advertise, or partially
enable this profile until every gate below is implemented. Until then, the
closed AWF configuration schema rejects profile declarations; there is no
fallback to the primary-agent execution path.

## Context

`github/gh-aw#61629` proposes an opt-in native repository profile whose first
implementation is a bounded Go repository lifecycle. The reference behavior is
captured at `github/gh-aw@44d5fb9cbacbfc192b406b7b4662b355235b41b5`.
The upstream configuration and engine-independent composition interface are not
yet settled.

AWF's primary agent currently runs an operator-supplied command through
`/bin/bash -c` and exposes the host's system binaries in the chroot. Engine tool
denials can reduce what a model is offered, but they cannot turn that execution
path into a shell-free sandbox. Trusting an engine's advertised tool catalog
would therefore not enforce the requested boundary.

The enclave `agent.profile` field is not reusable for this purpose. It selects
an API protocol (`openai` or `anthropic`), not an agent tool set.

## Decision

AWF will support a native repository profile only as an all-or-nothing,
versioned contract enforced by an AWF-owned bounded executor. The first profile
has the conceptual identifier `go-repository-v1`; that identifier is not a
configuration key or compatibility promise until the upstream interface is
agreed.

The executor exposes exactly these operations:

- `status`
- `diff`
- `prepare_branch`
- `format`
- `readiness`
- `validate`
- `commit`

An invocation selects one operation and only the bounded semantic inputs defined
for that operation. It cannot provide an executable, argv, shell fragment,
working directory, environment variable, Git configuration, hook, validation
command, network endpoint, or output limit. Unknown operations, fields, and
protocol versions fail closed.

### Tool and process closure

Selecting the profile requires all of the following:

- Bash, `write_bash`, generic task/process tools, and every other arbitrary
  execution interface are absent.
- The CLI proxy and its relay are not created, attached, or advertised. No
  `AWF_CLI_PROXY_*` value or GitHub credential enters the executor.
- The primary agent cannot reach the executor through a shell wrapper or invoke
  its implementation binary directly. It receives only the closed tool
  protocol.
- Git and Go subprocesses are selected by AWF from trusted, fixed paths and
  fixed argument templates. Git hooks, aliases, external diff/text-conversion
  commands, pagers, credential helpers, signing programs, and repository-local
  configuration cannot introduce another executable.
- Go validation is offline (`GOPROXY=off`), uses a trusted cache outside the
  checkout, and cannot select tools or flags from invocation input.
- No operation pushes, fetches, authenticates, or otherwise publishes over the
  network. `commit` creates only a local commit.

Engine-side catalog filtering remains required for a usable interface, but is
not an enforcement boundary. AWF MUST independently prevent arbitrary execution
and MUST reject the profile if the selected runtime cannot do so.

### Repository and revision binding

Before admitting the first operation, AWF resolves one canonical checkout root
from trusted workflow state. The executor has no caller-controlled working
directory and cannot follow a path outside that root.

The trusted base revision is a full 40-character hexadecimal `GITHUB_SHA`, not a
branch, tag, abbreviated object ID, merge-base guess, or value supplied by the
agent. Admission requires:

1. `HEAD` resolves exactly to that commit;
2. the index and tracked working tree are unchanged from `HEAD`;
3. no untracked or ignored repository path can enter the publication tree; and
4. the repository has no in-progress merge, rebase, cherry-pick, or bisect.

Failure is terminal for the profile session. AWF does not silently clean,
switch, or broaden the checkout to make admission succeed.

The executor canonicalizes every path before access. Symlink traversal,
submodules, alternate object directories, linked worktrees, and Git environment
variables MUST NOT escape the admitted repository or introduce unvalidated
objects. A first implementation may reject these features rather than support
them.

### Validation and commit state

`format` may change eligible repository bytes and therefore invalidates any
earlier readiness or validation result. `readiness` and `validate` operate on a
projected checkout containing exactly the bytes eligible for commit.

Validation records a digest of that projection and the fixed validation policy.
After each validator exits, AWF compares the checkout, including tracked,
untracked, and ignored paths, with its pre-validation state. Any
validation-created or modified path is a failed validation and cannot be
published.

`commit` succeeds only when:

- the current eligible projection has a successful validation record;
- its digest and validation policy exactly match the current bytes and policy;
- no operation or external mutation has invalidated that record; and
- the resulting commit contains exactly that projection.

Commit messages are bounded semantic input. Commit hooks, signing, credential
helpers, and network access remain disabled. A successful local commit does not
authorize a push.

### Results, errors, and audit

Results use a closed, versioned schema. Native failures are redacted and
actionable, with labeled and truncated stdout/stderr excerpts, mutation
summaries that do not expose file contents, and no credentials, environment,
absolute host paths, or raw Git configuration.

The complete serialized result is at most `MAX_RESULT_BYTES` (currently 8192
UTF-8 bytes), reusing the finite-disclosure bound in
`src/bounded-execution/finite-disclosure.ts`. Truncation itself is represented
in the schema. Audit records contain operation names, opaque session IDs,
revision/projection digests, bounded outcome metadata, and cleanup state; they
do not contain raw repository content.

## Required implementation gates

The profile remains unavailable until all of these gates are met:

1. **Upstream contract:** gh-aw lands a versioned, engine-independent declaration
   and deterministic import/merge behavior, including explicit unsupported
   engine handling.
2. **Closed protocol:** AWF defines and validates the exact per-operation input
   and result schemas, with no arbitrary execution fields.
3. **Bounded executor:** an AWF-owned executor enforces process, filesystem,
   revision, credential, network, resource, timeout, and output boundaries
   independently of the agent engine.
4. **Runtime integration:** profile selection removes CLI proxy and arbitrary
   process surfaces and does not use the existing `/bin/bash -c` primary-agent
   path as its enforcement boundary.
5. **Lifecycle proof:** tests cover clean-base admission, path confinement,
   fixed operations, offline validation, mutation detection, stale-validation
   rejection, exact commit projection, redaction, output bounds, and teardown.
6. **Promptless integration:** direct and gateway-backed tests exercise the
   compiled catalog and every operation with zero model/provider requests.
7. **Version negotiation:** compiler and AWF versions explicitly agree on the
   same profile and protocol version. Older or unsupported components reject the
   declaration without permissive fallback.

Adding a schema property before these gates are complete would imply a security
guarantee AWF cannot provide. The current closed schema is therefore the
intentional enforcement behavior, not a missing compatibility shim.

## Consequences

- Default workflows and existing tool permissions are unchanged.
- Downstream users still need their pinned implementation until the gates land;
  this ADR supplies the upstream AWF contract rather than pretending metadata is
  enforcement.
- The future implementation may reuse bounded-execution, finite-disclosure, and
  confinement primitives, but it must not overload enclave API profiles or
  weaken their separate trust model.
- A language other than Go requires a new versioned validation policy; it does
  not broaden `go-repository-v1`.
