---
title: API Proxy (Unified Architecture)
description: Secure LLM API credential management using a unified proxy container.
---

The AWF firewall supports an optional Node.js-based API auth proxy that securely holds LLM API credentials and automatically injects authentication headers while routing all traffic through Squid to respect domain whitelisting.

The auth proxy runs **inside the Squid container** (unified architecture), eliminating the need for a separate sidecar container.

:::note
For a deep dive into how AWF handles authentication tokens and credential isolation, see the [Authentication Architecture](./authentication-architecture.md) guide.
:::

## Overview

When enabled, the unified API proxy:
- **Isolates credentials**: API keys are never exposed to the agent container
- **Auto-authentication**: Automatically injects Bearer tokens and API keys
- **Multi-provider support**: Supports OpenAI (Codex), Anthropic (Claude), and GitHub Copilot APIs
- **Transparent proxying**: Agent code uses standard SDK environment variables
- **Squid routing**: Auth proxy routes through local Squid for domain whitelisting
- **Reduced complexity**: Single container instead of separate sidecar

## Architecture

```
┌─────────────────────────────────────────────────┐
│ AWF Network (172.30.0.0/24)                     │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │     Unified Squid Container              │   │
│  │     172.30.0.10                          │   │
│  │  ┌─────────────┐  ┌──────────────────┐  │   │
│  │  │ Squid Proxy  │◄─│ Node.js Auth    │  │   │
│  │  │ :3128        │  │ Proxy :10000-2  │  │   │
│  │  └──────┬───────┘  └────────▲────────┘  │   │
│  └─────────┼───────────────────┼───────────┘   │
│            │                    │               │
│  ┌─────────┼────────────────────┼──────────┐   │
│  │         │  Agent Container    │          │   │
│  │         │  172.30.0.20       │          │   │
│  │  OPENAI_BASE_URL=            │          │   │
│  │   http://172.30.0.10:10000/v1─┘          │   │
│  │  ANTHROPIC_BASE_URL=                     │   │
│  │   http://172.30.0.10:10001               │   │
│  └──────────────────────────────────────────┘   │
│            │                                    │
└────────────┼────────────────────────────────────┘
             │ (Domain whitelist enforced)
             ↓
  api.openai.com or api.anthropic.com
```

**Traffic flow:**
1. Agent makes a request to `172.30.0.10:10000` (OpenAI) or `172.30.0.10:10001` (Anthropic)
2. Auth proxy strips any client-supplied auth headers and injects the real credentials
3. Auth proxy routes the request through localhost Squid via `HTTP_PROXY`/`HTTPS_PROXY`
4. Squid enforces the domain whitelist (L7 filtering)
5. Request reaches `api.openai.com` or `api.anthropic.com`

## Usage

### Basic usage

```bash
# Set API keys in environment
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Enable API proxy
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

The agent container automatically uses `http://172.30.0.10:10000/v1` as the OpenAI base URL.

### Claude Code example

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf --enable-api-proxy \
  --allow-domains api.anthropic.com \
  -- claude-code "write a hello world function"
```

The agent container automatically uses `http://172.30.0.10:10001` as the Anthropic base URL.

### Both providers

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf --enable-api-proxy \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-multi-llm-tool
```

## Environment variables

AWF manages environment variables across the Squid container and agent container to ensure secure credential isolation.

### Squid container (with auth proxy)

The unified Squid container receives **real credentials** when `--enable-api-proxy` is used:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_API_KEY` | Real API key | `--enable-api-proxy` and env set | OpenAI API key (injected into requests) |
| `ANTHROPIC_API_KEY` | Real API key | `--enable-api-proxy` and env set | Anthropic API key (injected into requests) |
| `COPILOT_GITHUB_TOKEN` | Real token | `--enable-api-proxy` and env set | GitHub Copilot token (injected into requests) |
| `HTTP_PROXY` | `http://localhost:3128` | Auth proxy enabled | Routes auth proxy traffic through Squid |
| `HTTPS_PROXY` | `http://localhost:3128` | Auth proxy enabled | Routes auth proxy traffic through Squid |

:::danger[Real credentials in Squid container]
The Squid container holds **real, unredacted credentials** when `--enable-api-proxy` is enabled. The Node.js auth proxy runs as the non-root `proxy` user with `no-new-privileges` security option for defense in depth.
:::

### Agent container

