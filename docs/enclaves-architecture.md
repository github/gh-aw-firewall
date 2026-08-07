# Unified Enclave Architecture and Migration

## Status

Layer 5 removes the legacy bounded-query and bounded-agent surfaces. AWF now documents one `enclaves` subsystem, one AWF-owned MCP server, and mcpg-only access through the compiler handoff contract.

## Architecture

AWF stages immutable repository seeds on the host, starts one AWF-owned `enclave-mcp-server`, and exposes enabled executors only through `gh-aw-mcpg`.

- **Script executor** — `enclave_run_script` runs a bounded Python script in a no-network, read-only, single-use sandbox.
- **Agent executor** — `enclave_run_agent` runs the pinned Copilot engine in a bounded single-use enclave whose only network peer is the dedicated API proxy.
- **Shared controls** — `enclaves.privateRepos` is the only trusted repository list; script and agent calls debit the same per-run repository ledger and share one admission lane.

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
- When the agent executor is enabled, each invocation joins only the private `awf-enclave-agent` network; its only peer is the dedicated enclave API proxy.

Rollout depends on both sides of the gateway contract:

1. **Compiler handoff contract** — `github/gh-aw#50920` must emit the enclave upstream, capability, identity label, endpoint, and timeout handoff.
2. **Late backend rediscovery** — `github/gh-aw-mcpg#10784` must preserve an initially unavailable HTTP backend and rediscover it later.
3. **Gateway/runtime requirement** — this requires MCP Gateway spec **1.15.0** and the **first mcpg release after v0.4.8 containing it**.

The compiler-generated upstream uses `connectTimeout: 120` and
`toolTimeout: 630`, covering the maximum 600-second disclosure bucket plus a
bounded transport allowance. Its tool allowlist contains only the enabled
executor tools. The compiler generates a fresh 64-character lowercase
hexadecimal capability, substitutes it into the mcpg authorization header, and
passes it to AWF without exposing it to the primary agent.

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

## Migration and removals

The following legacy surfaces are **removed, not deprecated**:

| Removed surface | Replacement |
| --- | --- |
| `boundedQueries` config | `enclaves.privateRepos` + `enclaves.executors.script` |
| `boundedAgents` config | `enclaves.privateRepos` + `enclaves.executors.agent` |
| `bounded-query` wrapper / generated skill | `enclave_run_script` MCP tool |
| `bounded-agent` wrapper / generated skill | `enclave_run_agent` MCP tool |
| Separate per-subsystem ledgers | One shared per-repository ledger inside `enclave-mcp-server` |
| Direct legacy runtime surfaces | Compiler-launched `gh-aw-mcpg` handoff only |

Mixed legacy + unified configuration is no longer a compatibility mode. Tooling should remove the old keys rather than carrying both.

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
