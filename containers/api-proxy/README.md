# AWF API Proxy Sidecar

Node.js-based API proxy that keeps LLM API credentials isolated from the agent container while routing all traffic through Squid to respect domain whitelisting.

## Architecture

```
Agent Container (172.30.0.20)
  ↓ HTTP request to api-proxy:10000
API Proxy Sidecar (172.30.0.30)
  ↓ Injects Authorization header
  ↓ Routes via HTTP_PROXY (172.30.0.10:3128)
Squid Proxy (172.30.0.10)
  ↓ Domain whitelist enforcement
  ↓ TLS connection
api.openai.com or api.anthropic.com
```

## Features

- **Credential Isolation**: API keys held only in sidecar, never exposed to agent
- **Squid Routing**: All traffic routes through Squid via HTTP_PROXY/HTTPS_PROXY
- **Domain Whitelisting**: Squid enforces ACL filtering on all egress traffic
- **Header Injection**: Automatically adds Authorization and x-api-key headers
- **Health Checks**: /health endpoint on each provider port and the management port

## Ports

- **10000**: OpenAI API proxy (api.openai.com)
- **10001**: Anthropic API proxy (api.anthropic.com)
- **10002**: GitHub Copilot API proxy (api.githubcopilot.com)
- **10003**: Google Gemini API proxy (generativelanguage.googleapis.com)
- **10004**: Google Vertex AI API proxy (aiplatform.googleapis.com)

## Environment Variables

Required (at least one):
- `OPENAI_API_KEY` - OpenAI API key for authentication
- `ANTHROPIC_API_KEY` - Anthropic API key for authentication
- `COPILOT_GITHUB_TOKEN` - GitHub token for Copilot authentication
- `COPILOT_PROVIDER_API_KEY` - Direct upstream provider key for Copilot BYOK mode
- `GEMINI_API_KEY` - Google Gemini API key for authentication
- `GOOGLE_API_KEY` - Google Vertex AI API key for authentication

Optional:
- `COPILOT_API_TARGET` - Target hostname for GitHub Copilot API requests (default: `api.githubcopilot.com`). Useful for GHES deployments.
- `VERTEX_API_TARGET` - Target hostname for Vertex API requests (default: `aiplatform.googleapis.com`)
- `VERTEX_API_BASE_PATH` - Base path prefix for Vertex API requests
- `AWF_BYOK_EXTRA_HEADERS` - JSON object of additional headers to inject into upstream requests when the Copilot BYOK API key (`COPILOT_PROVIDER_API_KEY`) is in use. Useful for provider-native observability (e.g. OpenRouter session grouping, Helicone user tracking):
  ```
  AWF_BYOK_EXTRA_HEADERS='{"x-session-id":"my-session","HTTP-Referer":"https://example.com"}'
  ```
  Auth-critical header names (`authorization`, `x-api-key`, etc.) are rejected. Headers are only sent when the BYOK API key is used; standard GitHub OAuth (`COPILOT_GITHUB_TOKEN`) requests are unaffected.
- `AWF_BYOK_EXTRA_BODY_FIELDS` - JSON object of additional top-level request-body fields to inject into Copilot BYOK upstream JSON requests:
  ```
  AWF_BYOK_EXTRA_BODY_FIELDS='{"session_id":"my-session"}'
  ```
- `AWF_PROVIDER_SESSION_ID` - Optional session identifier (typically workflow run ID). When set, the Copilot adapter injects it as a default `x-session-id` header and `session_id` body field on BYOK upstream requests (unless those keys are already provided via `AWF_BYOK_EXTRA_HEADERS` / `AWF_BYOK_EXTRA_BODY_FIELDS`). This is opt-in: the host wrapper only forwards this variable when the caller sets it explicitly via `apiProxy.targets.copilot.sessionId` in awf-config or via `AWF_PROVIDER_SESSION_ID` in env. It is never auto-derived from `GITHUB_RUN_ID`, because strict OpenAI-compatible servers (e.g. Azure OpenAI) reject the unknown `session_id` body field with HTTP 400.

