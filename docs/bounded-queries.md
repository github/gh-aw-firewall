# Bounded Queries

Run narrow, brokered Python scripts against private repositories without
exposing repository contents to the primary agent.

A **bounded query** lets an agent ask a trusted broker to run a short, agent-authored Python 3 script against a private repository and get back a single value conforming to a finite schema the agent declares up front -- without the agent ever seeing repository contents, receiving diagnostic output, or gaining network access to the repository.

The feature is config-only: there are no `--bounded-queries-*` CLI flags. Everything is expressed in the AWF JSON configuration file.

## Use cases

Bounded queries are designed for **bounded, answerable questions** about a private repository where the question and its full range of answers can be expressed as a finite schema.

**Good uses**

- "Does this repository contain a `SECURITY.md` at the root?" -- boolean, 1 bit of payload
- "How many Python files are in `src/`?" -- bounded integer with a known upper limit
- "Which license identifier is declared: MIT, Apache-2.0, GPL-3.0, or something else?" -- small enum
- "Is the `requires-python` minimum in `pyproject.toml` at least 3.10?" -- boolean
- "Do both repositories declare the same major API version in their manifest?" -- each queried separately; answers compared by the agent after two queries

**Not suited for**

- Extracting source code, documentation, or any variable-length text -- unbounded strings are structurally impossible in the schema DSL
- Arbitrary repository exploration or browsing
- Tasks where the answer space cannot be described by a finite schema before the query runs
- Repositories marked `sealed` (0-bit budget) -- these can never fund even the cheapest query

:::note
Bounded queries bound *quantity* of information revealed, not *semantics*. Classifying a repository's sensitivity level is an operator responsibility; the feature enforces the declared limit but cannot validate that the classification is correct.
:::

## Architecture

The trust boundary operates in four stages:

1. **Trusted host staging.** Before any container starts, AWF clones each configured repository using `GH_TOKEN`/`GITHUB_TOKEN`, strips all credentials, remotes, hooks, and write bits from the resulting seed, and records the resolved commit in trusted staging metadata. Submodules and gitdir pointers are rejected. The staging credential is scrubbed after this phase and never reaches the broker or agent.

2. **Trusted broker over Unix socket.** A dedicated `awf-bounded-query-broker` container with `network_mode: none` serves requests over a Unix socket mounted into the agent. It receives no network, no Squid proxy, and no external bridge. Its only connections are the Unix socket and the Docker socket (agent-invisible), used to launch queries. The broker holds the seed map -- including each repository's trusted sensitivity -- which the agent can never read or modify.

3. **Fresh, no-network query sandbox.** For each accepted request the broker creates a private writable copy of exactly one seed, then launches a single-use container with no network, a read-only root filesystem with bounded writable tmpfs mounts at `/tmp` and `/query`, no capabilities, a restrictive seccomp profile, and fixed memory, CPU, PID, and timeout limits. The agent-authored script runs at `/awf/query-script.py` and must write its result to `/query/out`. Stdout, stderr, and exit status are discarded.

4. **Canonical finite result and cleanup.** After the script exits, the broker validates the result file against the declared schema using a non-backtracking hand-written parser, re-serializes the canonical form, tears down the workspace, then -- only after cleanup completes -- selects the timing bucket and responds. The agent receives exactly `{"status":"ok","result":<value>}` or `{"status":"error"}` with nothing else.

## Configuration

Add a `boundedQueries` section to your AWF JSON config file:

```json
{
  "boundedQueries": {
    "enabled": true,
    "privateRepos": [
      { "repo": "my-org/private-service", "sensitivity": "internal" },
      { "repo": "my-org/public-docs",     "sensitivity": "public"   }
    ],
    "runtime": "docker",
    "timeout": 30,
    "memoryLimit": "512m",
    "interpreter": "python3",
    "maxInvocations": 32
  }
}
```

### Field reference

| Field | Type | Constraints | Default |
|---|---|---|---|
| `enabled` | boolean | Only explicit `true` enables the feature; omission normalizes to `false` | `false` |
| `privateRepos` | array | Required non-empty when `enabled: true`; entries must be unique by slug (case-insensitive) | `[]` |
| `runtime` | string | `"docker"` or `"gvisor"` (gvisor requires `runsc` registered with the Docker daemon) | `"docker"` |
| `timeout` | integer | `1`-`540` seconds; the final 60 seconds before the 600-second bucket boundary are reserved for termination, validation, and cleanup | `30` |
| `memoryLimit` | string | Docker memory format, e.g. `"512m"`, `"1g"` | `"512m"` |
| `interpreter` | string | Only `"python3"` is currently supported | `"python3"` |
| `maxInvocations` | integer | `1`-`10000`; an independent operational cap unrelated to per-repository bit budgets | `32` |