The agent container receives **redacted placeholders** and proxy URLs:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_BASE_URL` | `http://172.30.0.10:10000/v1` | `OPENAI_API_KEY` provided to host | Redirects OpenAI SDK to proxy |
| `ANTHROPIC_BASE_URL` | `http://172.30.0.10:10001` | `ANTHROPIC_API_KEY` provided to host | Redirects Anthropic SDK to proxy |
| `ANTHROPIC_AUTH_TOKEN` | `placeholder-token-for-credential-isolation` | `ANTHROPIC_API_KEY` provided to host | Placeholder token (real auth via BASE_URL) |
| `CLAUDE_CODE_API_KEY_HELPER` | `/usr/local/bin/get-claude-key.sh` | `ANTHROPIC_API_KEY` provided to host | Helper script for Claude Code CLI |
| `COPILOT_API_URL` | `http://172.30.0.10:10002` | `COPILOT_GITHUB_TOKEN` provided to host | Redirects Copilot CLI to proxy |
| `COPILOT_TOKEN` | `placeholder-token-for-credential-isolation` | `COPILOT_GITHUB_TOKEN` provided to host | Placeholder token (real auth via API_URL) |
| `COPILOT_GITHUB_TOKEN` | `placeholder-token-for-credential-isolation` | `COPILOT_GITHUB_TOKEN` provided to host | Placeholder token protected by one-shot-token |
| `OPENAI_API_KEY` | Not set | `--enable-api-proxy` | Excluded from agent (held in Squid container) |
| `ANTHROPIC_API_KEY` | Not set | `--enable-api-proxy` | Excluded from agent (held in Squid container) |
| `HTTP_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `HTTPS_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `NO_PROXY` | `localhost,127.0.0.1,172.30.0.10` | `--enable-api-proxy` | Bypass proxy for localhost and Squid IP |
| `AWF_ONE_SHOT_TOKENS` | `COPILOT_GITHUB_TOKEN,GITHUB_TOKEN,...` | Always | Tokens protected by one-shot-token library |

:::tip[Placeholder tokens]
Token variables in the agent are set to `placeholder-token-for-credential-isolation` instead of real values. This ensures:
- Agent code cannot exfiltrate credentials
- CLI tools that check for token presence still work
- Real authentication happens via the `*_BASE_URL` or `*_API_URL` environment variables
- The one-shot-token library protects placeholder values from being read more than once
:::

These environment variables are recognized by:
- OpenAI Python SDK (`openai`)
- OpenAI Node.js SDK (`openai`)
- Anthropic Python SDK (`anthropic`)
- Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- GitHub Copilot CLI (`@github/copilot`)
- Codex CLI
- Claude Code CLI

:::tip
You don't need to change any agent code. The SDKs automatically read `*_BASE_URL` environment variables and redirect API calls through the proxy.
:::

## Security benefits

### Credential isolation

API keys are held in the Squid container, not the agent:
- Agent code cannot read API keys from environment variables
- A compromised agent cannot exfiltrate credentials
- Keys are not exposed in the agent container's stdout/stderr logs
- Node.js auth proxy runs as non-root `proxy` user

:::danger[Protect host credentials]
API keys are stored in the Squid container's environment and in the Docker Compose configuration on disk. Protect the host filesystem and configuration accordingly. Only non-sensitive key prefixes are logged for debugging.
:::

### Network isolation

The proxy enforces domain-level egress control:
- The agent can only reach the Squid IP (`172.30.0.10`) for API calls
- The auth proxy routes all traffic through Squid internally
- Squid enforces the domain whitelist (L7 filtering)
- iptables rules prevent the agent from bypassing the proxy

### Container hardening

The unified Squid container has strict security constraints:
- 1 GB memory limit (Squid + Node.js)
- 200 process limit
- `no-new-privileges` security option
- Unnecessary capabilities dropped
- Node.js auth proxy runs as non-root `proxy` user

## How it works

### 1. Container startup

When you pass `--enable-api-proxy`:
1. AWF configures the Squid container with API keys in its environment
2. The Squid entrypoint starts the Node.js auth proxy as non-root `proxy` user
3. The Squid entrypoint starts Squid in background
4. Docker healthcheck verifies both Squid (port 3128) and auth proxy (port 10000)
5. The agent container waits for the combined health check to pass

### 2. Request flow

```
Agent Code
  ↓ (HTTP request to 172.30.0.10:10000/v1)
Node.js Auth Proxy (inside Squid container)
  ↓ (strips client auth headers)
  ↓ (injects Authorization: Bearer $OPENAI_API_KEY)
  ↓ (routes via localhost:3128 to Squid)
Squid Proxy (same container)
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

The unified Squid container (with auth proxy):
- **Image**: `ghcr.io/github/gh-aw-firewall/squid:latest`
- **Base**: `ubuntu/squid:latest` with Node.js
- **Network**: `awf-net` at `172.30.0.10`
- **Ports**: 3128 (Squid), 10000 (OpenAI), 10001 (Anthropic), 10002 (GitHub Copilot)
- **Auth proxy routes via**: localhost Squid at `http://localhost:3128`

### Health check

Docker healthcheck verifies both services:
- Squid: `nc -z localhost 3128`
- Auth proxy: `curl -sf http://localhost:10000/health`
- **Interval**: 5s
- **Timeout**: 3s
- **Retries**: 5
- **Start period**: 10s

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

### Health check failing

Check if the Squid container started:

```bash
docker ps | grep awf-squid
```

View Squid container logs (includes auth proxy output):

```bash
docker logs awf-squid
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

- Only supports OpenAI, Anthropic, and GitHub Copilot APIs
- Keys must be set as environment variables (not file-based)
- No support for Azure OpenAI endpoints
- No request/response logging (by design, for security)

## Related documentation

- [Authentication Architecture](./authentication-architecture.md) — detailed credential isolation internals
- [Security](./security.md) — overall security model
- [Environment Variables](./environment.md) — environment variable configuration
- [Troubleshooting](./troubleshooting.md) — common issues and solutions
- [Architecture](./architecture.md) — overall system architecture
