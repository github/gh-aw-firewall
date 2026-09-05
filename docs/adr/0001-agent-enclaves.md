# ADR 0001: Agent enclave repository admission

## Status

Proposed for implementation planning. Dynamic repository admission is not
implemented by this AWF release.

## Context

Unified enclaves expose private repository work to bounded script and agent
executors through the single AWF-owned `awf-enclave` MCP backend. The original
mode uses compiler-enumerated `repos` entries as immutable seed material. Some
workflows need to choose a repository at invocation time, but caller-controlled
repository names must not change any security-sensitive bound.

## Decision

This ADR defines two repository admission modes behind the same MCP backend:

- **Static seed-backed mode**: the compiler enumerates `repos` in workflow
  frontmatter. AWF stages immutable repository seeds and each invocation selects
  exactly one repository from that trusted catalog.
- **Dynamic GitHub-MCP-backed mode**: the compiler supplies a policy envelope
  instead of a seed catalog. Each invocation supplies only a canonical
  `owner/repo` selector, a bounded agent prompt, and a finite response schema.
  AWF asks the compiler-owned GitHub MCP path to admit one matching repository
  for that invocation.

Only static seed-backed mode exists today. The current configuration schema and
preflight require every enclave entry to declare a non-empty `repos` list; they
do not accept a dynamic policy. All dynamic-mode requirements below are
implementation requirements, not an operator interface or a compatibility
promise. A compiler MUST NOT emit dynamic policy until every version gate in
this ADR is met.

The modes are compatible at the subsystem level but mutually exclusive for a
single enclave entry: an entry either declares static `repos` or a dynamic
repository policy, never both. Static mode can use `enclave_run_script` and
`enclave_run_agent`; dynamic mode is limited to `enclave_run_agent` because
script enclaves are no-network and dynamic mode has no immutable seed to mount.
One dynamic enclave invocation exposes one repository. Existing static
GitHub-enabled agent enclaves retain their documented job-lifetime mcpg
identity, which covers the union of configured repositories and therefore does
not provide the same one-repository GitHub-MCP guarantee. Cross-repository
aggregation happens only when the primary agent makes multiple bounded enclave
calls and combines their finite results.

## Compiler-to-AWF policy envelope

In dynamic mode the compiler owns every trusted bound and passes AWF a closed
policy envelope. The invocation's repository selector may only choose within
that envelope. It cannot alter:

- repository sensitivity class;
- permitted tools or MCP servers;
- GitHub, model, or API credentials;
- model, runtime, image, profile, or network topology;
- CPU, memory, filesystem, process, timeout, or response-size limits;
- maximum admitted repository count, invocation count, or concurrency; or
- envelope expiry time.

The envelope includes at least:

- allowed owners or exact owner/repository patterns;
- sensitivity classification and disclosure bucket;
- permitted executor type, which is `agent` only for dynamic mode;
- a versioned GitHub tool policy, currently `github-repository-read-v1`;
- maximum admitted repositories for the workflow run;
- per-invocation CPU, memory, process, filesystem, network, timeout, prompt,
  and response-schema limits;
- total invocation, byte, and time quotas;
- an absolute expiry not later than the workflow job lifetime; and
- audit labels that let AWF reconcile all dynamic state during shutdown.

`github-repository-read-v1` is a closed allowlist of repository-scopable
read-only GitHub tools. Its initial members are `list_issues` and `issue_read`,
with arguments confined to the admitted repository and optional immutable ref or
integrity filters. Write operations, mutation-capable tools, unscoped search,
organization/global search, repository discovery, and tools whose arguments
cannot be mechanically confined to the admitted repository fail closed until a
new versioned policy proves repository confinement.

AWF rejects any envelope field it does not understand and fails closed when the
compiler, mcpg, runtime registry, or executor cannot enforce a requested bound.
Admission, identity delegation, live-read setup, executor startup, revocation,
and cleanup failures do not fall back to static mode, a job-lifetime identity,
or a broader policy.

## Runtime identity delegation and credential flow

The primary agent never receives GitHub credentials, repository seeds, dynamic
policy contents beyond the public tool schema, mcpg identity material, or a
direct transport to the enclave backend. The compiler is not a runtime service:
it bootstraps mcpg with a dynamic-delegation controller and gives AWF an
AWF-only delegation-control capability during startup. The capability is owned
by AWF for the workflow run, is not mounted into any primary or enclave agent,
and authorizes only create/confirm/revoke operations for identities inside the
compiler-supplied policy envelope.

AWF calls that controller over the private mcpg control channel attached to the
`awf-enclave-mcp-control` network. Requests are authenticated with the
delegation-control capability and include the run id, enclave entry id,
invocation id, canonical repository selector, requested
`github-repository-read-v1` tool set, admitted default-branch SHA when known,
finite schema hash, expiry, and idempotency key. mcpg atomically creates or
confirms exactly one delegated identity for that key and returns only an opaque
identity handle plus the executor-facing bearer value. Confirming an existing
key must return the same repository binding, tool policy, expiry, and identity
handle; any mismatch is terminal and revokes the partial identity if one was
created.

Each delegated identity is bound to:

- one workflow run and one AWF enclave backend;
- one canonical repository selector after policy admission;
- the versioned repository-scopable read-only GitHub tool policy only;
- the policy-approved sensitivity and finite response schema; and
- a short expiry that is no longer than the invocation timeout.

