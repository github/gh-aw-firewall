---
title: API Proxy Sidecar
description: Secure LLM API credential management using an isolated proxy sidecar container.
---

The AWF firewall supports an optional Node.js-based API proxy sidecar that securely holds LLM API credentials and automatically injects authentication headers while routing all traffic through Squid to respect domain whitelisting.

:::note
For a deep dive into how AWF handles authentication tokens and credential isolation, see the [Authentication Architecture](./authentication-architecture.md) guide.
:::

## Overview

When enabled, the API proxy sidecar:
- **Isolates credentials**: API keys are never exposed to the agent container
- **Auto-authentication**: Automatically injects Bearer tokens and API keys
- **Dual provider support**: Supports both OpenAI (Codex) and Anthropic (Claude) APIs
- **Transparent proxying**: Agent code uses standard SDK environment variables
- **Squid routing**: All traffic routes through Squid to respect domain whitelisting

## Architecture

```
┌─────────────────────────────────────────────────┐
│ AWF Network (172.30.0.0/24)                     │
│                                                  │
│  ┌──────────────┐       ┌─────────────────┐   │
│  │   Squid      │◄──────│  Node.js Proxy  │   │
│  │ 172.30.0.10  │       │  172.30.0.30    │   │
│  └──────┬───────┘       └─────────────────┘   │
│         │                        ▲              │
│         │  ┌──────────────────────────────┐    │
│         │  │      Agent Container         │    │
│         │  │      172.30.0.20             │    │
│         │  │  OPENAI_BASE_URL=            │    │
│         │  │   http://172.30.0.30:10000/v1│────┘
│         │  │  ANTHROPIC_BASE_URL=         │
│         │  │   http://172.30.0.30:10001   │
│         │  └──────────────────────────────┘
│         │
└─────────┼─────────────────────────────────────┘
          │ (Domain whitelist enforced)
          ↓
  api.openai.com or api.anthropic.com
```

**Traffic flow:**
1. Agent makes a request to `172.30.0.30:10000` (OpenAI) or `172.30.0.30:10001` (Anthropic)
2. API proxy strips any client-supplied auth headers and injects the real credentials
3. API proxy routes the request through Squid via `HTTP_PROXY`/`HTTPS_PROXY`
4. Squid enforces the domain whitelist (only allowed domains pass)
5. Request reaches `api.openai.com` or `api.anthropic.com`

## Usage

### Basic usage

```bash
# Set API keys in environment
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Enable API proxy sidecar
sudo awf --enable-api-proxy \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-command
```

### Codex (OpenAI) example

```bash
export OPENAI_API_KEY="sk-..."

sudo awf --enable-api-proxy \
  --allow-domains api.openai.com \
  -- npx @openai/codex -p "write a hello world function"
```

The agent container automatically uses `http://172.30.0.30:10000/v1` as the OpenAI base URL.

### Claude Code example

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf --enable-api-proxy \
  --allow-domains api.anthropic.com \
  -- claude-code "write a hello world function"
```

The agent container automatically uses `http://172.30.0.30:10001` as the Anthropic base URL.

### Both providers

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf --enable-api-proxy \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-multi-llm-tool
```

## Environment variables

When API keys are provided, AWF sets these environment variables in the agent container:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_BASE_URL` | `http://172.30.0.30:10000/v1` | `OPENAI_API_KEY` is set | OpenAI API proxy endpoint |
| `ANTHROPIC_BASE_URL` | `http://172.30.0.30:10001` | `ANTHROPIC_API_KEY` is set | Anthropic API proxy endpoint |

These are standard environment variables recognized by:
- OpenAI Python SDK (`openai`)
- OpenAI Node.js SDK (`openai`)
- Anthropic Python SDK (`anthropic`)
- Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- Codex CLI
- Claude Code CLI

:::tip
You don't need to change any agent code. The SDKs automatically read `*_BASE_URL` environment variables and redirect API calls through the proxy.
:::

## Security benefits

### Credential isolation

API keys are held in the sidecar container, not the agent:
- Agent code cannot read API keys from environment variables
- A compromised agent cannot exfiltrate credentials
- Keys are not exposed in the agent container's stdout/stderr logs

:::danger[Protect host credentials]
API keys are stored in the sidecar container's environment and in the Docker Compose configuration on disk. Protect the host filesystem and configuration accordingly. Only non-sensitive key prefixes are logged for debugging.
:::

### Network isolation

