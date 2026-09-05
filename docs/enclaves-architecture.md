# Unified Enclave Architecture

## Status

Layer 5 establishes one `enclaves` subsystem, one AWF-owned MCP server, and mcpg-only access through the compiler handoff contract.

## Architecture

AWF stages immutable repository seeds on the host, starts one AWF-owned `enclave-mcp-server`, and exposes enabled executors only through `gh-aw-mcpg`.

- **Script executor** — `enclave_run_script` runs a bounded Python script in a no-network, read-only, single-use sandbox.
- **Agent executor** — `enclave_run_agent` runs the pinned Copilot engine in a bounded single-use enclave. Its mandatory peer is the dedicated API proxy; `agent.tools.github` (or the deprecated legacy `agent.github.cli: issues-read-v1` marker) also permits a direct connection to compiler-owned shared mcpg.
- **Shared controls** — the `repos` lists of the `enclaves` entries form the only trusted repository catalog; script and agent calls debit the same per-run repository ledger and share one admission lane.

The primary agent never receives a broker socket, wrapper binary, direct MCP server URL, capability, repository seed, ledger state, or alternate transport.

Repository admission has two modes, both served by this same MCP backend:

- **Static seed-backed mode** — the existing `repos` lists in enclave entries
  form the trusted repository catalog. AWF stages immutable seeds for that
  catalog before primary-agent work begins. Each invocation selects one catalog
  entry and exposes only that repository to the single-use executor.
- **Dynamic GitHub-MCP-backed mode** — the compiler provides a closed policy
  envelope instead of enumerating repository seeds in workflow frontmatter. Each
  invocation provides only a canonical `owner/repo` selector, bounded
  prompt/script payload, and finite response schema. AWF admits at most one
  repository for that invocation through the compiler-owned GitHub MCP path and
  records the admitted default-branch SHA.

Static and dynamic modes are compatible in one workflow run but mutually
exclusive within a single enclave entry: an entry declares either static `repos`
or a dynamic repository policy. Caller-controlled repository names are never
interpreted as policy. They cannot alter sensitivity, tools, credentials,
runtime, model, image, network, filesystem, resource limits, timeouts, or
quotas. Cross-repository aggregation occurs only in the primary agent by
combining multiple bounded enclave results.

## Tool contracts

The AWF-owned MCP server publishes only the enabled enclave tools:

```text
enclave_run_script({
  privateRepo: "owner/repo",
  schema: <finite disclosure schema>,
  script: <bounded UTF-8 Python source>
})

enclave_run_agent({
  privateRepo: "owner/repo",
  schema: <finite disclosure schema>,
  prompt: <bounded UTF-8 task prompt>
})
```

Both tool schemas are closed (`additionalProperties: false`). Callers cannot provide images, runtimes, models, profiles, prompts beyond the bounded payload field, repository catalogs, credentials, timeout overrides, or any other trusted control.

`tools/list` publishes exactly the enabled tools without revealing repositories,
sensitivity, remaining budget, invocation counts, runtime, engine, profile, or
model configuration. Both executors debit the same live per-repository ledger
and share one serialization lane. A concurrent tool call receives the canonical
error immediately instead of entering an unbounded fixed-timing queue.

## Topology and readiness

- `enclave-mcp-server` joins only the private `awf-enclave-mcp-control` network.
- The compiler launches `gh-aw-mcpg`, labels it for the run, and gives AWF the gateway identity plus the private `/mcp/awf-enclave` endpoint.
- The server is reachable **only** through that gateway. AWF never publishes the server on a host port and never hands the primary agent a direct route.
- When the agent executor is enabled, each invocation joins only the private `awf-enclave-agent` network. Its steady-state peers are the dedicated API proxy and, only when GitHub access is configured, compiler-owned shared mcpg.
- AWF attaches the existing mcpg container directly to that network at `172.31.0.40` with alias `awf-enclave-github-mcp`. No AWF bridge, GitHub CLI, Squid, primary agent, general API proxy, safe-output service, or other peer joins the network.

