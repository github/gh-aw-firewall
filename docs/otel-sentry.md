# OTEL Tracing in Sentry

This document describes where AWF telemetry data appears in Sentry when OTEL tracing is enabled.

## Trace URL Format

```
https://github.sentry.io/performance/trace/<trace-id>/
```

The trace ID is logged during workflow runs:
```
[otlp] resolved trace-id=<32-char hex>
```

To extract from a CI run:
```bash
gh run view <run-id> --log | grep "resolved trace-id"
```

## Span Structure

Each api-proxy LLM request creates a CLIENT span named:
```
api_proxy.<provider>.request
```

Examples: `api_proxy.copilot.request`, `api_proxy.anthropic.request`, `api_proxy.openai.request`

Spans are children of the workflow's parent trace (linked via `GITHUB_AW_OTEL_TRACE_ID` / `GITHUB_AW_OTEL_PARENT_SPAN_ID` env vars).

## Attribute Locations in Sentry UI

In Sentry's trace detail view, expand a span and look under **Tags & Attributes**. Attributes are grouped by dot-separated prefix.

### `gen_ai` group

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.provider.name` | string | Provider name (`copilot`, `anthropic`, `openai`, `gemini`) |
| `gen_ai.operation.name` | string | Always `chat` |
| `gen_ai.request.stream` | boolean | Whether the request was streaming |
| `gen_ai.response.model` | string | Model name from upstream response (e.g., `claude-sonnet-4-20250514`) |
| `gen_ai.usage.input_tokens` | number | Input/prompt token count |
| `gen_ai.usage.output_tokens` | number | Output/completion token count |
| `gen_ai.usage.total_tokens` | number | **Auto-computed by Sentry** (input + output) |

### `awf` group

| Attribute | Type | Description |
|-----------|------|-------------|
| `awf.request_id` | string | Internal AWF request ID for correlation |
| `awf.cached_read` | string | Number of prompt tokens served from cache (as string) |
| `awf.cached_write` | string | Number of tokens written to cache (as string) |
| `awf.reasoning` | string | Number of reasoning/thinking tokens (as string) |
| `awf.ai_credits` | string | AI credits consumed by this request |
| `awf.ai_credits_total` | string | Running total AI credits for the session |
| `awf.model_multiplier` | string | Model cost multiplier applied to this request |

### `http` group

| Attribute | Type | Description |
|-----------|------|-------------|
| `http.request.method` | string | HTTP method (`POST`, `GET`) |
| `http.response.status_code` | number | Upstream response status |
| `url.path` | string | Sanitized request path |

### Span Events

Each span also emits a `gen_ai.usage` event with the same token attributes for systems that consume events differently from span attributes.

## Model-Router Call Spans

When model routing is configured, the api-proxy plans once at startup by calling the
`gh-aw-router` sidecar. Each `capabilities`, `classify` and `route` call gets a CLIENT span
named:
```
api_proxy.router.<operation>
```

These spans have the same parent as the LLM request spans: the workflow span from
`GITHUB_AW_OTEL_TRACE_ID` / `GITHUB_AW_OTEL_PARENT_SPAN_ID`, or a new root without one. They are
exported the same way, so they reach the workflow's collector, or `otel.jsonl` without one, even
though the router's own export isn't configured. Health checks aren't traced.

Each call sends the span's W3C `traceparent`, and `tracestate` when its parent has one, to the
router. It never sends `baggage`. When the router exports its own spans, they become children of
these spans.

| Attribute | Type | Description |
|-----------|------|-------------|
| `http.request.method` | string | `GET` or `POST` |
| `url.path` | string | `/capabilities`, `/classify` or `/route` |
| `server.address`, `server.port` | string, number | The configured router host and port |
| `http.response.status_code` | number | Router response status, when a response arrived |
| `error.type` | string | On failure only: the HTTP status for a router error, otherwise a fixed code such as `ETIMEDOUT`, `ECONNREFUSED`, `routing_cancelled` or `routing_contract_error`, or `_OTHER` |
| `gh_aw_router.goal`, `gh_aw_router.mode` | string | The configured routing objective (`route` only) |
| `gh_aw_router.classification.present` | boolean | Whether the route request included a classification (`route` only) |
| `gh_aw_router.selected.model`, `gh_aw_router.selected.effort` | string | The top choice of a successful `route` response, only after it passes validation against the offered choices |

A failed or invalid route response gets no selection. The router's resolved mode isn't
recorded here, because the router doesn't return it; the router's own `gh_aw_router.route` span
records it. Spans never contain the conversation, classifier labels, choice ids, response bodies
or error messages. They are for trace views only: the record of a routing decision remains the
`firewall.model_routing` selection in `usage/aw_session.jsonl`.

Each retry attempt gets its own span. A successful call ends with status OK, like the LLM
request spans. A failed call ends with status ERROR, and its status message is the `error.type`
value. An attempt that hits the planner's per-attempt timeout or
the routing deadline ends with `ETIMEDOUT`; `routing_cancelled` means routing itself was
cancelled, for example because the api-proxy is shutting down.

## Router Export

The `gh-aw-router` sidecar can export its own traces and metrics, but only when the operator opts
in. It's off by default, and routing never needs a collector.

**Settings.** For each router setting `OTEL_<NAME>`, AWF reads the host variable
`AWF_ROUTER_OTEL_<NAME>` and, when it's set and not blank, passes its value to the router as
`OTEL_<NAME>`:

| Host variable | Router setting |
|---------------|----------------|
| `AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT`, the base URL for both signals |
| `AWF_ROUTER_OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT` | The complete URL for one signal |
| `AWF_ROUTER_OTEL_EXPORTER_OTLP_[{TRACES,METRICS}_]{PROTOCOL,HEADERS,TIMEOUT,CERTIFICATE}` | Exporter protocol (only `http/protobuf`), headers, timeout and CA file |
| `AWF_ROUTER_OTEL_TRACES_EXPORTER`, `AWF_ROUTER_OTEL_METRICS_EXPORTER` | `otlp` or `none` |
| `AWF_ROUTER_OTEL_SDK_DISABLED` | `true` turns both signals off |
| `AWF_ROUTER_OTEL_TRACES_SAMPLER`, `AWF_ROUTER_OTEL_TRACES_SAMPLER_ARG` | Sampler, `parentbased_always_on` by default |
| `AWF_ROUTER_OTEL_METRIC_EXPORT_INTERVAL`, `AWF_ROUTER_OTEL_METRIC_EXPORT_TIMEOUT` | Metric export interval and timeout, in milliseconds |
| `AWF_ROUTER_OTEL_SERVICE_NAME` | `service.name`, `gh-aw-router` by default |
| `AWF_ROUTER_OTEL_RESOURCE_ATTRIBUTES` | Only `service.namespace` and `deployment.environment.name` |

AWF passes the values as they are, and the router validates them. A signal-specific setting
replaces the shared one for that signal, and a signal is on only when it has an endpoint. An
invalid setting turns off the signals it applies to and is logged by name, never by value;
routing continues. AWF sets no defaults: with no `AWF_ROUTER_OTEL_*` variable set, the router has
no environment and makes no network calls. Metrics are cumulative, and the router exports the
run's totals when it shuts down, so a short run needs no shorter interval. The router's
[telemetry documentation](https://github.com/github/gh-aw-firewall/blob/main/containers/router/README.md#telemetry)
describes each setting, the resource and the privacy rules: router spans and metrics never contain
conversation text, candidate lists, request headers or error details, and metrics never carry
model ids or classifier labels.

**Shared settings stay with the api-proxy.** The `OTEL_*`, `GH_AW_OTLP_*` and workload-identity
variables in AWF's environment, which gh-aw sets for a workflow's external collector, configure
only the api-proxy (see [Configuration](#configuration)). They never reach the router, nor do
GitHub tokens, provider credentials, `GITHUB_AW_OTEL_*` or proxy settings. The router joins the
workflow trace through the `traceparent` that the api-proxy sends, not through its environment.

**Reachability.** The router is attached only to AWF's internal `awf-routing` Docker network.
It has no route to the internet, to Squid or to the host, and inside the router `localhost` is the
router container itself. Its collector must therefore be a container on the `awf-routing` network,
addressed by that container's name or alias. Exporting through the api-proxy's external
collectors, OTLP fan-out and workload identity aren't supported for router export. AWF doesn't
mount files into the router, so `..._CERTIFICATE` must name a file that exists inside the router
image.

**Credentials.** `..._HEADERS` values are collector credentials that the operator chose to give
the router. The coding agent never sees any `AWF_ROUTER_OTEL_*` variable, even with `--env-all`.
The audit and diagnostics copies of the compose file replace OTLP header values with
`[REDACTED]` and remove user info from OTLP endpoint URLs, for the router's and the api-proxy's
settings.

**Correlation.** With export on, the router's `SERVER` span for each call is a child of the
api-proxy's `api_proxy.router.<operation>` span, so both appear in the workflow's trace. Each
router `request` log record carries the `trace_id` and `span_id` of that span. AWF doesn't keep
the router's container logs after the run: teardown removes the router container with them.

## Important Sentry Behavior

1. **Numeric custom attributes are dropped** — Sentry only preserves numeric values for attributes it recognizes (e.g., `gen_ai.usage.input_tokens`). Unknown numeric attributes are silently discarded.

2. **String custom attributes are preserved** — This is why `awf.*` cache/reasoning values are emitted as strings.

3. **PII scrubbing filters "token" in names** — Sentry's default data scrubbing rules redact values of any attribute containing "token" in the key name (treats it as a credential). This is why cache attributes use `awf.cached_read` / `awf.cached_write` instead of names containing "token".

4. **`total_tokens` is auto-computed** — Sentry synthesizes `gen_ai.usage.total_tokens` from input + output. Do not emit it manually.

5. **Hierarchical grouping** — Attributes are grouped by dot prefix in the UI (e.g., all `gen_ai.*` under "gen_ai", all `awf.*` under "awf").

## Configuration

OTEL tracing is enabled by setting these environment variables in the agent container:

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL (e.g., Sentry's ingest URL) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers (e.g., Sentry DSN) |
| `GITHUB_AW_OTEL_TRACE_ID` | Parent trace ID (32-char hex) for span nesting |
| `GITHUB_AW_OTEL_PARENT_SPAN_ID` | Parent span ID (16-char hex) for span nesting |
| `HTTPS_PROXY` | Proxy URL — the OTLP exporter routes through Squid |

When no OTLP endpoint is configured, spans are written to `/var/log/awf/otel.jsonl` for local debugging.

## Service Identity

- **Service name**: `awf-api-proxy`
- **Instrumentation scope**: `awf-api-proxy`
- **Span kind**: `CLIENT` (outbound LLM API calls)
