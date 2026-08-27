# Unified Enclave Architecture

## Status

Layer 5 establishes one `enclaves` subsystem, one AWF-owned MCP server, and mcpg-only access through the compiler handoff contract.

## Architecture

AWF stages immutable repository seeds on the host, starts one AWF-owned `enclave-mcp-server`, and exposes enabled executors only through `gh-aw-mcpg`.

- **Script executor** — `enclave_run_script` runs a bounded Python script in a no-network, read-only, single-use sandbox.
- **Agent executor** — `enclave_run_agent` runs the pinned Copilot engine in a bounded single-use enclave. Its mandatory peer is the dedicated API proxy; `agent.github.cli: issues-read-v1` adds only the PAT-free AWF CLI proxy.
- **Shared controls** — the `repos` lists of the `enclaves` entries form the only trusted repository catalog; script and agent calls debit the same per-run repository ledger and share one admission lane.

The primary agent never receives a broker socket, wrapper binary, direct MCP server URL, capability, repository seed, ledger state, or alternate transport.

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
- When the agent executor is enabled, each invocation joins only the private `awf-enclave-agent` network. Its steady-state peers are the dedicated API proxy and, only for `issues-read-v1`, the PAT-free AWF CLI proxy.
- The CLI proxy is dual-homed on `awf-enclave-agent` and the internal `awf-enclave-github-control` network. Compiler-owned mcpg joins only the latter under `awf-enclave-github-proxy:18443`; the enclave has no direct mcpg route.

The base MCP handoff and late backend rediscovery are present on current defaults:
gh-aw pins mcpg v0.4.10, which reports MCP Gateway spec 1.16.0. The earlier
minimum remains spec 1.15.0 and a post-v0.4.8 mcpg release.

The optional GitHub path additionally requires the first compiler and mcpg
releases implementing `issues-read-v1`, the canonical `awf-egh1` capability,
public-visibility proof, secrecy labels, and the dedicated proxy identity
handoff. The compiler MUST pin or minimum-version-gate the first supporting AWF
release. Older AWF versions reject the closed `github` field; there is no
permissive fallback.

The compiler-generated upstream uses `connectTimeout: 120` and
`toolTimeout: 630`, covering the maximum 600-second disclosure bucket plus a
bounded transport allowance. Its tool allowlist contains only the enabled
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
630-second stop grace. The server closes admissions, drains its single execution
lane, reconciles labelled enclaves, and exits before AWF preserves audit
artifacts and disconnects mcpg from the private control network. AWF never stops
or removes the externally owned mcpg container.

## Optional issues-read-v1 GitHub access

The profile is disabled by default and configured only on an agent entry:

```yaml
agent:
  model: gpt-5
  github:
    cli: issues-read-v1
```

The compiler provides `AWF_ENCLAVE_GITHUB_PROXY_CONTAINER`,
`AWF_ENCLAVE_GITHUB_PROXY_IDENTITY`, `AWF_ENCLAVE_GITHUB_PROXY_CA_CERT`, and a
64-character lowercase hexadecimal `MCP_GATEWAY_ENCLAVE_CAPABILITY_KEY`.
The identity is the compiler-normalized capability run claim
`gh-aw-egh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${JOB_HASH}` and matches
mcpg policy `workflow_run_id` byte for byte. AWF writes the identity and HMAC
root to separate mode-0600 private files mounted only into
`enclave-mcp-server`, then removes the root from its host environment. The
compiler passes policy JSON only to mcpg. The AWF CLI proxy has neither the PAT
nor the HMAC root.

For every admitted invocation, the MCP server mints
`awf-egh1.<payload-base64url>.<hmac-base64url>`. The compact JSON payload fields
are ordered exactly as `v,aud,run,inv,repo,profile,ops,nbf,exp`; the HMAC input
is ASCII `awf-egh1.` followed by the payload encoding. The token is bound to the
run, invocation, assigned repository, fixed profile, fixed sorted operation
set, and deadline, and is mounted read-only into only that single-use enclave.
The payload `run` is the compiler proxy identity, not AWF's independent random
seed-map/container-reconciliation run ID.
The payload `repo` is the exact canonical lowercase `owner/repo` admitted from
the enclave repository catalog. AWF never widens it to an owner, wildcard, or
all-private scope and never sends a DIFC secrecy label. mcpg alone derives the
invocation agent's exact `private:owner/repo` secrecy tag from the verified
claim, labels public response data with empty secrecy, and labels other private
repositories with their own distinct repository tag.

The enclave-visible `gh` wrapper accepts only `gh api` GET requests for issue
list, issue get, and issue comments REST paths. It rejects GraphQL, search,
writes, absolute URLs, alternate hosts, traversal, body flags, auth/config/
extension/alias commands, arbitrary endpoints, and environment overrides.
Stock `gh issue list` and `gh issue view --comments` are not supported because
they commonly use GraphQL.

mcpg validates single-use capabilities, injects its PAT, permits the assigned
repository or a currently proven-public repository, and attaches the
authoritative secrecy label. GitHub response data remains inside the enclave.
Only the existing finite-schema result, shared ledger debit, and timing bucket
can return to the primary agent. Shutdown drains admissions, removes labelled
enclaves, stops the PAT-free proxy, preserves private audit, disconnects
compiler-owned mcpg, and then removes private state.

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