The base MCP handoff and late backend rediscovery are present in mcpg v0.4.15,
which reports MCP Gateway spec 1.16.0. The earlier minimum remains spec 1.15.0
and a post-v0.4.8 mcpg release.

The optional GitHub path additionally requires compiler support for mcpg
multi-agent identities and policies (tracked by `github/gh-aw#57787`). The
compiler MUST pin or minimum-version-gate the first supporting AWF release.
Older AWF versions reject the closed `github`/`tools.github` fields; there is
no permissive fallback.

The compiler-generated upstream uses `connectTimeout: 120` and
`toolTimeout: 4860`, covering the maximum 4800-second disclosure bucket, up to
one second of secret-independent response jitter, and a bounded transport
allowance. Its tool allowlist contains only the enabled
executor tools. The compiler generates a fresh 64-character lowercase
hexadecimal capability, substitutes it into the mcpg authorization header, and
passes it to AWF without exposing it to the primary agent.

### Gateway authorization boundaries

There are two separate authorization hops. AWF's upstream contract
authenticates mcpg to the AWF-owned enclave server with the
`AWF_ENCLAVE_MCP_CAPABILITY`. mcpg independently authenticates the client-facing
gateway endpoint with its gateway agent ID/API key; that is the credential
returned in mcpg's rewritten gateway output.

Engine config adapters consume mcpg's rewritten output, not AWF's upstream
contract. Therefore adapters MUST treat the client-facing `Authorization`
header as a runtime-only value: they must not resolve it while generating
configuration, and must never persist the resolved gateway credential under
`GITHUB_WORKSPACE` or any other agent-readable path. AWF's upstream template
does not enforce this downstream requirement.

`gh-aw-mcpg` may start before the enclave server. While the backend is
unavailable, mcpg returns retryable HTTP `503 backend_unavailable`; AWF retries
the complete `initialize` handshake with bounded 500 ms backoff until
`AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS` expires. Each request is capped by the
remaining readiness budget. Other HTTP, authentication, protocol, and tool
contract failures are terminal. Neither component may downgrade or bypass the
gateway, and readiness errors never log response bodies, headers, or
capabilities.

After primary-agent work stops, AWF gives the enclave server a bounded
4860-second stop grace. The server closes admissions, drains its single execution
lane, reconciles labelled enclaves, and exits before AWF preserves audit
artifacts and disconnects mcpg from the private control network. AWF never stops
or removes the externally owned mcpg container.

## GitHub access: `agent.tools.github`

Credential-isolated GitHub access is disabled by default and configured only on
an agent entry, via the closed `tools.github` contract:

```yaml
agent:
  model: gpt-5
  tools:
    github:
      allowed:
        - list_issues
        - issue_read
      allowedRepos:
        - octo-org/repo-b
      minIntegrity: none
```

- `allowed` is a non-empty subset of the two supported tools, `list_issues` and
  `issue_read`.
- `allowedRepos` is a non-empty array of exact `owner/repository` slugs; every
  entry must also appear in the enclosing enclave entry's `repos` list. AWF
  rejects any entry that is not.
- `minIntegrity`, when supplied, is one of `none`, `unapproved`, `approved`, or
  `merged`.

AWF validates this shape and wires the enclave-only shared MCP gateway
connection, but it never broadens or replaces the repository and integrity
policy: that policy is enforced entirely by the compiler-created,
enclave-specific mcpg identity described below. AWF derives its own readiness
check — the exact set of tools the gateway must (and must only) advertise —
from the configured `allowed` list, rather than a fixed pair.

### Legacy `agent.github.cli: issues-read-v1` marker

The original closed profile remains supported during migration:

```yaml
agent:
  model: gpt-5
  github:
    cli: issues-read-v1
```

