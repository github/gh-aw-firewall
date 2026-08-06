# Unified Enclave Architecture and Migration

## Status

Layer 3 of the staged migration adds the **agent executor** to the same
AWF-owned MCP server, behind the same authenticated private socket and the same
shared per-repository ledger. The subsystem remains deliberately disconnected
from the primary agent until the `gh-aw-mcpg` attachment layer. Both legacy
runtimes remain unchanged.

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

When the agent executor is enabled, AWF additionally pre-pulls or builds the
`enclave-agent` image, creates the dedicated `internal` `awf-enclave-agent`
network (172.31.0.0/24), and starts a dedicated API proxy on that network plus a
separate egress bridge. The MCP server itself never joins either network.

The server exposes one static MCP tool per **enabled** executor:

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

Both tool schemas set `additionalProperties: false`. No image, runtime, engine,
model, provider, profile, endpoint, mount, network, tool definition, system
prompt, message list, credential, timeout, or resource setting is accepted in a
tool call, and the alternate payload spelling (`task` for the agent tool,
`prompt` for the script tool) is an explicitly forbidden control so a second
payload can never be smuggled past the finite-disclosure charge. The agent
executor runs a fixed, AWF-authored model loop inside the enclave — the caller
supplies a prompt, never a system prompt, a message list, or a tool set.

`tools/list` publishes exactly the enabled tools and does not reveal
repositories, sensitivity, remaining budget, invocation counts, runtime, engine,
profile, or model configuration. Admitted executions debit the *same* live
per-repository ledger under executor kind `script` or `agent`; both executors
also share one serialization lane, so at most one enclave holds private
repository content at a time.

### Agent executor isolation

Every agent invocation gets a fresh, single-use, labelled enclave with:

- the immutable repository seed bind-mounted read-only and a `--read-only` root;
- bounded `tmpfs` for `/tmp` and the `/agent` work/result root;
- a fixed non-root uid/gid, `--cap-drop ALL`, `no-new-privileges`, and the
  audited sandbox seccomp profile;
- memory, CPU, PID, per-file size, and wall-clock timeout bounds;
- `--network awf-enclave-agent` as its only network, whose only other member is
  the dedicated API proxy — no primary agent, Squid, general API proxy, MCP
  server, safe-outputs collector, MCP gateway, or CLI proxy is on it.

Containers carry the `awf.enclave.run` and `awf.enclave.invocation` labels, so
one AWF-side reconciliation pass deterministically removes orphans from both
executors. `runtime: "sbx"` is schema-accepted but fails closed before staging;
`gvisor` requires an exactly registered `runsc` and never downgrades.

### Credential and provider disclosure

The dedicated API proxy is the only component that holds a real provider
credential. The MCP server, the enclave, and the primary agent never do. That
proxy's environment is minimized to the single provider route the configured
engine/profile uses, and external telemetry export (OTLP endpoints/headers,
trace propagation) plus Actions OIDC token-exchange state are removed from it,
exactly as for legacy bounded agents. Its telemetry is written only to the
enclave-private log root.

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
2. **AWF-owned script MCP server.** Implement the authenticated, offline local
   server and hardened script executor over the shared contracts; do not expose
   its private transport to the primary agent.
3. **Agent executor (this layer).** Add the fixed model loop, the dedicated
   API-proxy-only enclave network, and the `enclave_run_agent` tool behind the
   same MCP server, the same private socket, and the same shared ledger. The
   private transport still is not exposed to the primary agent.
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
