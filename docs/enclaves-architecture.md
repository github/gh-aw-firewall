# Unified Enclave Architecture

## Status

Layer 5 establishes one `enclaves` subsystem, one AWF-owned MCP server, and mcpg-only access through the compiler handoff contract.

## Architecture

AWF stages immutable repository seeds on the host, starts one AWF-owned `enclave-mcp-server`, and exposes enabled executors only through `gh-aw-mcpg`.

- **Script executor** — `enclave_run_script` runs a bounded Python script in a no-network, read-only, single-use sandbox.
- **Agent executor** — `enclave_run_agent` runs the pinned Copilot engine in a bounded single-use enclave. Its mandatory peer is the dedicated API proxy; `agent.github.cli: issues-read-v1` also permits a direct connection to compiler-owned shared mcpg.
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
- When the agent executor is enabled, each invocation joins only the private `awf-enclave-agent` network. Its steady-state peers are the dedicated API proxy and, only for `issues-read-v1`, compiler-owned shared mcpg.
- AWF attaches the existing mcpg container directly to that network at `172.31.0.40` with alias `awf-enclave-github-mcp`. No AWF bridge, GitHub CLI, Squid, primary agent, general API proxy, safe-output service, or other peer joins the network.

The base MCP handoff and late backend rediscovery are present in mcpg v0.4.15,
which reports MCP Gateway spec 1.16.0. The earlier minimum remains spec 1.15.0
and a post-v0.4.8 mcpg release.

The optional GitHub path additionally requires compiler support for mcpg
multi-agent identities and policies (tracked by `github/gh-aw#57787`). The
compiler MUST pin or minimum-version-gate the first supporting AWF release.
Older AWF versions reject the closed `github` field; there is no permissive
fallback.

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

## Optional `issues-read-v1` GitHub access

The profile is disabled by default and configured only on an agent entry:

```yaml
agent:
  model: gpt-5
  github:
    cli: issues-read-v1
```

The compiler provides the shared gateway handoff
`AWF_ENCLAVE_MCP_GATEWAY_CONTAINER`, `AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT`, and
`AWF_ENCLAVE_MCP_GATEWAY_IDENTITY`, plus a distinct
`AWF_ENCLAVE_GITHUB_MCP_AGENT_ID`. It configures that enclave identity in
mcpg's `gateway.agentIds` and `gateway.agentPolicies`, allowing only the
`github` server, the `list_issues` and `issue_read` tools, and the repositories
from the trusted enclave catalog. The primary agent never receives the enclave
identity.

AWF validates and stages the enclave identity in a mode-0600 private file,
removes it from the host environment, and copies it into each invocation's
private workspace. The single-use enclave mounts that copy read-only and sends
it directly as the `Authorization` value to
`http://172.31.0.40:8080/mcp/github`. AWF initializes a session through that
endpoint before primary-agent work begins and requires the advertised tool set
to be exactly `list_issues` and `issue_read`.

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
