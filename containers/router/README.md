# gh-aw-router

gh-aw-router picks the model for a software task. It builds a provider-neutral classification
prompt, then ranks the exact model choices a caller offers using a routing table compiled
offline. It never calls a provider, executes an agent, fits a model, or stores request history.

The package is self-contained. Training, benchmark evidence, and publication tooling are
maintained separately and are not needed to install or run this service.

## Install and run

Use Python 3.12 and [uv](https://docs.astral.sh/uv/). Run these commands from the directory
containing this README and `pyproject.toml`. Shell examples use Bash syntax. The server runs
in the foreground, so use another terminal for client commands.

```bash
uv sync --locked --dev
uv run gh-aw-router validate-data
uv run gh-aw-router serve --bind 127.0.0.1:8737
```

From a source checkout, the CLI discovers the `routing/` directory. The wheel intentionally
contains code only, so an installed distribution needs tables from the same release's source
archive. The next commands assume the wheel and the extracted `routing/` directory are both
in the current directory.

```bash
python -m pip install ./gh_aw_router-0.1.0-py3-none-any.whl
gh-aw-router --routing-tables ./routing validate-data
gh-aw-router --routing-tables ./routing serve --bind 127.0.0.1:8737
```

Use trusted tables and keep them read-only. Tables are validated at startup, and replacing them
requires a restart.

## CLI

`classify` and `route` read JSON from standard input or from `--input PATH`. The routing-tables
option is global and must precede the command.

```bash
uv run gh-aw-router classify --input examples/classify-request.json
uv run gh-aw-router --routing-tables ./routing \
  route --input examples/route-request.json
```

Command-line options override environment variables, which override defaults.

| Option | Environment variable | Default |
| --- | --- | --- |
| `--routing-tables` | `GH_AW_ROUTER_ROUTING_TABLES` | Checkout's `routing/` |
| `serve --bind` | `GH_AW_ROUTER_BIND` | `127.0.0.1:8737` |
| `serve --log-level` | `GH_AW_ROUTER_LOG_LEVEL` | `info` |

The path may be a directory, which loads every table in it, or a single file, which serves that
one profile. Outside a checkout, a routing path is required. Relative paths resolve from the
current working directory. Bind to another interface only on a trusted private network. The
container binds to all of its own interfaces.

Results go to stdout and errors to stderr. Exit statuses are `0` for success, `2` for invalid
input, invalid table data, file errors, or argument errors, and `3` when routing finds no
eligible model. `--help` and `--version` exit successfully without loading a table.

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
methods. Schema violations name the failing fields without echoing submitted values. Serving
bounds request bodies to 1 MiB and in-flight requests to 64. A 30-second deadline bounds
asynchronous upload and response waits but cannot interrupt synchronous computation.
Overload can produce a bare 503 before the application runs. Clients must also handle connection
failures and enforce their own timeouts.

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
If no offered classifier choice is supported, `/classify` returns `422 invalid_request`.
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

Only schema 5 is supported. A schema-5 table declares one fixed `cost` or `cost-speed` profile
and carries no default-effort aliases. This format marker remains independent because tables
can be supplied through a file or mount without replacing the router image.

## Container

Build from this directory. The Docker build context is self-contained.

```bash
docker build --tag gh-aw-router:dev .
```

The optional `VERSION` build argument must match the package version. A mismatch fails
the build rather than publishing image metadata that disagrees with the CLI or service.

The image bundles every published table under `/routing` and serves all six profiles. It runs as
user `10001:10001` and needs no credentials or outbound network. This invocation uses a private
network, a read-only filesystem, and no published host port. The service listens on port `8737`
inside the network.

```bash
docker network create --internal gh-aw-routing

docker run --detach \
  --name gh-aw-router \
  --network gh-aw-routing \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --stop-timeout 35 \
  gh-aw-router:dev
```

Only trusted clients such as the API proxy belong on this network, not the coding agent.
`GET /healthz` returns `204` when ready, and `GET /capabilities` describes the loaded profiles.
To replace the bundled tables, add these options before the image name.

```bash
--mount type=bind,src=/trusted/routing,dst=/mnt/routing,readonly \
--env GH_AW_ROUTER_ROUTING_TABLES=/mnt/routing
```

## Contract fixtures and artifacts

[The portable corpus](tests/fixtures/routing-contract) covers all four endpoints
using synthetic model identities and six distinguishable table profiles. The same reviewed
request bytes run through HTTP adapter tests and the hardened Linux amd64 container tests.
Classifier prompts are fixed expected data, not regenerated during tests.

Endpoint files contain complete requests and reviewed expected responses. The test-only
`response_file` reference shares an exact classifier response between cases. The exporter
resolves it so consumers receive concrete JSON responses without a template language.

The archive contains this README, `cases.json`, six synthetic profiles in `tables/`,
`openapi.yaml`, the unchanged external `integration-contract.md`, and `manifest.json`.
Cases name the method, path, expected status, and optional headers. Send each UTF-8
`request_body` unchanged for wire replay. Default to `Content-Type: application/json`
when headers are omitted. A 204 response has no body. `raw_request` marks malformed
JSON, and `request_valid: false` marks a schema-invalid object.

A case's optional `profiles` list restricts the table files loaded. Otherwise load all
six. Mount the selected directory read-only and readable by UID/GID 10001. The fake model
identities are test data, not a provider catalogue. Never send them to live providers.

Compare successful responses exactly, including choice order, effort omission, and prompt
strings. For errors, compare status and stable `code`, then validate the full envelope
against OpenAPI. Fixture `detail` text is representative mock data, not a promise to
preserve incidental diagnostic wording. Verify archive and manifest checksums before use.

Export a corpus archive from a clean source checkout with Python 3.12 and development
dependencies installed. Supply the reviewed integration attachment and its expected checksum.
The attachment is preserved unchanged and is not included in the runtime package.

```bash
uv run --locked python tests/contract_corpus.py \
  --integration-contract /path/to/integration-contract.md \
  --integration-contract-sha256 "$INTEGRATION_CONTRACT_SHA256" \
  --output dist/routing-contract.tar.gz
```

The command prints the archive checksum. Its manifest records the source SHA, router release,
table schema, attachment revision, and every payload file's SHA-256. A dirty or unidentified
checkout requires `--development` and is explicitly marked as non-release provenance.
Repeated exports with the same inputs and source state produce identical bytes. Repository
OpenAPI text uses LF in the archive, while the external attachment retains its original bytes.

Ordinary PR CI runs corpus, packaging, and native Linux amd64 Docker checks without
provider credentials. Use the exporter above to create a local contract archive.

Publication requires a separate reviewed source and registry authorization. A deployment pin
has the form `<approved-registry>/<repository>:<reviewed-tag>@sha256:<manifest-digest>`.
A local image ID or Docker archive checksum is not that registry manifest digest. Retain
supported immutable images and matching contract archives. Deliver security fixes through
supported release updates and tested client pin changes, not replacement bytes under old pins.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers development conventions and checks.

The service intentionally has no authentication or TLS. Keep it on a private network. Report
vulnerabilities through [SECURITY.md](SECURITY.md). The code is licensed under [MIT](LICENSE).