Set by AWF:
- `HTTP_PROXY` - Squid proxy URL (http://172.30.0.10:3128)
- `HTTPS_PROXY` - Squid proxy URL (http://172.30.0.10:3128)

Agent-side routing for Vertex mode:
- `GOOGLE_VERTEX_BASE_URL=http://api-proxy:10004`
- `GOOGLE_API_KEY=google-api-key-placeholder-for-credential-isolation` (placeholder; real key remains in sidecar)

## Upstream error diagnostics

Response headers and bodies are checked against the actual credentials injected
for that request, including custom auth headers, OIDC/renewable tokens, trusted
service secret headers and AWS signing material sent on the wire. Exact,
case-sensitive literal values (and their JSON-escaped spelling) are masked before
forwarding, error inspection and diagnostic logging. Credentials from earlier
attempts remain protected across retries and cross-provider fallback. This does
not add agent-facing caller authentication.

The body filter streams with bounded lookbehind (at most a credential prefix),
not whole-response buffering. It also covers error events inside successful SSE
responses. Identity bodies keep their byte lengths; gzip, deflate and Brotli
responses are streamed through decoding and re-encoding with stale
`Content-Length` removed. Original representation digests and ETags are removed.
Unsupported encodings fail with 502; malformed or truncated encoded streams
terminate the response if headers have already been sent.

WebSocket handshake headers, message payloads and close reasons use the same
literal masking, including credentials split across fragments. Frame lengths,
fragmentation and close status codes are preserved. Optional WebSocket
compression is not negotiated so payloads remain inspectable. Rejected upgrades
retain their HTTP status but omit upstream headers and opaque diagnostic bodies.
Handshake buffering is limited to 16 KiB, and framing/control bytes held behind
a partial credential are limited to 64 KiB; violations close the connection.

This protects against accidental credential echoes, not arbitrary encoding or
deliberate exfiltration by a malicious upstream. Only synthetic local upstreams
and dummy credentials are used by the isolation regressions; no behavior of a
specific third-party provider or released container image is implied.

Terminal non-2xx upstream responses are logged as `upstream_error_response`
records containing the sanitized response headers and a redacted, size-capped
copy of the response body (`AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES`, default
64 KiB). Retryable buffered `400` attempts that are handled internally and
retried do not emit a record. To make zero-token terminal `400` rejections
attributable to the tool surface the agent sent (for example an MCP server whose
`tools/list` failed), the same record also summarizes the request's `tools`
array:

- `request_tool_count` - number of tool definitions sent
- `request_tool_names` - first 32 tool names (names only; no descriptions or schemas)
- `request_unnamed_tool_count` - tool entries with no resolvable name

When the captured body is complete (not truncated and not omitted) and parses
as JSON - regardless of `Content-Type`, since Copilot sends JSON error
envelopes as `text/plain` - the record also carries the provider's error
identifiers as their own fields, so consumers never need to read
`response_body`:

- `error_code` - `error.code` (or `response.error.code` for Responses
  `response.failed`, or the top-level `code` of a `type: "error"` event)
- `error_type` - the matching `type`
- `error_param` - the matching `param`

Only string values matching `^[A-Za-z0-9_.:-]{1,64}$` are kept; `message` and
all other fields are never copied. Keys without a valid value are omitted
(never `null`).

When AWF replaces the provider's rejection with its own envelope (Copilot's
endpoint rejection rewritten to `model_endpoint_incompatible` or
`unsupported_wire_api_feature`), `response_body` is AWF's replacement and
`response_transformed` is `true`, but the error fields are taken from the
provider's original body (and omitted when it has none), so AWF's code is
never attributed to the provider.

## Image request diagnostics

With `--enable-api-proxy`, Copilot and OpenAI HTTP requests emit debug-level
`request_shape` JSON records at `stage: "inbound"` (before body transforms) and
`stage: "upstream"` (before sending each upstream attempt). Correlate records by
`request_id` and compare:

- `body_bytes` — request body size; JSON rewriting can legitimately change it
- `input_item_types` — counts such as `message` and `function_call_output`
- `content_part_types` — message content counts, including `input_image`
- `tool_output_part_types` — structured tool-output counts, including
  `input_image`; a string tool result is counted as `text`

Only fixed type labels and counts are recorded, not prompts, image URLs,
base64 payloads, tool arguments, or tool-output text. Unknown types are counted
as `unknown`.

For a `view` PNG result, compare these counts with the CLI's outgoing request
shape, not just its `binaryResultsForLlm` tool result. If the CLI request and
both proxy stages contain only text, the image was absent before AWF received
the request; investigate CLI serialization upstream. If image counts decrease
between proxy stages, investigate the proxy transform or protocol translation.
Matching counts alone do not prove payload equality.

The local socket tests in `server.multimodal.test.js` compare a direct request
with requests through each provider proxy, verify PNG payload preservation
through JSON model rewriting, and check content type and body framing. Bodies
up to 10 MiB are accepted; larger bodies receive HTTP 413, not truncated
forwarding. Run them without provider credentials:

```bash
cd containers/api-proxy
npm ci
npm test -- --runInBand server.multimodal.test.js logging.test.js
```

These tests do not reproduce the original Copilot CLI 1.0.103 / AWF v0.29.0
session or establish its root cause. A correlated CLI/proxy capture is still
needed before attributing that incident to the CLI.

## Security

- Runs as non-root user (apiproxy)
- All capabilities dropped (cap_drop: ALL)
- Memory limits (512MB)
- Process limits (100 PIDs)
- no-new-privileges security option

## Building

```bash
cd containers/api-proxy
docker build -t awf-api-proxy .
```

## Testing

```bash
# Start proxy with test key
docker run -p 10000:10000 \
  -e OPENAI_API_KEY=sk-test123 \
  -e HTTP_PROXY=http://squid:3128 \
  -e HTTPS_PROXY=http://squid:3128 \
  awf-api-proxy

# Test health endpoint
curl http://localhost:10000/health
```

## Implementation Details

- Built on Node.js 22 Alpine Linux
- Uses Express for HTTP server
- Uses http-proxy-middleware for proxying
- Naturally respects HTTP_PROXY/HTTPS_PROXY environment variables
- Simpler and more maintainable than Envoy configuration
