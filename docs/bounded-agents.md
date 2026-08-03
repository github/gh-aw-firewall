# Bounded Agents

Delegate narrow, brokered *agentic* tasks about private repositories to an
isolated enclave whose only reachable peer is the AWF API proxy.

A **bounded agent** lets an agent hand a trusted broker a bounded task about one
pre-approved private repository and get back a single value conforming to a
finite schema it declares up front — without ever seeing repository contents,
the enclave's transcript, its tool calls, its diagnostics, or its exit status.

Bounded agents are the agentic sibling of [bounded queries](bounded-queries.md).
A bounded query runs an agent-authored Python script in a sandbox with **no
network at all**. A bounded agent runs a **fixed, AWF-authored model loop** in an
enclave that can reach exactly one thing: the AWF API proxy.

The feature is config-only: there are no `--bounded-agents-*` CLI flags.
Everything is expressed in the AWF JSON configuration file.

## When to use which

| | Bounded query | Bounded agent |
|---|---|---|
| Work is | an agent-authored Python script | a fixed AWF-authored model loop |
| Enclave network | none | the API proxy, and nothing else |
| Repository access | writable private copy | read-only immutable seed |
| Provider sees repo content | never | **yes** — see [Provider disclosure](#provider-disclosure) |
| Good for | deterministic, scriptable questions | questions needing judgment or multi-step reading |

**Prefer a bounded query whenever a deterministic script can answer the
question.** Reach for a bounded agent only when the question genuinely needs a
model to read and judge.

**Good uses**

- "Which of these four architectural patterns best describes the service?" — small enum
- "Does the error-handling in this module meet our documented standard?" — boolean
- "Which subsystem owns retry policy: `net`, `store`, `api`, or none?" — small enum

**Not suited for**

- Extracting source code, documentation, or any variable-length text — unbounded strings are structurally impossible in the schema DSL
- Anything a bounded query can answer deterministically
- Repositories whose contents must never reach the configured model provider
- Repositories marked `sealed` (0-bit budget) — these can never fund a single invocation

## Architecture

Four trust stages, mirroring bounded queries:

1. **Trusted host preflight, then staging.** Preflight runs *first*: AWF
   validates the configuration, rejects Docker-socket exposure to the primary
   agent, requires the API proxy plus a configured `profile`/`model` route, and
   proves the enclave runtime is available. Only
   then does it clone each configured repository using `GH_TOKEN`/`GITHUB_TOKEN`,
   strip all credentials, remotes, hooks, and write bits, and reject submodules
   and gitdir pointers. The staging credential is scrubbed before any container
   exists. A run that could never launch an enclave never clones anything.

2. **Trusted broker over a Unix socket.** A dedicated `awf-bounded-agent-broker`
   container with `network_mode: none` serves requests over a Unix socket
   mounted into the agent. It has no network at all — not even the enclave
   network it launches enclaves onto. It holds the seed map (including each
   repository's trusted sensitivity), which the agent can never read or modify,
   and it keeps a ledger **separate** from bounded queries.

3. **Single-use enclave on an API-proxy-only network.** For each accepted
   request the broker launches one fresh, uniquely named, labelled container
   with a frozen argument vector: read-only root, the immutable seed
   bind-mounted read-only, bounded tmpfs mounts for work/result/`/tmp`, fixed
   non-root UID/GID, `--cap-drop ALL`, `no-new-privileges`, a seccomp profile,
   and memory/CPU/PID/file-size/timeout bounds. It joins only the dedicated
   `internal` `awf-bounded-agent` network, whose sole other member is a
   dedicated API proxy with private telemetry and a separate egress bridge.

4. **Canonical finite result and cleanup.** The enclave writes exactly one JSON
   value to a dedicated bounded result file. The broker force-removes the
   container, destroys the workspace, validates the result against the declared
   schema, canonically re-serializes it, and only then selects the timing
   bucket. The agent receives exactly `{"status":"ok","result":<value>}` or
   `{"status":"error"}` — and never the remaining budget.

## Configuration

```json
{
  "apiProxy": { "targets": { "openai": {} } },
  "boundedAgents": {
    "enabled": true,
    "privateRepos": [
      { "repo": "my-org/private-service", "sensitivity": "internal" }
    ],
    "runtime": "docker",
    "profile": "openai",
    "model": "gpt-4o-mini",
    "timeout": 120,
    "memoryLimit": "512m",
    "cpuLimit": "1",
    "pidsLimit": 128,
    "tmpfsLimit": "64m",
    "maxOutputBytes": 8192,
    "maxTaskBytes": 4096,
    "maxInvocations": 8,
    "maxModelRequests": 8,
    "maxModelTokens": 1024
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Only an explicit `true` enables the subsystem. |
| `privateRepos` | — | Required when enabled. `{ repo, sensitivity }` entries; `repo` must be a bare `owner/repo` slug, unique case-insensitively. |
| `runtime` | `docker` | `docker` or `gvisor`. `sbx` is accepted by the schema but fails closed (see below). |
| `profile` | `openai` | Provider protocol the enclave speaks to the API proxy: `openai` (`POST /v1/chat/completions`) or `anthropic` (`POST /v1/messages`). |
| `model` | — | Required when enabled. A request can never choose or override it. |
| `timeout` | `120` | Wall-clock seconds for one invocation (max 540). |
| `memoryLimit` | `"512m"` | Docker memory limit; swap disabled at the same value. |
| `cpuLimit` | `"1"` | Docker `--cpus`. |
| `pidsLimit` | `128` | Docker `--pids-limit`. |
| `tmpfsLimit` | `"64m"` | Size bound for each writable tmpfs. |
| `maxOutputBytes` | `8192` | Exact size bound on the result file. |
| `maxTaskBytes` | `4096` | Byte bound on the task text. |
| `maxInvocations` | `8` | Per-run response cap; rejections count. |
| `maxModelRequests` | `8` | Model requests per invocation. |
| `maxModelTokens` | `1024` | `max_tokens` per model call. |

Every default is deliberately conservative. Widen them explicitly, and only as
far as a task actually needs.

### Requirements

Bounded agents abort the run at preflight — before staging clones anything —
unless all of the following hold:

- the AWF API proxy is enabled (the enclave holds no credentials, and the proxy
  is its only permitted upstream egress);
- the selected `profile` has a configured API target (an OpenAI credential for
  `openai`, an Anthropic credential for `anthropic`);
- `model` is set;
- a staging credential is present in `GH_TOKEN` or `GITHUB_TOKEN`;
- the Docker host is a Unix socket;
- the selected runtime is actually available.

## Docker and gVisor

`runtime: "docker"` uses the daemon's default OCI runtime.

`runtime: "gvisor"` requires the `runsc` OCI runtime to be registered with the
Docker daemon. Availability is proven exactly at preflight and again at broker
startup. **An unavailable `runsc` never downgrades to the default runtime** — the
run aborts instead.

```json
{ "boundedAgents": { "enabled": true, "runtime": "gvisor", "model": "gpt-4o-mini",
  "privateRepos": [{ "repo": "my-org/private-service", "sensitivity": "internal" }] } }
```

Nothing else about the topology, mounts, budgets, or protocol changes between
the two backends.

## `sbx` fails closed

`runtime: "sbx"` is accepted by the JSON Schema so configurations can be written
ahead of support landing, but it **fails closed** with an explicit
not-yet-implemented capability error at preflight, and is rejected again by
compose assembly and by the broker's runner factory. AWF has no audited
single-use, API-proxy-only enclave launcher for `sbx`; support is deliberately
deferred.

## Agent interface

When enabled, the agent gets a `bounded-agent` CLI on its `PATH` and a
generated `SKILL.md` under `~/.github/skills/bounded-agent/`.

```bash
bounded-agent \
  --repo my-org/private-service \
  --schema '{"type":"enum","values":["net","store","api","none"]}' \
  <<'TASK'
Which subsystem owns the retry policy for outbound HTTP calls?
TASK
```

The CLI accepts exactly `--repo` (once), `--schema` (once), and the task text on
stdin. There are no other options: it cannot express an image, command,
executable, model, provider, profile, tool, system prompt, runtime, timeout,
mount, path, network, proxy, endpoint, resource limit, environment variable, or
credential. It always prints exactly one line of canonical JSON, writes nothing
to stderr, and exits `0`.

Inside the enclave the model gets three read-only repository tools (list, read,
search) confined to the immutable seed, plus one terminal tool that records the
final answer. There is no shell, no `gh`, no git, no package manager, no host
state, no safe outputs, and no MCP.

## Budget

Every invocation reserves a fixed information charge from its repository's run
budget, computed **before** any workspace or container is created:

```text
charge = 1 (ok/error) + ceil(log2(schema cardinality)) + 3 (timing)
```

| Sensitivity | Run budget |
|-------------|-----------:|
| `public` | unmetered |
| `internal` | 64 bits/run |
| `confidential` | 8 bits/run |
| `sealed` | 0 bits/run — never launches an enclave |

Charges are never refunded, regardless of outcome. The remaining balance is
never disclosed to the calling agent.

Bounded agents keep a ledger **separate** from bounded queries: the two
subsystems run separate brokers with separate seed maps in separate private
roots, so spending on one never consumes the other's balance.

## Threat model

**What bounded agents defend against**

| Threat | Control |
|---|---|
| Calling agent reads private source | It never receives repository bytes — only one canonical envelope. |
| Calling agent escalates through the request | The request selects only a repository, a finite schema, and bounded task text. Image, command, executable, mount, env, endpoint, network, proxy, credential, timeout, resource, runtime, and tool controls — and unknown keys — are rejected. |
| Enclave exfiltrates over the network | The enclave joins only an `internal` network whose sole other member is a dedicated API proxy. No Squid, no general proxy, no DNS route out, no internet. |
| Enclave signals through proxy telemetry | Bounded-agent traffic uses a separate API-proxy process whose logs, metrics, quota counters, and egress network are not reachable or mounted by the primary agent. |
| Enclave reaches other AWF components | The primary agent, Squid, the broker, safe outputs, the MCP gateway, and the CLI proxy are all off that network. |
| Enclave steals credentials | It holds none. The API proxy injects the real key; the enclave's environment is a fixed list with no credential, token, or proxy variable. |
| Enclave mutates or persists private source | The seed is bind-mounted read-only into a read-only root; there is no writable copy on the host. |
| Enclave escapes the sandbox | Non-root UID/GID, `--cap-drop ALL`, `no-new-privileges`, seccomp, and memory/CPU/PID/file-size/timeout bounds. |
| Broker is used as a launcher for arbitrary containers | The argument vector is frozen and derived only from trusted config plus broker-generated identifiers. |
| Failure classes leak signal | Every failure collapses to the identical `{"status":"error"}`; reasons go only to a protected audit log. |
| Latency leaks signal | Responses are held to one of six fixed timing buckets, chosen only after cleanup, and timing is charged to the budget. |
| Orphaned enclaves retain private content | Every enclave is labelled with the run id and force-removed at teardown, including under `--keep-containers`. |
| Staging credential leaks | Used only by the trusted host phase via a `GIT_ASKPASS` helper reading a 0600 file; scrubbed before any container exists; never in argv, a URL, a log, or a compose file. |

**What bounded agents do NOT defend against**

- **Provider exposure.** See below.
- **Semantic misclassification.** The feature enforces the declared sensitivity
  budget; it cannot validate that an operator classified a repository correctly.
- **A model that spends its budget badly.** A high-cardinality schema is charged
  accordingly, but the caller still chooses what question to ask.

### Provider disclosure

A bounded agent necessarily sends repository-derived content — file listings,
file excerpts, and search hits selected by the model — to the configured model
provider through the AWF API proxy.

**The information-budget ledger bounds what the *calling agent* learns, not what
the *provider* sees.**

This is a materially different exposure from a bounded query, whose Python
sandbox has no network at all. Before enabling bounded agents for a repository,
treat the configured provider as an authorized recipient of that repository's
contents. When a deterministic script can answer the question, use a
[bounded query](bounded-queries.md) instead.

## Related

- [Bounded queries](bounded-queries.md) — the no-network, script-based sibling
- [AWF configuration spec §15](awf-config-spec.md) — normative model
- [API proxy sidecar](api-proxy-sidecar.md) — credential isolation
