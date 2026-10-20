# gh-aw-router

gh-aw-router picks the model for a software task. It builds a provider-neutral classification
prompt, then ranks the exact model choices a caller offers using a routing table compiled
offline. It never calls a provider, executes an agent, fits a model, or stores request history.

The router is a single Go binary with no dependencies outside the standard library. AWF runs it
as a sidecar from the image this directory builds. Training, benchmark evidence, and publication
tooling are maintained separately and are not needed to build or run it.

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
up to 0.5 s, closes the rest and exits 0.

`serve` writes one JSON object per line to stderr, and nothing else once its arguments are
parsed. Usage errors stay plain text. Every record has `time` (RFC 3339 UTC with milliseconds),
`level`, `msg`, `service` (`gh-aw-router`) and `version`. The other fields are:

| `msg` | Level | Fields |
| --- | --- | --- |
| `starting` | INFO | `bind`, `log_level`, `go_version` |
| `routing tables loaded` | INFO | `tables_path`, `profiles`, `models`, `label_cells` |
| `routing tables invalid` | ERROR | `error_code` (`invalid_model_data`), `error` |
| `configuration invalid` | ERROR | `error_code` (`invalid_request`), `error` |
| `listening` | INFO | `address` |
| `listen failed` | ERROR | `error` |
| `request` | INFO, or ERROR for a status of 500 or above | `request_id`, `method`, `route`, `status`, `duration_ms`, `error_code` (error envelopes only), `request_bytes`, `response_bytes` |
| `panic` | ERROR | `request_id`, `route`, `stack` |
| `shutting down` | INFO | `signal` |
| `stopped` | INFO | `drained` (whether in-flight requests finished in time), `duration_ms` |

`route` is one of the four served paths or `unmatched`, and `method` is a standard HTTP method
or `_OTHER`. `request_id` is random for each request and isn't sent to the client. A successful
`/healthz` call isn't logged. Records never contain request or response bodies, headers, query
strings, unmatched paths, model or choice ids, error details or panic values.

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

- The `.go` files and `go.mod` are the router: one flat `main` package and its tests. The image
  build copies only `go.mod` and the non-test `.go` files.
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
- Keep the CLI in `cli.go`, and HTTP serving in `serve.go` and `server.go`.
- Use only the Go standard library.
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

The router has no Go module dependencies. Dependabot updates the Docker base image weekly, and
`go.mod`'s toolchain is updated by hand to match it. Keep external actions pinned to full
commit SHAs when reviewing updates. Routing JSON files are generated offline. Do not hand-edit
rankings or add runtime dependencies on training tools.

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