The proxy enforces domain-level egress control:
- The agent can only reach the API proxy IP (`172.30.0.30`) for API calls
- The sidecar routes all traffic through Squid proxy
- Squid enforces the domain whitelist (L7 filtering)
- iptables rules prevent the agent from bypassing the proxy

### Resource limits

The sidecar has strict resource constraints:
- 512 MB memory limit
- 100 process limit
- All capabilities dropped
- `no-new-privileges` security option

## How it works

### 1. Container startup

When you pass `--enable-api-proxy`:
1. AWF starts a Node.js API proxy at `172.30.0.30`
2. API keys are passed to the sidecar via environment variables
3. `HTTP_PROXY`/`HTTPS_PROXY` in the sidecar are configured to route through Squid
4. The agent container waits for the sidecar health check to pass

### 2. Request flow

```
Agent Code
  ↓ (HTTP request to 172.30.0.30:10000/v1)
Node.js API Proxy
  ↓ (strips client auth headers)
  ↓ (injects Authorization: Bearer $OPENAI_API_KEY)
  ↓ (routes via HTTPS_PROXY to Squid)
Squid Proxy
  ↓ (enforces domain whitelist)
  ↓ (TLS connection to api.openai.com)
OpenAI API
```

### 3. Header injection

The Node.js proxy automatically:
- **Strips** any client-supplied `Authorization`, `x-api-key`, `Proxy-Authorization`, and `X-Forwarded-*` headers
- **Injects** the correct authentication headers:
  - **OpenAI**: `Authorization: Bearer $OPENAI_API_KEY`
  - **Anthropic**: `x-api-key: $ANTHROPIC_API_KEY` and `anthropic-version: 2023-06-01` (if not already set by the client)

:::caution
The proxy enforces a 10 MB request body size limit to prevent denial-of-service via large payloads.
:::

### 4. Pre-flight health check

Before running the user command, the agent container runs a health check script (`api-proxy-health-check.sh`) that verifies:
- API keys are **not** present in the agent environment (credential isolation working)
- The API proxy is reachable and responding (connectivity established)

If either check fails, the agent exits immediately without running the user command.

## Configuration reference

### CLI options

```bash
sudo awf --enable-api-proxy [OPTIONS] -- COMMAND
```

**Required environment variables** (at least one):
- `OPENAI_API_KEY` — OpenAI API key
- `ANTHROPIC_API_KEY` — Anthropic API key

**Recommended domain whitelist**:
- `api.openai.com` — for OpenAI/Codex
- `api.anthropic.com` — for Anthropic/Claude

### Container configuration

The sidecar container:
- **Image**: `ghcr.io/github/gh-aw-firewall/api-proxy:latest`
- **Base**: `node:22-alpine`
- **Network**: `awf-net` at `172.30.0.30`
- **Ports**: 10000 (OpenAI), 10001 (Anthropic), 10002 (GitHub Copilot)
- **Proxy**: Routes via Squid at `http://172.30.0.10:3128`

### Health check

Docker healthcheck on the `/health` endpoint (port 10000):
- **Interval**: 5s
- **Timeout**: 3s
- **Retries**: 5
- **Start period**: 5s

## Troubleshooting

### API keys not detected

```
⚠️  API proxy enabled but no API keys found in environment
   Set OPENAI_API_KEY or ANTHROPIC_API_KEY to use the proxy
```

**Solution**: Export API keys before running awf:

```bash
export OPENAI_API_KEY="sk-..."
# or
export ANTHROPIC_API_KEY="sk-ant-..."
```

### Sidecar health check failing

Check if the API proxy container started:

```bash
docker ps | grep awf-api-proxy
```

View API proxy logs:

```bash
docker logs awf-api-proxy
```

### API requests timing out

Ensure the API domains are whitelisted:

```bash
sudo awf --enable-api-proxy \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-command
```

Check Squid logs for denied requests:

```bash
docker exec awf-squid cat /var/log/squid/access.log | grep DENIED
```

## Limitations

- Only supports OpenAI and Anthropic APIs
- Keys must be set as environment variables (not file-based)
- No support for Azure OpenAI endpoints
- No request/response logging (by design, for security)

## Related documentation

- [Authentication Architecture](./authentication-architecture.md) — detailed credential isolation internals
- [Security](./security.md) — overall security model
- [Environment Variables](./environment.md) — environment variable configuration
- [Troubleshooting](./troubleshooting.md) — common issues and solutions
- [Architecture](./architecture.md) — overall system architecture
