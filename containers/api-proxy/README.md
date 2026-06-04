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

## Environment Variables

Required (at least one):
- `OPENAI_API_KEY` - OpenAI API key for authentication
- `ANTHROPIC_API_KEY` - Anthropic API key for authentication
- `COPILOT_GITHUB_TOKEN` - GitHub token for Copilot authentication
- `COPILOT_PROVIDER_API_KEY` - Direct upstream provider key for Copilot BYOK mode
- `GEMINI_API_KEY` - Google Gemini API key for authentication

Optional:
- `COPILOT_API_TARGET` - Target hostname for GitHub Copilot API requests (default: `api.githubcopilot.com`). Useful for GHES deployments.
- `AWF_BYOK_EXTRA_HEADERS` - JSON object of additional headers to inject into upstream requests when the Copilot BYOK API key (`COPILOT_PROVIDER_API_KEY`) is in use. Useful for provider-native observability (e.g. OpenRouter session grouping, Helicone user tracking):
  ```
  AWF_BYOK_EXTRA_HEADERS='{"x-session-id":"my-session","HTTP-Referer":"https://example.com"}'
  ```
  Auth-critical header names (`authorization`, `x-api-key`, etc.) are rejected. Headers are only sent when the BYOK API key is used; standard GitHub OAuth (`COPILOT_GITHUB_TOKEN`) requests are unaffected.
- `AWF_BYOK_EXTRA_BODY_FIELDS` - JSON object of additional top-level request-body fields to inject into Copilot BYOK upstream JSON requests:
  ```
  AWF_BYOK_EXTRA_BODY_FIELDS='{"session_id":"my-session"}'
  ```
- `AWF_PROVIDER_SESSION_ID` - Optional session identifier (typically workflow run ID). In BYOK mode this is used as a default `x-session-id` header and default `session_id` body field when those keys are not explicitly provided.

Set by AWF:
- `HTTP_PROXY` - Squid proxy URL (http://172.30.0.10:3128)
- `HTTPS_PROXY` - Squid proxy URL (http://172.30.0.10:3128)

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
