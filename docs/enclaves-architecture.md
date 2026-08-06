# Unified Enclave Architecture and Migration

## Status

Layer 4 of the staged migration connects the AWF-owned MCP server exclusively
through `gh-aw-mcpg`. The primary agent receives no enclave socket, capability,
direct URL, repository list, control root, ledger, or private state. Both legacy
runtimes remain unchanged for the final cutover layer.

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
builds the script image, then starts the MCP server only on the internal control
network.
The server owns the Docker socket, seed map, shared ledger, protected audit
state and a run-scoped capability token. The server joins only the dedicated
`internal` `awf-enclave-mcp-control` network under the stable
`awf-enclave-mcp:8080` identity. There is no published host port. AWF attaches
only the compiler-labelled external gateway to that network after verifying its
run identity. Neither the capability nor any direct transport is mounted into or
exported to the primary agent.

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

`gh-aw-mcpg` startup may precede AWF's enclave server startup. The compiler must
configure the HTTP upstream before launching mcpg and give it sufficient
connection timeout/retry behavior for AWF staging and startup. Neither component
may silently downgrade or bypass the gateway while waiting.

The primary agent must not start until AWF has proved readiness end to end:

1. the AWF-owned enclave MCP server is healthy on its private control network;
2. the running gateway name and `com.github.gh-aw.mcpg.run` label match the
   compiler handoff;
3. AWF attaches that gateway to the control network and proves it is the only
   member besides the server;
4. `initialize`, `notifications/initialized`, and `tools/list` traverse the
   gateway's published route;
5. the returned server identity and complete tool contracts exactly match the
   enabled executor set.

A timeout, identity mismatch, failed proof, or unavailable executor capability
fails the run before repository staging is exposed or the primary agent starts.

### Compiler-generated mcpg handoff

The compiler must generate this upstream entry before starting `awmg-mcpg`:

```json
{
  "awf-enclave": {
    "type": "http",
    "url": "http://awf-enclave-mcp:8080/mcp",
    "headers": {
      "Authorization": "Bearer ${AWF_ENCLAVE_MCP_CAPABILITY}"
    },
    "tools": ["enclave_run_script", "enclave_run_agent"],
    "connectTimeout": 120,
    "toolTimeout": 150
  }
}
```

The `tools` array must contain only enabled executor tools. `toolTimeout` is 30
seconds greater than the largest enabled executor timeout (150 in the example).
The compiler must
generate a fresh 64-character lowercase hexadecimal
`AWF_ENCLAVE_MCP_CAPABILITY`, pass it to mcpg for header substitution and to the
AWF host process, and never pass it to the primary agent. It must also:

- launch the externally owned gateway as `awmg-mcpg`;
- label it `com.github.gh-aw.mcpg.run=<run-unique identity>`;
- set `AWF_ENCLAVE_MCP_GATEWAY_IDENTITY` to that exact identity for AWF;
- set `AWF_ENCLAVE_MCP_GATEWAY_CONTAINER=awmg-mcpg`;
- set `AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT` to the host-reachable gateway route
  ending in `/mcp/awf-enclave`;
- optionally set `AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS` to a bounded
  1000-600000 ms value (default 120000);
- configure gateway HTTP-upstream startup timeout/retry semantics for at least
  120 seconds.
- enable AWF network isolation and include `awmg-mcpg` in `topologyAttach`, so
  Compose agents reach only the gateway on `awf-net` while AWF separately
  attaches the same verified container to the enclave control network.

`buildEnclaveMcpgUpstreamContract()` is the machine-readable AWF source of truth
for the static entry and handoff names. AWF excludes all handoff variables from
agent environment passthrough, including `--env-all`.

The current gh-aw compiler does not yet emit this enclave upstream, capability,
identity label, or readiness endpoint. It requires a companion change in
`pkg/workflow/mcp_setup_gateway.go`, `mcp_gateway_config.go`,
`mcp_renderer.go`, and `awf_config.go`. Current mcpg releases must also support
retrying an initially unavailable HTTP upstream without permanently omitting its
tools; otherwise the compiler must delay/restart mcpg after AWF infrastructure
readiness. AWF does not restart or take ownership of mcpg.

The enclave server alias never enters the primary agent's `NO_PROXY`, Squid ACL,
static hosts, mounts, or environment. Only `awmg-mcpg` remains an agent-visible
topology peer. Thus proxy-aware and proxy-ignoring clients cannot use Squid as an
alternate path to the enclave server.

### Shutdown

After primary-agent work stops, AWF sends the enclave server `SIGTERM`. The
server closes admissions, drains the single execution lane within Docker's
bounded stop grace, reconciles labelled enclaves, and exits. AWF then disconnects
the external gateway from `awf-enclave-mcp-control`; Compose removes the
AWF-owned server and network, and host cleanup removes the private roots. AWF
never stops or removes `awmg-mcpg`.

## Migration sequence

1. **Foundation.** Add strict `enclaves` config, neutral finite
   disclosure/staging/budget contracts, shared-ledger semantics, and compatibility
   exports. Keep both legacy systems fully functional and reject simultaneous
   enablement of a unified and legacy surface.
2. **AWF-owned script MCP server.** Implement the authenticated, offline local
   server and hardened script executor over the shared contracts; do not expose
   its private transport to the primary agent.
3. **Agent executor.** Add the fixed model loop, the dedicated
   API-proxy-only enclave network, and the `enclave_run_agent` tool behind the
   same MCP server, authenticated private transport, and shared ledger. The
   private transport is not exposed to the primary agent.
4. **`gh-aw-mcpg` integration (this layer).** Register and guard the AWF-owned server, wire
   startup retry/timeouts, require end-to-end readiness before primary-agent
   startup, and route both executor tools exclusively through the gateway.
5. **Runtime cutover and legacy removal.** Move all callers to the unified MCP
   surface, prove canonical-response and isolation parity, then remove
   `boundedQueries`, `boundedAgents`, their direct agent surfaces, brokers,
   compatibility exports, images, docs, and tests. The unified mcpg path becomes
   the sole supported runtime.

## Compatibility

This layer adds no primary-agent enclave mount, environment variable, wrapper,
skill, direct URL, or fallback and does not alter legacy protocol bytes.
Existing `boundedQueries` and `boundedAgents` configurations continue to run as
before. Unified and legacy configurations remain mutually exclusive and fail
closed before staging.
