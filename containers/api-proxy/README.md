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
- **Health Checks**: /health endpoint on both ports

## Ports

- **10000**: OpenAI API proxy (api.openai.com)
- **10001**: Anthropic API proxy (api.anthropic.com)

## Environment Variables

Required (at least one):
- `OPENAI_API_KEY` - OpenAI API key for authentication
- `ANTHROPIC_API_KEY` - Anthropic API key for authentication

Optional:
- `COPILOT_API_TARGET` - Target hostname for GitHub Copilot API requests (default: `api.githubcopilot.com`). Useful for GHES deployments.

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
