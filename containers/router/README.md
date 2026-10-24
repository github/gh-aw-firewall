# gh-aw-router

gh-aw-router picks the model for a software task. It builds a provider-neutral classification
prompt, then ranks the exact model choices a caller offers using a routing table compiled
offline. It never calls a provider, executes an agent, fits a model, or stores request history.

The router is a single Go binary. Apart from the optional OpenTelemetry SDK, it uses only the
standard library. AWF runs it as a sidecar from the image this directory builds. Training,
benchmark evidence, and publication tooling are maintained separately and are not needed to
build or run it.

## Build and run

The router is one Go `main` package in this directory, and `go.mod` pins the toolchain. Shell
examples use Bash syntax and run from this directory. The server runs in the foreground, so use
another terminal for client commands.

```bash
go build -o gh-aw-router .
./gh-aw-router --routing-tables routing validate-data
./gh-aw-router --routing-tables routing serve --bind 127.0.0.1:8737
```

Pass `-o`, because a plain `go build` names the binary `router`, after this directory.

Use trusted tables and keep them read-only. Tables are validated at startup, and replacing them
requires a restart.

## CLI

`classify` and `route` read JSON from standard input or from `--input PATH`. The routing-tables
option is global and must precede the command.

```bash
./gh-aw-router --routing-tables routing classify --input examples/classify-request.json
./gh-aw-router --routing-tables routing route --input examples/route-request.json
```

Command-line options override environment variables, which override defaults. An empty
environment variable counts as unset.

| Option | Environment variable | Default |
| --- | --- | --- |
| `--routing-tables` | `GH_AW_ROUTER_ROUTING_TABLES` | `./routing`, if it exists |
| `serve --bind` | `GH_AW_ROUTER_BIND` | `127.0.0.1:8737` |
| `serve --log-level` | `GH_AW_ROUTER_LOG_LEVEL` | `info` |
| `healthcheck --url` | | `http://127.0.0.1:8737/healthz` |

The routing path may be a directory, which loads every table in it, or a single file, which
serves that one profile. Relative paths resolve from the current working directory. Bind to
another interface only on a trusted private network. The container binds to all of its own
interfaces. The bind port must be ASCII digits from 1 through 65535, and the log level is one of
`critical`, `error`, `warning`, `info`, `debug` or `trace`.

Results go to stdout and errors to stderr. Exit statuses are `0` for success, `2` for invalid
input, invalid table data, file errors, or argument errors, and `3` when routing finds no
eligible model. `--help` and `--version` exit successfully without loading a table.

`healthcheck` sends `GET` to its URL and exits 0 only on a 204. Any other status, a refused
connection or the 1 s timeout exits 1 with one line on stderr. It never uses a proxy or follows
a redirect, and it doesn't load routing tables, so `--routing-tables` doesn't affect it.

## HTTP API

The authoritative contract is [openapi.yaml](openapi.yaml). Its document version follows the
router release. Use the matching document for validation and client generation. The service does
not serve a generated `/openapi.json`, `/docs`, or `/redoc`.

- `GET /healthz` for readiness
- `GET /capabilities` for the router release, served routing profiles, models, and efforts
- `POST /classify` for a classification prompt and ranked classifier choices
- `POST /route` for ranked task-model choices

Classification and routing return ranked choices drawn only from the supplied candidates.
Routing ignores model-effort pairs absent from the table and returns `no_route` when no
supported, context-eligible choices remain. Unsupported objectives and malformed requests
are still rejected. Neither operation calls a provider or invents a fallback choice.

Both planning requests require a `conversation` holding at least one user message with
nonblank text. Requests contain only decision inputs. The caller retains execution
identity for accounting and outcome correlation. The router stores no task history.
Remove `repository` and `task_id` from older client requests. Both fields are rejected,
not ignored. Routing-table `repository` metadata is separate and remains unchanged.