AWF stores the delegated identity in invocation-private state, mounts it
read-only into the single-use executor, and removes it before admitting another
repository. mcpg must reject replayed, expired, revoked, wrong-repository, and
wrong-tool identities. AWF requests revocation at normal completion, timeout,
executor failure, and shutdown; revocation is idempotent and failures are
recorded in audit without exposing the identity. On mcpg restart, the
controller reconstructs live delegations from its labelled state and refuses to
confirm an idempotency key unless the reconstructed binding matches AWF's
request. If reconstruction is incomplete, AWF treats outstanding identities as
unknown, records the condition, revokes by label where possible, and fails
closed for new dynamic admissions until reconciliation succeeds.

Dynamic mode requires component version gates before the compiler may emit a
dynamic repository policy: an AWF release that implements this contract, a
`gh-aw-mcpg` release that exposes dynamic delegation API
`github-repository-delegation-v1` on the private control channel, and compiler
support that starts mcpg with the dynamic-delegation controller, closed
`github-repository-read-v1` policy, AWF-only control capability, and gateway
agent policies. Older components reject dynamic policy fields with no
permissive fallback.

### Canonical dynamic selector

Every dynamic component uses the selector's canonical UTF-8 byte sequence, not
a display-normalized value. A caller MUST supply exactly one ASCII
`owner/repository` value matching:

```text
^[a-z0-9](?:[a-z0-9-]{0,38})/(?!\.\.?$)(?!.*\.\.)[a-z0-9._-]{1,100}$
```

There is no trimming, case folding, Unicode normalization, URL decoding, or
alternate syntax. AWF rejects a selector that is not already canonical before
policy matching or calling mcpg. The compiler, AWF, mcpg, audit hashing, and
idempotency all use these exact ASCII bytes. This deliberately differs from
legacy static configuration, whose trusted catalog is normalized at ingestion.

## Live-read semantics

Static mode prefers immutable staged repository seeds. Dynamic mode has no
frontmatter seed, so it uses live GitHub reads through the delegated MCP
identity. Admission resolves the repository's default branch and records the
admitted default-branch SHA before the executor sees repository contents. The
audit record distinguishes this live-read SHA from an immutable seed and marks
the result as point-in-time, not reproducible from workflow frontmatter alone.

The executor must not silently switch repositories or broaden a GitHub search.
Every GitHub MCP call is scoped to the single admitted repository and to a tool
from `github-repository-read-v1`. Where the tool supports immutable refs, AWF
uses the admitted default-branch SHA; otherwise the audit record marks the data
as a live read at that admitted SHA.

## Non-disclosing errors

Dynamic admission must not become a repository existence oracle. Inaccessible,
nonexistent, expired, over-quota, malformed, and out-of-policy selectors all
return the same canonical admission-denied error to the primary agent. The error
does not include the requested owner, repository, policy reason, credential
state, HTTP status, or timing detail. Sensitive diagnostics are available only
in redacted audit artifacts for trusted operators.

## Quotas, serialization, and idempotency

AWF serializes admissions across static and dynamic invocations through one
lane, debits the shared finite repository ledger before execution, and never
queues unbounded work. Dynamic admission, identity creation, executor startup,
identity revocation, and cleanup are idempotent by `(run, enclave entry,
invocation id, canonical repository)`. A retried invocation receives the same
already-admitted repository and recorded default-branch SHA or the same
canonical denial after the envelope expires or quotas are exhausted.

Audit records include the mode, enclave entry, invocation id, canonical
selector hash, admitted repository hash, admitted default-branch SHA when
available, policy envelope id and expiry, delegated identity id hash, tool set,
quota debits, timing bucket, executor result state, revocation state, and
cleanup state. Records do not disclose private repository names to the primary
agent.

Shutdown closes admissions first, drains or cancels the single execution lane
within the configured grace period, revokes outstanding delegated identities,
reconciles labelled dynamic resources, writes audit records, and then removes
private state. Cleanup failures are fail-closed for future admissions and are
reported as redacted audit failures rather than retried indefinitely.

## Threat analysis

- **Repository-scope escape**: a canonical selector is admitted against the
  compiler envelope, bound into one mcpg identity, and enforced on every GitHub
  MCP call.
- **Search query scope escape**: dynamic identities allow only policy-approved
  tools and repository-scoped queries; unscoped organization or global search is
  rejected.
- **Confused deputy**: the primary agent cannot cause AWF, mcpg, or the
  compiler to reuse a broader identity because the invocation identity is
  created after admission and bound to one selector.
- **SSRF and network escape**: repository names are data, not URLs or network
  policy. They cannot change runtime image, proxy, network peers, or egress
  allowlists.
- **Identity replay and stale identities**: identities are single-invocation,
  short-lived, revocable, and rejected after completion, timeout, shutdown, or
  expiry.
- **Races**: the serialized admission lane and idempotency key prevent two
  concurrent calls from exceeding quotas or binding one identity to another
  repository.
- **Resource exhaustion**: compiler-owned quotas bound repositories,
  invocations, bytes, processes, CPU, memory, runtime, schemas, agent prompt
  size, and cleanup grace.
- **Existence disclosure**: all denial reasons collapse to one canonical error
  and timing bucket, with details only in redacted audit.
- **Cleanup failures**: shutdown records unreconciled resources, revokes where
  possible, removes private state only after audit, and fails closed on later
  admissions until reconciliation succeeds.
- **Admission and setup failures**: policy lookup, identity delegation,
  default-branch resolution, runtime-registry lookup, and executor-start errors
  all fail closed with the canonical denial or a bounded executor failure; none
  retries with broader credentials or a different mode.

## Consequences

Static workflows continue to work without dynamic GitHub access. Dynamic
workflows get late-bound repository selection without giving the caller control
over sensitivity, tools, credentials, runtime, model, image, network, or
resources. Compiler, mcpg, runtime-registry, executor, and integration work can
implement against this contract without changing the public enclave tool
surface.