**`privateRepos` entry format.** Each entry must be an object:

```json
{ "repo": "owner/repo", "sensitivity": "internal" }
```

The `sensitivity` value must be `public`, `internal`, `confidential`, or `sealed`. The `repo` value must be a bare `owner/repo` slug with no scheme, host, path traversal, query string, fragment, wildcard, or extra path segments.

**Legacy bare strings.** For one release, a bare `"owner/repo"` string is accepted and normalized to `{ "repo": "...", "sensitivity": "internal" }` with a warning. New configuration should always use the object form so the intended sensitivity is explicit.

**Disabled behavior.** When `enabled` is `false` or the section is absent, AWF stages nothing, starts no broker, mounts no socket, sets no environment variable, installs no CLI, and generates no skill.

**Preflight failures** (all fail before the primary agent starts): `privateRepos` is empty, contains an invalid slug, or has duplicates; `runtime` is `"gvisor"` and `runsc` is not registered; the container runtime is a microVM backend (which cannot receive Compose bind mounts); the Docker host is not a `unix://` socket; `timeout` exceeds 540; no staging credential is present; or any seed cannot be materialized and verified.

## Sensitivity categories

Every repository carries a fixed sensitivity that sets an immutable maximum number of bits the broker may reveal about that repository across the entire AWF run. The budget is per-run only; the broker has no durable state across runs.

| Sensitivity | Run budget | Notes |
|---|---|---|
| `public` | unmetered | Responses are never debited against a ledger, but are still schema- and operationally bounded |
| `internal` | 64 bits/run | Default for legacy bare-string entries |
| `confidential` | 8 bits/run | |
| `sealed` | 0 bits/run | Can never fund even the cheapest query; seed is staged and validated but Python is never launched |