This is equivalent to `tools.github.allowed: [list_issues, issue_read]` with no
AWF-side repository or integrity restriction beyond what the compiler's mcpg
identity already enforces. `agent.github` and `agent.tools.github` are mutually
exclusive: AWF rejects a configuration that sets both.

### Shared gateway wiring (both shapes)

The compiler provides the shared gateway handoff
`AWF_ENCLAVE_MCP_GATEWAY_CONTAINER`, `AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT`, and
`AWF_ENCLAVE_MCP_GATEWAY_IDENTITY`, plus a distinct
`AWF_ENCLAVE_GITHUB_MCP_AGENT_ID`. It configures that enclave identity in
mcpg's `gateway.agentIds` and `gateway.agentPolicies`, allowing only the
`github` server, the configured tools, and the repositories from the trusted
enclave catalog. The primary agent never receives the enclave identity.

AWF validates and stages the enclave identity in a mode-0600 private file,
removes it from the host environment, and copies it into each invocation's
private workspace. The single-use enclave mounts that copy read-only and sends
it directly as the `Authorization` value to
`http://172.31.0.40:8080/mcp/github`. AWF initializes a session through that
endpoint before primary-agent work begins and requires the advertised tool set
to be exactly the configured `allowed` list — no more, no fewer.

The mcpg identity is job-lifetime, not per-invocation. Consequently, mcpg
enforces the union of repositories configured for the enclave agent rather than
binding the credential to one invocation's assigned repository, and the
identity is not independently expired or revoked after each invocation. This
weaker lifetime and repository scope is an explicit tradeoff of direct shared
mcpg access; AWF still isolates each identity file and enclave process and
retains its own per-invocation seed, admission, ledger, output-schema, and
timing controls.

The enclave image contains no `gh` executable and fails preflight if one is
available. Copilot receives one invocation-private MCP configuration exposing
only the compiler-policy-limited direct mcpg endpoint. mcpg injects its GitHub
credential and enforces the configured tools and repositories. GitHub response
data remains inside the enclave.
Only the existing finite-schema result, shared ledger debit, and timing bucket
can return to the primary agent. Shutdown drains admissions, removes labelled
enclaves, disconnects compiler-owned mcpg from the enclave network, and then
removes private state. AWF never stops or removes the shared gateway container.

## Dynamic repository enclaves

Dynamic repository enclaves extend GitHub access from a static seed catalog to
runtime admission while preserving compiler ownership of security-sensitive
bounds. The compiler-to-AWF envelope is closed and includes allowed owners or
exact repository patterns, sensitivity, permitted executor types and GitHub MCP
tools, maximum admitted repositories, per-invocation CPU/memory/process/
filesystem/network/time/prompt/script/response limits, total quotas, audit
labels, and an absolute expiry no later than the workflow job lifetime. AWF
rejects unknown envelope fields and fails closed if any requested bound cannot
be enforced by AWF, mcpg, the runtime registry, or the executor. Admission,
identity delegation, live-read setup, executor startup, revocation, and cleanup
failures do not fall back to static mode, the existing job-lifetime GitHub
identity, or a broader policy.

Dynamic invocation flow:

1. The primary agent calls `enclave_run_script` or `enclave_run_agent` with one
   canonical repository selector, bounded payload, and finite schema.
2. AWF serializes admission through the shared enclave lane, validates the
   selector against the compiler envelope, and debits the shared repository
   ledger before execution.
3. The compiler-owned GitHub MCP path creates or confirms an invocation-scoped
   delegated identity bound to that run, enclave entry, admitted repository,
   approved tools, schema, and expiry.
4. AWF records the admitted repository hash and default-branch SHA, stores the
   delegated identity only in invocation-private state, and mounts it read-only
   into the single-use executor.
5. The executor may access only the admitted repository through the delegated
   GitHub MCP identity. If a GitHub MCP tool supports immutable refs, AWF uses
   the admitted default-branch SHA; otherwise the audit record marks the data as
   a live read at that admitted SHA.
