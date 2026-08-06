# Unified Enclave Architecture and Migration

## Status

Layer 2 of the staged migration implements the AWF-owned MCP server and the
script executor. It remains deliberately disconnected from the primary agent
until the `gh-aw-mcpg` attachment layer. Both legacy runtimes remain unchanged.

## Decision

AWF will replace `boundedQueries` and `boundedAgents` with one `enclaves`
subsystem. Trusted configuration declares a shared set of private repositories,
their sensitivities, and two executor kinds:

- **script** runs a fixed interpreter in a no-network sandbox;
- **agent** runs a fixed native agent on an API-proxy-only network.

Runtime, image, model, network, timeout, resource, mount, credential, and tool
settings are trusted AWF configuration. An enclave invocation may select only an
allowed repository, a finite response schema, and executor-specific bounded
input. It can never provide or override trusted controls.

Every repository has **one information-budget ledger for the AWF run**. Script
and agent invocations debit the same balance. Selecting a different executor
does not create a second budget, and charges are never refunded after an
invocation is admitted.

## Target trust boundaries

1. **AWF host orchestration (trusted).** AWF validates configuration, proves
   runtime capabilities, stages immutable repository seeds, creates private
   state, launches the enclave MCP server, and owns cleanup. Staging credentials
   exist only here.
2. **Enclave MCP server (trusted, AWF-owned).** AWF owns and launches the server.
   It loads trusted executor configuration and the single repository ledger,
   admits finite-schema requests, launches isolated executors, canonicalizes one
   finite result, and protects audit state. It is not a user-supplied MCP server.
3. **`gh-aw-mcpg` (trusted policy gateway).** The primary agent can reach the
   enclave server only through `gh-aw-mcpg`. The gateway guards the tool surface
   and calls the AWF-owned server; it does not receive repository seeds,
   credentials, executor configuration, or ledger state.
4. **Executor enclave (untrusted workload).** Each invocation receives only its
   selected immutable seed and bounded input. Script execution has no network.
   Agent execution can reach only its dedicated API proxy. Neither can reach the
   primary agent, MCP gateway, server control state, another executor, or host
   state.
5. **Primary agent (untrusted caller).** It sees only MCP tool schemas and one
   canonical finite success/error response. It cannot access a broker socket,
   direct executor command, private seed, audit record, or remaining budget.

Repository-derived content processed by an agent executor reaches the configured
model provider through the API proxy. The information ledger bounds what the
primary agent learns; it does not bound what the provider sees.

## Startup and readiness

The script service is an offline Compose service. AWF stages immutable seeds and
creates a run-unique private root before Compose generation. Compose pre-pulls or
builds the script image, then starts the MCP server with `network_mode: none`.
The server owns the Docker socket, seed map, shared ledger, protected audit
state, and a private Unix socket plus capability token. Neither the socket nor
the token is mounted into the primary agent in this layer.

The server exposes one static MCP tool:

```text
enclave_run_script({
  privateRepo: "owner/repo",
  schema: <finite disclosure schema>,
  script: <bounded UTF-8 Python source>
})
```

No image, runtime, interpreter path, command, mount, network, credential,
timeout, or resource setting is accepted in a tool call. `tools/list` is static
and does not reveal repositories, sensitivity, remaining budget, runtime, or
model configuration. Admitted executions debit the unified per-repository
ledger under executor kind `script`.

Executor outcomes return successful JSON-RPC tool results whose
`structuredContent` is exactly canonical `{"status":"ok","result":...}` or
`{"status":"error"}`. Secret-dependent failures never use JSON-RPC errors or
`isError`. Cleanup remains inside the fixed timing bucket.

`gh-aw-mcpg` startup may precede AWF's enclave server startup. The configured MCP
server connection timeout and retry policy are the synchronization mechanism;
neither component may silently downgrade or bypass the gateway while waiting.

The primary agent must not start until AWF has proved readiness end to end:

1. the AWF-owned enclave MCP server is healthy;
2. `gh-aw-mcpg` has connected to that exact configured server;
3. a guarded readiness call has traversed `gh-aw-mcpg` to the server and returned
   the expected proof.

A timeout, identity mismatch, failed proof, or unavailable executor capability
fails the run before repository staging is exposed or the primary agent starts.

## Migration sequence

1. **Foundation.** Add strict `enclaves` config, neutral finite
   disclosure/staging/budget contracts, shared-ledger semantics, and compatibility
   exports. Keep both legacy systems fully functional and reject simultaneous
   enablement of a unified and legacy surface.
2. **AWF-owned script MCP server (this layer).** Implement the authenticated,
   offline local server and hardened script executor over the shared contracts;
   do not expose its private transport to the primary agent.
3. **Agent executor.** Add the fixed model loop and API-proxy-only enclave
   network behind the same MCP server and shared ledger.
4. **`gh-aw-mcpg` integration.** Register and guard the AWF-owned server, wire
   startup retry/timeouts, require end-to-end readiness before primary-agent
   startup, and route both executor tools exclusively through the gateway.
5. **Runtime cutover.** Move all callers to the unified MCP surface and
   the unified server. Remove direct `bounded-query` and `bounded-agent` agent
   surfaces after parity tests demonstrate canonical response and isolation
   equivalence.
6. **Legacy removal.** Remove `boundedQueries`, `boundedAgents`, their brokers,
   compatibility exports, images, docs, and tests only after the unified path is
   the sole supported runtime.

## Compatibility

This layer does not change primary-agent mounts or environment and does not
alter legacy protocol bytes. Existing `boundedQueries` and `boundedAgents`
configurations continue to run as before. Unified and legacy configurations
remain mutually exclusive and fail closed before staging.
