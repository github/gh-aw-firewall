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
| `awf.model_units` | string | Effective (multiplier-adjusted) token units this request |
| `awf.model_units_total` | string | Running total effective token units for the session |
| `awf.model_multiplier` | string | Model cost multiplier applied to this request |

### `http` group

| Attribute | Type | Description |
|-----------|------|-------------|
| `http.request.method` | string | HTTP method (`POST`, `GET`) |
| `http.response.status_code` | number | Upstream response status |
| `url.path` | string | Sanitized request path |

### Span Events

Each span also emits a `gen_ai.usage` event with the same token attributes for systems that consume events differently from span attributes.

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