6. On completion, timeout, failure, or shutdown, AWF requests identity
   revocation, records the revocation state, removes invocation-private state,
   and admits no other repository until cleanup for the serialized lane is
   complete.

Unlike static GitHub access, the delegated identity is not a reusable
job-lifetime credential. mcpg must reject replayed, expired, revoked,
wrong-tool, and wrong-repository uses. The primary agent never receives the
identity, the policy envelope, raw repository names from denied selectors,
GitHub credentials, or a direct enclave transport.

Dynamic admission is idempotent by `(run, enclave entry, invocation id,
canonical repository)`: retries receive the same recorded admission and
default-branch SHA or the same canonical denial after expiry or quota
exhaustion. Audit records include mode, enclave entry, invocation id, selector
hash, admitted repository hash, admitted default-branch SHA when available,
policy envelope id and expiry, delegated identity id hash, tool set, quota
debits, timing bucket, executor result, revocation state, and cleanup state.
Private repository names and credentials are not disclosed in primary-agent
outputs.

All inaccessible, nonexistent, out-of-policy, expired, malformed, and over-quota
selectors return the same canonical admission-denied error. That error omits the
requested owner/repository, policy reason, upstream HTTP status, credential
state, and timing detail so dynamic mode does not become an existence oracle.
Trusted operators can inspect only redacted audit diagnostics.

### Dynamic threat model

- **Repository-scope escape**: one invocation exposes one admitted repository;
  every GitHub MCP call is constrained by the delegated identity and approved
  tool set.
- **Search query scope escape**: organization-wide or global search is rejected
  unless represented as repository-scoped reads over separately admitted
  invocations.
- **Confused deputy behavior**: AWF never turns a caller-provided name into a
  broader credential; the compiler-created identity is bound after policy
  admission.
- **SSRF**: repository selectors are canonical data, not URLs, hostnames, proxy
  configuration, or egress allowlist entries.
- **Identity replay and stale identities**: identities expire no later than the
  invocation timeout, are revoked on every terminal path, and are rejected after
  shutdown.
- **Races**: one admission serialization lane covers static and dynamic calls,
  preventing concurrent quota bypass or repository/identity mixups.
- **Resource exhaustion**: compiler-owned quotas bound repository count,
  invocation count, bytes, CPU, memory, process count, filesystem exposure,
  prompt/script sizes, schema size, runtime, and cleanup grace.
- **Existence disclosure**: denial reasons collapse to one canonical error and
  timing bucket; detailed reasons are redacted into audit only.
- **Cleanup failures**: shutdown closes admissions first, drains or cancels the
  execution lane within the configured grace period, revokes outstanding
  identities, reconciles labelled resources, records failures, and fails closed
  for later admissions until reconciliation succeeds.
- **Admission and setup failures**: policy lookup, identity delegation,
  default-branch resolution, runtime-registry lookup, and executor-start errors
  fail closed without retrying under broader credentials or another repository
  mode.

See [ADR 0001: Agent enclave repository admission](adr/0001-agent-enclaves.md)
for the stable compiler, mcpg, runtime-registry, executor, and integration
contract.

## Coverage after legacy smoke removal

No unified gh-aw enclave smoke workflow exists yet, so AWF keeps coverage local and unit-focused instead of inventing unsupported workflow syntax. Current owned-scope guidance points to:

- `src/services/enclave-mcp-service.test.ts`
- `src/services/enclave-agent-service.test.ts`
- `src/enclave/script-runner-spec.test.ts`
- `src/enclave/agent-runner-spec.test.ts`
- `src/enclave/manager.test.ts`
- `src/enclave/mcp-server.test.ts`
- `src/enclave/agent-mcp-server.test.ts`

These tests cover the shared MCP server contract, executor selection, gVisor wiring, fail-closed `sbx` handling, and the private-network topology assumptions that replaced the legacy smoke and runtime-matrix assets.
