# Unified Enclave Architecture and Migration

## Status

Foundation accepted for staged migration. This document describes the target
architecture; the first implementation layer adds configuration and shared
contracts without changing either legacy runtime.

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

1. **Foundation (this layer).** Add strict `enclaves` config, neutral finite
   disclosure/staging/budget contracts, shared-ledger semantics, and compatibility
   exports. Keep both legacy systems fully functional and reject simultaneous
   enablement of a unified and legacy surface.
2. **AWF-owned MCP server.** Implement the server over the shared contracts,
   retaining trusted executor launchers behind adapters. Add authenticated local
   transport and readiness proof; do not expose direct broker ingress.
3. **`gh-aw-mcpg` integration.** Register and guard the AWF-owned server, wire
   startup retry/timeouts, require end-to-end readiness before primary-agent
   startup, and route both executor tools exclusively through the gateway.
4. **Runtime cutover.** Move staging, auditing, timing, and the shared ledger to
   the unified server. Remove direct `bounded-query` and `bounded-agent` agent
   surfaces after parity tests demonstrate canonical response and isolation
   equivalence.
5. **Legacy removal.** Remove `boundedQueries`, `boundedAgents`, their brokers,
   compatibility exports, images, docs, and tests only after the unified path is
   the sole supported runtime.

## Compatibility

This foundation layer is behavior-preserving. It does not launch an MCP server,
change primary-agent mounts or environment, combine live broker ledgers, or
alter legacy protocol bytes. Existing `boundedQueries` and `boundedAgents`
configurations continue to run as before.
