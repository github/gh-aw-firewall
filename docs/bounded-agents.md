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

2. **Trusted broker over a private ingress.** A dedicated `awf-bounded-agent-broker`
   container with `network_mode: none` serves requests over a Unix socket
   mounted into the agent. It has no network at all — not even the enclave
   network it launches enclaves onto. It holds the seed map (including each
   repository's trusted sensitivity), which the agent can never read or modify,
   and it keeps a ledger **separate** from bounded queries. When the primary
   agent itself runs under `containerRuntime: "sbx"`, AWF first probes whether
   the microVM's filesystem passthrough can bind the broker's Unix socket
   directly; when it cannot, the broker instead listens on a dedicated Docker
   `internal` network with one ephemeral port published only on the Docker
   host-gateway address, and the agent is given only the endpoint plus a
   random, single-run capability token proven reachable before the agent
   starts (see [Primary-agent and bounded-agent runtime
   matrix](#primary-agent-and-bounded-agent-runtime-matrix)).

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
| `runtime` | `docker` | `docker` or `gvisor`. `sbx` is accepted by the schema but remains capability-blocked (see below). |
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
- the **primary agent** runtime is actually available (`docker`, `runsc`
  registration for `gvisor`, or a proven sbx ingress path for `sbx` — see
  [Primary-agent and bounded-agent runtime
  matrix](#primary-agent-and-bounded-agent-runtime-matrix)); a blanket
  rejection of a primary `sbx` runtime is no longer applied — availability is
  proven, not assumed;
- the selected **bounded-agent enclave** runtime is actually available.

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

## `sbx` capability-blocked

`runtime: "sbx"` is accepted by the JSON Schema so configurations can be
written ahead of support landing, but it is **capability-blocked** — never a
blanket "not yet implemented" refusal, and never a false pass. AWF ships a
dedicated bounded-agent sbx capability probe
(`src/bounded-agent/sbx-capability.ts`, mirrored in
`containers/bounded-agent/broker/sbx-capability-probe.js`) that runs the exact
audited Docker Sandboxes CLI (`v0.37.1`) surface — `sbx version`, `sbx create`,
`sbx exec`, `sbx ls --json`, `sbx stop`, and `sbx rm --force` — and reports
every missing capability in structured JSON rather than a single boolean.

The enclave requirement is strictly harder than a bounded query's: an
enclave must reach *exactly one* peer (the dedicated API proxy), not "no
network at all". Current `sbx create` supports `--cpus`, `--memory`, `--name`,
`--template`, and read-only same-path mounts, but does **not** expose the hard
controls AWF requires for a mandatory, enforceable API-proxy-only network
policy (not an advisory `HTTP_PROXY`), PID limits, disk limits, per-file size
limits, or a pinned, digest-verified AWF bounded-agent template/bootstrap.
The probe therefore always reports these as missing and `supported` can never
be `true` for the currently audited version — by design, not by omission.

AWF rejects this runtime before staging or compose assembly, mounts neither
the Docker socket nor any sbx daemon credential, and the broker's
`SbxEnclaveRunner` throws immediately if ever invoked. Support remains blocked
until sbx provides enforceable versions of all controls and AWF publishes a
digest-pinned, standard-library-only bootstrap for the enclave — the same
promotion bar as bounded queries.

## Primary-agent and bounded-agent runtime matrix

The primary agent and the bounded-agent enclave are separate sandbox
decisions, each with its own availability proof:

- `container.containerRuntime` / `--container-runtime` selects the **primary
  agent** runtime.
- `boundedAgents.runtime` selects the **single-use enclave** runtime.

The broker never reuses the primary agent sandbox. Every accepted invocation
creates a new container with a unique run identity and destroys it before
returning. No combination ever falls back to a weaker or different backend.

| Primary agent | Docker enclave | gVisor enclave | sbx enclave |
|---|---|---|---|
| Docker | Supported when Docker is available | Supported when `runsc` is registered | **Blocked** by mandatory sbx enclave probes |
| gVisor | Supported when the primary `runsc` runtime is available | Supported when `runsc` is registered | **Blocked** by mandatory sbx enclave probes |
| sbx | Supported when primary sbx ingress (Unix passthrough or authenticated `sbx-http`) is proven | Supported when primary sbx ingress and `runsc` are proven | **Blocked** by mandatory sbx enclave probes |

"Supported" is capability-dependent, not an instruction to downgrade. An
unavailable primary runtime fails at primary preflight, before any repository
is staged. An unavailable enclave runtime fails at enclave preflight, for the
same reason. Selecting `"runtime": "sbx"` for the enclave is an explicit,
still-experimental gate; the additional executable capability proof must also
pass. With Docker Sandboxes `v0.37.1`, all three sbx-enclave cells remain
blocked — six of the nine combinations are supported once the relevant
runtime(s) are proven available, and the three `sbx`-enclave cells are not.

`src/bounded-agent/runtime-matrix.ts` evaluates all nine combinations
independently (`primaryBackend` × `boundedAgentBackend`) and records
`lifecycleClass`, `capabilityState`, and `category` per cell for telemetry —
never the task, repository name, or provider payload.
`scripts/ci/report-bounded-agent-runtime-matrix.js` renders the same matrix
from live host probes for CI/local use; it reports an explicit `BLOCKED`
result (and exits non-zero under `--require`) rather than a false pass when no
real sbx binary is present.

Examples of independent selection:

```json
{ "container": { "containerRuntime": "sbx" },
  "boundedAgents": { "enabled": true, "runtime": "docker", "model": "gpt-4o-mini",
  "privateRepos": [{ "repo": "my-org/private-service", "sensitivity": "internal" }] } }
```

### Troubleshooting runtime selection

| Symptom | Meaning | Action |
|---|---|---|
| `runsc ... not available; no fallback` | The gVisor enclave backend is not registered with Docker | Register `runsc`, verify it appears in `docker info --format '{{json .Runtimes}}'`, and rerun |
| `sbx ... blocked ... mandatory` capability error | The sbx enclave capability probe failed as designed | Read the complete missing-capability list; do not substitute local policy or a weaker runtime |
| sbx primary ingress probe fails | The primary VM cannot reach the broker through either proven ingress | Verify sbx Unix passthrough or authenticated `sbx-http` ingress; the agent must not start |
| Docker host must be `unix://` | The networkless broker cannot reach a TCP daemon | Use a local Unix socket; AWF will not attach the broker to a network |
| `bounded agents cannot be combined with enableDind` | Docker-socket exposure to the primary agent would bypass every finite-disclosure boundary | Disable `enableDind`; there is no runtime combination in which this is safe |
| Matrix report says `BLOCKED` | Capability or security preflight prevented launch | Treat this as expected fail-closed status, not successful runtime execution |

Run `node scripts/ci/report-bounded-agent-runtime-matrix.js` after `npm run
build` to print all nine local capability results. Use `--require
docker/docker` (or another pair) when a smoke job must require one executable
combination.

### sbx enclave promotion criteria

The experimental sbx enclave backend MUST remain blocked until all of these are
demonstrated in real VMs, not only deterministic fakes:

1. A digest-pinned AWF bounded-agent template/bootstrap exists.
2. A mandatory, enforceable API-proxy-only network policy is available and
   enforced by the sbx runtime itself — not an advisory `HTTP_PROXY` env var,
   and not organization-level network policy that can be replaced.
3. CPU, memory, PID, aggregate disk, and per-file size limits are enforceable.
4. Read-only seed/task/schema/result mounts have explicit guest targets and
   expose no broker state, credentials, sibling repository, or prior
   invocation.
5. Timeout, OOM, PID, disk, file-size, malformed/oversized output, and
   interruption cleanup tests all pass.
6. Unix and authenticated `sbx-http` primary ingress retain byte-identical
   protocol behavior.
7. Direct and lateral reachability to anything other than the dedicated API
   proxy is proven denied, not merely unconfigured.

Passing a version check alone, or passing only the CLI help probe, is not
enough to promote the backend.

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