Requests do not negotiate an independent API version. When updating an older client, remove
`api_version` from requests and stop expecting `api_versions` in capabilities. The removed
request field is rejected, not ignored. Test the client, OpenAPI document, contract fixtures,
and immutable router image together. Update them together when adopting a changed contract.
Keep the previous tested image for rollback rather than assuming any newer image is compatible.
The reported release is diagnostic metadata, not proof of an image's identity.

Application errors use a `code` and `detail` envelope, including unknown paths and unsupported
methods. Schema violations name the failing fields without echoing submitted values. See
[Serving](#serving) for the request limits. Clients must also handle connection failures and
enforce their own timeouts.

Classification follows the table's embedded `classification_choices` list and prefers its first
eligible offered choice. Routing filters the table's ordered identities against the request. Both
operations preserve the caller's exact choices. Models with effort settings are eligible only
with an explicit supported effort. Classification rejects omitted efforts for these models,
while routing skips those choices. Omit effort only for models without effort settings. The
string `"none"` is an explicit effort, not an omission. The service never infers effort settings.
Routing uses `classification.labels` when supplied. When `classification` is omitted or null,
deterministic heuristics infer task type and scope from the last authored user message and
leave complexity unknown. Every uninferred field remains `unknown`. For example, `Proceed.`
uses all three unknown labels, while `Fix this function.` infers `fix` and `local` but leaves
complexity unknown. The eligible choices still follow that table cell's ranking.

### Examples

The [classification request](examples/classify-request.json) and
[routing request](examples/route-request.json) are complete JSON examples. With the local
server running, submit them directly.

```bash
curl --fail-with-body --silent --show-error \
  --header 'Content-Type: application/json' \
  --data-binary @examples/classify-request.json \
  http://127.0.0.1:8737/classify

curl --fail-with-body --silent --show-error \
  --header 'Content-Type: application/json' \
  --data-binary @examples/route-request.json \
  http://127.0.0.1:8737/route
```

`/classify` returns `system_prompt`, `prompt`, and `ranked_choices`. The classifier call uses
`system_prompt` as its only system or developer instruction and `prompt` unchanged as the user
message, with no tools. Its expected output has this shape, defined by
`x-gh-aw-router-classifier-output-schema` in the OpenAPI document.

```json
{
  "labels": {
    "task_type": "fix",
    "scope": "local",
    "task_complexity": "medium"
  },
  "mode": "robust"
}
```

Forward the validated classifier output unchanged in `/route`'s `classification` field,
as the routing example does. `/classify` itself returns a call plan, not this inferred result.
The caller runs the classifier and passes its output to `/route`.
Successful classification plans always contain at least one eligible choice.
If no offered classifier choice is supported, `/classify` returns `422 no_route`.
An empty successful ranking is not a signal to continue without classification.
Before executing a plan, the caller must check the complete generated messages against
the classifier model's context capacity, including output and reasoning allowance.
Prompt escaping can expand the input. The HTTP request-size limit does not prove fit.

Set `objective.mode` to `"auto"` to use `classification.mode`, which recommends `economy`,
`balanced`, or `robust`. Auto falls back to `balanced` when `classification` is omitted or
null, or its mode is `unknown`. If classification fails, omit it or send null. A supplied
classification must include valid `labels` and `mode` fields or the request is rejected.
The caller must parse and validate raw classifier output, including invalid JSON, fenced
responses, and schema violations. The router does not repair that output or decide whether
caller policy permits continuing after a failure. This fallback never invents a middle-ranked
model or a default reasoning effort. Context exclusions and missing-profile errors still apply.

An explicit `economy`, `balanced`, or `robust` objective mode always takes precedence over
the classifier's mode. The goal remains the caller's choice of `cost` or `cost-speed`.
`/route` returns exact offered choices in preference order with the same response shape
for automatic and explicit modes.

```json
{
  "ranked_choices": [
    {
      "id": "openai-sol-medium",
      "model": "openai/gpt-5.6-sol",
      "effort": "medium"
    },
    {
      "id": "copilot-luna-medium",
      "model": "github-copilot/gpt-5.6-luna",
      "effort": "medium"
    }
  ]
}
```

Supplying `current_id` places that offered choice first while it remains eligible. For each
routing candidate with a `context_window` in tokens, eligibility uses a character-count
estimate plus 16,000 tokens of headroom. Omitting `context_window` skips that candidate's
context check. This estimate is not a provider tokenizer and does not replace enforcement
of the provider's actual context limits.

### Serving

`serve` loads and validates the tables (exit 2 on failure), checks the bind address (exit 2),
then listens (exit 1 if that fails). It uses Go's `net/http` server with these limits:

- At most 64 requests are in flight, `/healthz` included. Further requests get a bare 503.
- A body whose `Content-Length` is over 1,048,576 bytes gets 413 `payload_too_large` on any
  path. A chunked body is counted as `/route` and `/classify` read it, and gets the same 413
  once it passes the limit. Other paths answer without reading the upload.
- Headers must arrive within 10 s, and the whole request within 30 s. The response must be
  written within 30 s, and an idle keep-alive connection closes after 5 s. A request past
  these limits has its connection closed.
- Framing errors, paths that aren't clean (`//healthz` redirects to `/healthz`) and `OPTIONS *`
  are handled by `net/http` before the router sees them.

On SIGTERM or SIGINT the server stops accepting connections, lets in-flight requests finish for
up to 0.5 s, closes the rest and exits 0. With [telemetry](#telemetry) on, it drains for up to
0.25 s and then flushes telemetry for up to 0.5 s, so that it still exits within the 1 s AWF
allows before SIGKILL.

`serve` writes one JSON object per line to stderr, and nothing else once its arguments are
parsed. Usage errors stay plain text. Every record has `time` (RFC 3339 UTC with milliseconds),
`level`, `msg`, `service` (`gh-aw-router`) and `version`. The other fields are:

| `msg` | Level | Fields |
| --- | --- | --- |
| `starting` | INFO | `bind`, `log_level`, `go_version` |
| `routing tables loaded` | INFO | `tables_path`, `profiles`, `models`, `label_cells` |
| `routing tables invalid` | ERROR | `error_code` (`invalid_model_data`), `error` |
| `configuration invalid` | ERROR | `error_code` (`invalid_request`), `error` |
| `telemetry setting invalid` | WARN | `variable`, `effect` (`traces disabled`, `metrics disabled`, `traces and metrics disabled`, `ignored` or `other keys ignored`) |
| `telemetry configured` | INFO | `traces` and `metrics` (`enabled` or `disabled`); with either on, `protocol`, and `traces_endpoint` or `metrics_endpoint` for each enabled signal |
| `listening` | INFO | `address` |
| `listen failed` | ERROR | `error` |
| `request` | INFO, or ERROR for a status of 500 or above | `request_id`, `method`, `route`, `status`, `duration_ms`, `error_code` (error envelopes only), `request_bytes`, `response_bytes`, `trace_id` and `span_id` (see [Telemetry](#telemetry)) |
| `panic` | ERROR | `request_id`, `route`, `stack` |
| `telemetry error` | WARN | `signal` (`traces`, `metrics` or `sdk`), `reason` (`HTTP` and the status, `timeout`, `connection refused` or `other`) |
| `shutting down` | INFO | `signal` |
| `telemetry flush incomplete` | WARN | none |
| `stopped` | INFO | `drained` (whether in-flight requests finished in time), `duration_ms` |

`route` is one of the four served paths or `unmatched`, and `method` is a standard HTTP method
or `_OTHER`. `request_id` is random for each request and isn't sent to the client. A successful
`/healthz` call isn't logged. Records never contain request or response bodies, headers, query
strings, unmatched paths, model or choice ids, error details or panic values. The one exception
is `trace_id`, which can come from a valid `traceparent` header. Telemetry records never contain
a setting's value, an endpoint's path, query or user info, or an exporter's error text.

In AWF, these records are the router's only log. At the end of a routed run, AWF stops the router
before its other containers, so that it logs `shutting down` and `stopped`, and saves the
container's whole log as `router-logs/router.jsonl`. That's next to `api-proxy-logs/` in
`--proxy-logs-dir` when it's set, and in `/tmp/router-logs-<timestamp>/` otherwise. Only the user
who ran AWF can read it, and AWF's diagnostic log collection leaves the router out so that no
copy is world-readable. See AWF's
[log file inventory](https://github.com/github/gh-aw-firewall/blob/main/docs/awf-config-spec.md#router-logs).

### Telemetry

The router can export OpenTelemetry traces and metrics over OTLP/HTTP with protobuf encoding.
It's off by default: a signal is on only when it has an endpoint. With no endpoint, the router
starts no telemetry goroutines and makes no network calls, and only its stderr records change.
A setting that is invalid or unsupported never stops the router. It logs `telemetry setting
invalid`, naming the variable but not its value, and turns off the signals it applies to.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | Base URL for both signals. The router adds `/v1/traces` and `/v1/metrics` to its path. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | the base URL | Complete URL for one signal, used as is. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns both signals off. Incoming trace context still reaches the logs. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp` | `otlp` or `none`. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Only `http/protobuf`. `grpc` and `http/json` turn the signal off. |
| `OTEL_EXPORTER_OTLP_HEADERS` | none | Comma-separated `name=value` pairs with percent-encoded values, for example `authorization=Bearer%20token`. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | Export timeout in milliseconds. |
| `OTEL_EXPORTER_OTLP_CERTIFICATE` | the system roots | PEM file of the CA certificates to trust instead of the system roots. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | `always_on`, `always_off`, `traceidratio`, or `parentbased_` and any of those. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | The ratio, from 0 to 1, for the ratio samplers. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds between metric exports. |
| `OTEL_METRIC_EXPORT_TIMEOUT` | `30000` | Metric export timeout in milliseconds. |
| `OTEL_SERVICE_NAME` | `gh-aw-router` | The `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | none | Only `service.namespace` and `deployment.environment.name`. Other keys are ignored with a warning. |

The protocol, headers, timeout and certificate variables also have per-signal forms, such as
`OTEL_EXPORTER_OTLP_TRACES_HEADERS`, which replace the shared setting for that signal. Client
certificates aren't supported. The exporters use `HTTPS_PROXY`, `NO_PROXY` and `SSL_CERT_FILE`
as any Go client does. The SDK reads a few more variables itself, such as
`OTEL_EXPORTER_OTLP_COMPRESSION`, the metric temporality and histogram aggregation preferences,
and the span limits. The resource is `service.name`, `service.version` (the router version,
which can't be overridden), a random `service.instance.id` for each process, the two allowed
attributes and the SDK's name, language and version.

Metrics are cumulative and exported every 60 s by default, and shutdown exports what's left, so a
run shorter than the interval still reports its totals. Set `OTEL_METRIC_EXPORT_INTERVAL` lower
only to see metrics during a run or to keep them if the final flush fails. Spans are exported in
batches every 5 s. Shutdown flushes what's left within 0.5 s, but doesn't wait longer for a slow
collector; if the flush doesn't finish, the router logs `telemetry flush incomplete`. A failing
collector never slows requests: spans queue in memory (up to 2,048, then new spans are
dropped), and export failures are logged as `telemetry error` at most once a minute per signal.
An exporter retries a failed export until its export timeout ends, so a failure is logged when
that timeout ends. An export that shutdown interrupts isn't logged, because the final flush
reports its own result.

**Trace context.** The router reads W3C `traceparent` and `tracestate` and ignores `baggage`. A
valid `traceparent` makes the router's span its child; without one the span is a new root. The
caller's `tracestate` stays on the router's spans, as W3C propagation requires, but is never
logged. The router makes no outbound calls, so it never sends trace context on. The `request`
record gets `trace_id` and `span_id` when the router started a span, even an unsampled one.
Without a router span, such as when tracing is off, a request rejected with a bare 503 or a
`/healthz` call, it gets only the `trace_id` of a valid incoming `traceparent`.

In AWF, the api-proxy sends `traceparent` on each `/capabilities`, `/classify` and `/route`
call, from an `api_proxy.router.<operation>` client span in the workflow's trace. Those client spans,
which also carry the route's goal, mode and validated selection, are exported by the api-proxy
whether or not the router exports anything. See [OTEL Tracing in Sentry](https://github.com/github/gh-aw-firewall/blob/main/docs/otel-sentry.md#model-router-call-spans).

**In AWF.** AWF passes the router only the settings in the table above, and only from
router-specific variables in AWF's own environment: `AWF_ROUTER_OTEL_<NAME>` becomes the router's
`OTEL_<NAME>`, for example `AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT` becomes
`OTEL_EXPORTER_OTLP_ENDPOINT`. Blank values are skipped, other values, including any `$`, are
passed literally, and with none set the router gets no environment and exports nothing. The
shared `OTEL_*` variables in AWF's environment configure only the api-proxy, usually for an
external collector, and never reach the router. The router stays only on AWF's internal
`awf-routing` network, so its collector must be a container attached to that network; it can't
reach the internet or the host, where `localhost` is the router container itself. A certificate
path must exist inside the router image, because AWF mounts nothing into the router. The coding
agent never sees any `AWF_ROUTER_OTEL_*` variable, and the audit and diagnostics copies of the
compose file redact collector headers and endpoint user info. See
[OTEL Tracing in Sentry](https://github.com/github/gh-aw-firewall/blob/main/docs/otel-sentry.md#router-export)
for details.

**Spans.** Each request gets one `SERVER` span named `{method} {route}`, or just `{method}` for
an unmatched path, except `GET /healthz` and requests rejected with a bare 503. Its attributes
are `http.request.method`, `http.route` (matched paths only), `url.scheme`,
`network.protocol.version`, `http.response.status_code` and, for an error, `error.type` (the
error envelope's `code`). A request whose body never arrives has `error.type`
`request_aborted` and no status code. The span's status is `Error` only for a 5xx response or
an aborted request.

A `/classify` or `/route` request whose body decodes also gets an `INTERNAL` child span,
`gh_aw_router.classify` or `gh_aw_router.route`, with these attributes, all prefixed with
`gh_aw_router.`:

- `outcome`: `ok`, `invalid_request`, `no_route` or `internal_error`;
- `conversation.messages` and `models.count`: the number of messages and candidates;
- `prior_turns.included` (classify, when the outcome is `ok`): the earlier turns in the prompt;
- `goal`, `mode`, `resolved_mode` and `classification.present` (route);
- `task_type`, `scope`, `task_complexity` and `mode_recommendation` (route, when the request
  includes a classification);
- `selected.model` and `selected.effort` (route, when the outcome is `ok`): the top choice,
  taken from the loaded execution catalogue, never from the request.

**Metrics.**

| Instrument | Type and unit | Attributes |
| --- | --- | --- |
| `http.server.request.duration` | histogram, `s`, with the semconv advisory buckets | `http.request.method`, `http.route` (matched paths only), `http.response.status_code` (not for aborted requests), `error.type` (errors only; `503` for a bare 503) |
| `gh_aw_router.requests.rejected` | counter, `{request}` | `gh_aw_router.reason`: `overload` or `payload_too_large` |
| `gh_aw_router.planning.outcomes` | counter, `{request}` | `gh_aw_router.operation` (`classify` or `route`) and `gh_aw_router.outcome`; for route, also `gh_aw_router.goal`, `gh_aw_router.mode` and `gh_aw_router.resolved_mode` |

Every attribute value comes from a fixed set, so the number of series is bounded. Metrics never
carry model ids or classifier labels. The histogram's count also counts rejected requests;
`requests.rejected` repeats them under one name, so that load shedding is easy to find and
alert on.

**Privacy.** Spans and metrics never contain conversation text, tool names, inputs or results,
candidate lists or ids, `current_id`, request headers, query strings, unmatched paths, prompts
or error details. A model id appears only as `selected.model`, and only when it's in the loaded
catalogue.

## Routing tables

`routing/` holds one file per published profile, named `{goal}-{mode}.json` for the goals `cost`
and `cost-speed` and the modes `economy`, `balanced`, and `robust`. Each file contains the
ordered provider/model or provider/model-effort identities for every label cell and a separate
classifier ranking. Prices, benchmark evidence, fitted parameters, and provider credentials stay
outside the runtime package.

The service loads every table it is given and picks one per request from `objective.goal` and
the resolved mode. Auto is a selection rule, not a separate table profile. `/capabilities`
lists only the fixed profiles that are loaded. For all automatic choices to work, load the
three mode tables for each supported goal. The bundled `routing/` directory contains all six.

A resolved profile that is not served fails with `invalid_request`, including when the
balanced fallback table is missing. An inferred `robust` mode never silently becomes
`balanced` because a table is unavailable. Single-file deployments work only when the
resolved profile matches that file.

Tables loaded together must agree on their repository, model catalogue, and classifier
order, so they differ only in their routing order. Select a directory or a single file with
`--routing-tables` or `GH_AW_ROUTER_ROUTING_TABLES`, and mount or publish generated tables
read-only.

Only `schema_version` 1 is supported, and the loader rejects any other value. A table declares
one fixed `cost` or `cost-speed` profile and carries no default-effort aliases. This format
marker remains independent because tables can be supplied through a file or mount without
replacing the router image.

[schemas/routing-table.v1.schema.json](schemas/routing-table.v1.schema.json) specifies the
table file format as a JSON Schema. The loader also enforces rules that relate parts of a table
to each other, which the schema can't express: every label cell appears in exactly one ranking
group, every ranking and the classifier order are permutations of the first group's choices,
no two groups have the same ranking, and a model listed with explicit efforts isn't also listed
without one. The schema requires `schema_version`, which the loader defaults to 1 when it's
missing.

A published schema file never changes. A format change adds a new schema file, such as
`routing-table.v2.schema.json`, and bumps `schema_version`. Every table must validate against
the schema for its `schema_version`.

## Container

Build from this directory. The Docker build context is self-contained.

```bash
docker build \
  --build-arg OPENAPI_SHA256="$(sha256sum openapi.yaml | cut -d ' ' -f 1)" \
  --tag gh-aw-router:dev .
```

The builder stage cross-compiles, so a multi-platform build needs no emulation. The build fails
unless `OPENAPI_SHA256` matches `openapi.yaml`, and unless the optional `VERSION` build argument
matches the `version` constant in `main.go`, so the image labels can't disagree with the
binary.

Each AWF release publishes the image for `linux/amd64` and `linux/arm64` as
`ghcr.io/github/gh-aw-firewall/router:<awf-version>`, signed with cosign and with an attested
SPDX SBOM. The tag is the AWF version, while the image's version label stays the router version.

The image is built `FROM scratch`. It holds only the static binary at
`/usr/local/bin/gh-aw-router`, the bundled tables under `/routing`, `openapi.yaml` and a CA
bundle filtered by AWF's CA distrust policy in `trust/`, and has no shell. It serves all six
profiles, runs as user `10001:10001`, and needs no credentials or outbound network. It sets
`GOMAXPROCS=2` and `GOMEMLIMIT=384MiB` to fit AWF's 512 MiB container limit. This invocation
uses a private network, a read-only filesystem, and no published host port. The service
listens on port `8737` inside the network.

```bash
docker network create --internal gh-aw-routing

docker run --detach \
  --name gh-aw-router \
  --network gh-aw-routing \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  gh-aw-router:dev
```

Only trusted clients such as the API proxy belong on this network, not the coding agent.
`GET /healthz` returns `204` when ready, and `GET /capabilities` describes the loaded profiles.
To replace the bundled tables, add these options before the image name.

```bash
--mount type=bind,src=/trusted/routing,dst=/mnt/routing,readonly \
--env GH_AW_ROUTER_ROUTING_TABLES=/mnt/routing
```

Like AWF's other images, the image declares no `HEALTHCHECK`. AWF's compose configuration runs
`/usr/local/bin/gh-aw-router healthcheck` as an exec-form check. To check health yourself, use
the same exec form, such as `docker exec gh-aw-router /usr/local/bin/gh-aw-router healthcheck`
or a compose `test: ["CMD", "/usr/local/bin/gh-aw-router", "healthcheck"]`. `docker run
--health-cmd` always runs its command through `/bin/sh`, which the image doesn't have.

AWF's release workflow, `.github/workflows/release.yml`, publishes the image together with the
other AWF images and lists its digest in the release's `containers.txt`. A deployment pin has
the form `ghcr.io/github/gh-aw-firewall/router:<awf-version>@sha256:<manifest-digest>`.
A local image ID or Docker archive checksum is not that registry manifest digest. Deliver
security fixes through new AWF releases and tested client pin changes, not replacement bytes
under old pins.

## Test fixtures

[The routing-contract corpus](testdata/routing-contract) covers all four endpoints using
synthetic model identities and six distinguishable table profiles. Each case names the method,
path, expected status, optional headers and a complete request; default to
`Content-Type: application/json` when headers are omitted. `raw_request` marks malformed JSON,
and `request_valid: false` marks a schema-invalid object. The test-only `response_file`
reference shares an exact classifier response between cases. A 204 response has no body.

A case's optional `profiles` list restricts the table files loaded. Otherwise load all six.
Compare successful responses exactly, including choice order, effort omission, and prompt
strings. For errors, compare status and the stable `code`; `detail` is diagnostic text, not a
promise. The Go tests build the six tables in `corpus_test.go` and replay every case through the
HTTP handler, and the container tests replay them against the image with the tables mounted.
They also require unique case IDs, a case for every endpoint, and `explicit-*` route cases that
cover all six profiles. The fake model identities are test data, not a provider catalogue.
Never send them to live providers. The API proxy's tests copy a subset of these cases.

[The behavior fixtures](testdata/parity) record the expected heuristic labels, request
decoding, context estimates and classifier prompts, which were first recorded from the Python
router this Go implementation replaced. Their README lists where the Go router deliberately
differs from it. Change an expectation only in a reviewed pull request that explains it.

## Development

Follow the repository's
[contributing guide](https://github.com/github/gh-aw-firewall/blob/main/CONTRIBUTING.md) and
[code of conduct](https://github.com/github/gh-aw-firewall/blob/main/CODE_OF_CONDUCT.md).
Open an issue to discuss substantial changes before implementation. Keep pull requests focused
and include tests for changed behavior. Do not include credentials, private prompts, local
environments, or generated build output.

Run these checks from this directory.

```bash
gofmt -l .
go vet ./...
go test ./...
```

The container tests run only when `GH_AW_ROUTER_TEST_IMAGE` names a built image. They run it
hardened as AWF does, check its configuration, health check, shutdown and logs, and replay the
routing-contract corpus against it.

```bash
docker build --build-arg OPENAPI_SHA256="$(sha256sum openapi.yaml | cut -d ' ' -f 1)" \
  --tag gh-aw-router:test .
GH_AW_ROUTER_TEST_IMAGE=gh-aw-router:test go test -run '^TestContainer' -v .
```

`FuzzDecodeRouteRequest`, `FuzzParseTable` and `FuzzInferLabels` are fuzz targets, for example
`go test -run '^$' -fuzz FuzzParseTable`. The `test-router.yml` CI workflow runs the checks
on Linux and Windows, the race detector and `govulncheck` on Linux (also weekly), and the
container tests.

### Project layout

- The `.go` files, `go.mod` and `go.sum` are the router: one flat `main` package and its tests.
  The image build copies only `go.mod`, `go.sum` and the non-test `.go` files.
- `routing/` contains generated routing tables from training.
- `schemas/` contains the versioned JSON Schema for routing table files.
- `trust/` is AWF's shared CA distrust policy, which the image build applies to its CA bundle.
- `examples/` contains executable planning requests.
- `testdata/` contains the routing-contract corpus and the behavior fixtures.
- The repository root's `.github/workflows/test-router.yml` and `.github/dependabot.yml` contain
  CI and dependency-update configuration.

### Code conventions

- Keep request and response types in `contract.go` and request decoding in `decode.go`.
- Keep routing in `route.go`, classifier prompts in `classify.go`, and deterministic fallback
  rules in `heuristics.go`.
- Keep the CLI in `cli.go`, HTTP serving in `serve.go` and `server.go`, and OpenTelemetry
  configuration and export in `telemetry.go`.
- Use only the Go standard library, apart from the OpenTelemetry SDK and its exporters. Never
  put conversation text, request ids, headers or other request-controlled values in telemetry.
- Document public behavior, errors, defaults, and approximation limits rather than repeating types.
- Preserve exact offered model identities and explicit reasoning efforts.
- Keep OpenAPI, examples, and fixtures aligned with runtime behavior.

The committed `openapi.yaml` is the authoritative HTTP contract. It distinguishes requested
modes from published profiles and includes the classifier-output schema used by callers.
Update it alongside contract changes. The Go tests check that it documents the served paths and
error codes and that its references resolve, and that the README's examples run against the
bundled tables and match the responses. Do not add a second generated public contract.

The hand-written schema in `schemas/` is the authoritative routing-table contract. A published
schema file never changes, and the Go tests pin its hash and check its enums and patterns
against the Go types. Change the table format only by adding a new schema version.

The HTTP contract follows the router version. There is no API-version request field or
negotiation layer. Review breaking changes with affected consumers, include migration notes,
and test the client, immutable image, OpenAPI document, and corpus as one release combination.
Keep the table format marker because files and mounts can change independently of the image.

Router changes ship in the next AWF release. Bump the router version in the same pull request
as any change to routing behaviour or the HTTP contract. The version appears in the `version`
constant in `main.go`, the Dockerfile's `VERSION` default, `openapi.yaml`, and the
capabilities case in `testdata/routing-contract/discovery.json`; the Go tests fail if they
disagree.

Keep release publication and credentialed attestations in separately reviewed,
explicitly permissioned jobs, which today means AWF's `.github/workflows/release.yml`.
Do not execute untrusted PR code through `pull_request_target`.

### Dependencies and routing data

The router's only Go module dependencies are the OpenTelemetry SDK, its OTLP/HTTP exporters
and what they pull in; the tests also decode OTLP protobuf. The exporters' generated OTLP
packages link parts of gRPC and grpc-gateway into the binary even though the router exports
only over HTTP, so `govulncheck` findings in those modules, and in `golang.org/x/net`, apply
to it. Raise the indirect requirement when an advisory needs it, and keep the OpenTelemetry
modules on one release. Dependabot updates the Go modules and the Docker base image weekly,
and `go.mod`'s toolchain is updated by hand to match the base image. Keep external actions
pinned to full commit SHAs when reviewing updates. Routing JSON files are generated offline.
Do not hand-edit rankings or add runtime dependencies on training tools.

## Security

This service intentionally provides plain HTTP without authentication. It is designed for a
private network shared with a trusted API proxy, not for direct public exposure. The proxy owns
credentials, authorization, provider requests, and execution history.

Run the container without published ports, as a non-root user, with a read-only filesystem and
all capabilities dropped. Mount only trusted routing tables. See the
[container example](#container) for the hardened invocation.

Request size and time limits are not a substitute for network isolation, connection limits, or
proxy timeouts. Context-window estimation is approximate.

Supported router versions follow AWF releases. Report vulnerabilities through the repository's
[security policy](https://github.com/github/gh-aw-firewall/security/policy), and include the AWF
version and the router version that `GET /capabilities` reports. The code is licensed
under [MIT](https://github.com/github/gh-aw-firewall/blob/main/LICENSE).