The minimum charge for any single invocation is 4 bits (see [information charge](#information-charge)), so a `confidential` repository can fund at most two questions before its budget is exhausted, and a `sealed` repository can never be queried.

Sensitivity is set in AWF configuration only. The generated skill advertises each configured repository's sensitivity and initial run budget so the agent can design an affordable schema. A request cannot supply or override sensitivity, and the broker never exposes the remaining ledger balance.

## Information charge

Every accepted invocation is charged from its repository's run budget **before** any seed is copied or Python is launched. The charge is never refunded regardless of outcome.

```
charge = 1                          (ok/error distinction is itself observable)
       + ceil(log2(cardinality))    (the declared response schema)
       + 3                          (six timing buckets; ceil(log2(6)) = 3)
```

**Cardinality** is the number of distinguishable values the schema admits: 1 for `const`, 2 for `boolean`, N for an N-member `enum`, `max - min + 1` for `integer`, the product of field cardinalities for `object`/`tuple`/`array`, the sum of variant cardinalities for `union`. Cardinality is computed with `BigInt` arithmetic so it cannot overflow.

**Cost examples**

| Schema | Cardinality | charge |
|---|---|---|
| `{"type":"const","value":42}` | 1 | 1 + 0 + 3 = **4 bits** |
| `{"type":"boolean"}` | 2 | 1 + 1 + 3 = **5 bits** |
| `{"type":"enum","values":["MIT","Apache-2.0","GPL-3.0","unknown"]}` | 4 | 1 + 2 + 3 = **6 bits** |
| `{"type":"integer","minimum":0,"maximum":255}` | 256 | 1 + 8 + 3 = **12 bits** |

An `internal` repository with a 64-bit budget can fund 12 consecutive boolean questions (60 bits), leaving 4 bits for one `const` question. If every query uses a `const` schema, it can fund 16 questions.

`maxInvocations` is a separate, independent operational limit. It counts every response -- including those rejected by schema validation, budget exhaustion, or malformed requests -- and is unrelated to the bit ledger.

## Timing buckets

Query response latency is itself a side channel: a script that exits early on one code path and runs longer on another leaks information through wall-clock time. The broker makes every launched invocation's observable response time land on one of six fixed boundaries:

| Bucket | Boundary |
|---|---|
| 1 | 10 ms |
| 2 | 100 ms |
| 3 | 1 s |
| 4 | 10 s |
| 5 | 60 s |
| 6 | 600 s |

The broker returns at the first bucket boundary at or after processing (execution + validation + container removal + workspace teardown) actually completes. Container and workspace cleanup are included in the measurement, so cleanup duration cannot be observed as a separate residual channel.

**Scheduler tolerance.** A public 5 ms tolerance covers ordinary timer jitter. If a timer wakes more than 5 ms late or the selected boundary has already passed, the broker re-resolves to the next fixed boundary rather than responding at the late, continuously varying time.

**Timing overflow.** If pathological infrastructure pushes total processing past the last bucket (600 s), the broker discards the result -- even a successful one -- and returns the canonical error. The 540-second timeout cap exists to preserve the final 60 seconds of the last bucket for cleanup.

The three timing bits are charged as part of every accepted invocation's budget because latency alone is observable.

## Agent interface

When bounded queries are enabled a Compose agent receives:

- A Unix socket directory (read-write) mounted at `$AWF_BOUNDED_QUERY_SOCKET`
- A generated skill and `bounded-query` executable in one read-only directory
- `AWF_BOUNDED_QUERY_REPOS` -- a comma-separated list of configured repo slugs

An sbx primary agent is probed before staging to determine whether its
filesystem passthrough supports connecting to a host Unix socket. When it does,
the same Unix protocol is used. Otherwise the broker listens on a dedicated
Docker `internal` network with one ephemeral port published to `127.0.0.1`;
sbx reaches that host-loopback service through `host.docker.internal`. The
agent receives only the endpoint and a random per-run capability. The
capability is not written to the generated skill, Compose/audit artifacts,
query environments, or logs. A one-shot pre-agent probe proves the selected
path is reachable; failure aborts before the primary agent starts.

The sbx transport uses the same `/query` framing, body/header caps, canonical
response bytes, serialized scheduler, timing buckets, and protected audit
semantics as the Unix transport. It has no health or diagnostic route.
Authentication failures return the same canonical error as every other
failure. The broker remains absent from `awf-net` and `awf-ext`; its dedicated
network is internal and has no outbound route.

The generated skill lists each repository's configured sensitivity and initial run budget. It does not expose the broker's remaining ledger balance.

GitHub tokens are removed from the agent environment whenever bounded queries are enabled, independently of the API and CLI proxies.

The `bounded-query` command is installed on the agent's `PATH` and is the only supported way to invoke a query.

### Invoking the `bounded-query` command

```
bounded-query --repo <owner/repo> --schema '<json>' < script.py
```

- `--repo` must appear exactly once. The value must be a valid `owner/repo` slug matching a configured repository.
- `--schema` must appear exactly once. The value is a JSON document (at most 4096 bytes) conforming to the finite schema DSL.
- The query script arrives on **stdin**. Interactive terminals are rejected.
- Any other flag, the `--flag=value` form, and positional arguments are rejected without contacting the broker.

The command always prints exactly one canonical JSON line to stdout, writes nothing to stderr, and exits with status 0 -- for both outcomes and for every failure, including transport failures.

### Practical example

Ask whether a repository contains a `SECURITY.md` at its root. Schema cardinality is 2, charge is 5 bits from the repository's run budget.

```bash
bounded-query \
  --repo my-org/private-service \
  --schema '{"type":"boolean"}' \
  <<'EOF'
import json, os

result = os.path.isfile('/query/repo/SECURITY.md')
with open('/query/out', 'w') as f:
    json.dump(result, f)
EOF
```

On success:

```json
{"status":"ok","result":true}
```

On any failure (invalid repo, exhausted budget, script crash, timeout, non-conformant output, etc.):

```json
{"status":"error"}
```

**Query environment.** The script runs as an unprivileged user (uid 65534) with no network and a read-only filesystem, except for `/query`. The repository tree is at `/query/repo/`. The script must write exactly one JSON value conforming to the declared schema to `/query/out`. Stdout and stderr are discarded and never reach the agent.

## Finite response schema DSL

The schema the agent declares is a closed algebra -- not general JSON Schema. Supported node types:

| Type | Shape | Cardinality |
|---|---|---|
| `const` | `{"type":"const","value":<literal>}` | 1 |
| `boolean` | `{"type":"boolean"}` | 2 |
| `enum` | `{"type":"enum","values":[<literal>,...]}` | number of members |
| `integer` | `{"type":"integer","minimum":N,"maximum":M}` | M - N + 1 |
| `object` | `{"type":"object","fields":{"name":<schema>,...}}` | product of field cardinalities |
| `tuple` | `{"type":"tuple","items":[<schema>,...]}` | product of item cardinalities |
| `array` | `{"type":"array","items":<schema>,"length":N}` | item cardinality to the power N |
| `union` | `{"type":"union","variants":{"tag":<schema>,...}}` | sum of variant cardinalities; value is `{"tag":"<name>","value":<...>}` |

A literal (used in `const` and `enum`) must be a string (at most 64 bytes UTF-8, no control characters), a safe integer, a boolean, or `null`. All `enum` values must share the same JSON type and must be unique.

There is no way to express an unbounded string, a float, a regex, recursion, `$ref`, an optional field, `additionalProperties`, or an untagged/overlapping union. These are structurally impossible to write in the DSL, not merely rejected by a validator.

### Schema size limits

| Bound | Value |
|---|---|
| Max serialized schema size | 4096 bytes |
| Max nesting depth | 6 |
| Max total schema nodes | 64 |
| Max `enum` values | 4096 |
| Max `object` fields | 16 |
| Max `tuple` items | 16 |
| Max fixed `array` length | 64 |
| Max `union` variants | 16 |
| Max literal string length | 64 bytes |

In practice the 4096-byte size limit is the binding constraint for wide `enum` or `object` schemas well before the count limits are reached.

### Validation and canonicalization

The schema is validated **before** the broker copies a seed or launches Python. If the schema is structurally invalid the request is rejected immediately (canonical error) without touching the repository.

After the script exits, the result file is parsed with a non-backtracking hand-written parser that rejects malformed JSON, duplicate object keys, leading or trailing content, and invalid UTF-8. The parsed value is then validated against the exact declared schema. A value that passes is canonically re-serialized before being wrapped in the response envelope -- the exact byte layout written by the query (whitespace, key order) never reaches the agent.

## Failure semantics

All failure modes collapse to a single canonical response:

```json
{"status":"error"}
```

Failures that map to this response include: invalid request format, schema validation failure, repo not in `privateRepos`, exhausted bit budget, exhausted `maxInvocations`, query launch failure, timeout, script crash, non-conformant output, timing-bucket overflow, and internal broker errors.

Failures are indistinguishable from each other by design: the agent cannot infer which failure mode occurred from the response alone.

`maxInvocations` counts **every** response, including rejected requests. It is a separate operational limit unrelated to per-repository bit budgets. Once exhausted, all further requests return `{"status":"error"}` without consulting the bit ledger.

Failure details (with protected labels such as `repo-not-allowed`, `bit-budget-exhausted`, `invalid-request`, `launch-failed`, `timing-bucket-overflow`, and `cleanup-failed`) are written only below the dedicated broker-private root (`/var/tmp/awf-bounded-query-private-<uid>-<digest>/audit/`). The root is rejected before staging if realpath-aware preflight finds any overlap with a Compose, gVisor, or sbx agent mount. They are never returned to the agent.

## Security limitations

Bounded queries provide a **quantitative information bound**, not a semantic approval of disclosed content:

- The bit budget limits how many bits of signal the broker may reveal, not whether any particular fact is sensitive.
- Timing is included in the charge and bucketed, but six bucket outcomes are still observable (3 bits). Repeated queries can reveal additional bucket outcomes, and each accepted invocation pays that timing charge.
- Agent-authored code is arbitrary Python within the sandbox. The sandbox enforces isolation, but a query can compute and express any value that fits the declared schema.
- `public` repositories are unmetered. The schema and operational limits (`maxInvocations`, timeouts, sandboxing) still apply, but there is no bit ledger to exhaust.
- Budgets reset each AWF run. The broker has no durable identity or storage across runs.
- Classifying a repository's sensitivity level is an operator responsibility. Selecting a less restrictive category with a larger budget than warranted undermines the bound the feature provides.

## See also

- [Security Architecture](/gh-aw-firewall/reference/security-architecture) - Firewall trust model and isolation layers
- [AWF config spec section 14](https://github.com/github/gh-aw-firewall/blob/main/docs/awf-config-spec.md#14-bounded-queries) - Normative specification with full field constraints, protocol details, and staging implementation notes
