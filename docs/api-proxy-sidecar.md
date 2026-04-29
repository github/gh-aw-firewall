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
│         │  │   http://172.30.0.30:10000   │────┘
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

The agent container automatically uses `http://172.30.0.30:10000` as the OpenAI base URL.

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

AWF manages environment variables differently across the three containers (squid, api-proxy, agent) to ensure secure credential isolation.

### Squid container

The Squid proxy container runs with minimal environment variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `HTTP_PROXY` | Not set | Squid is the proxy, not a client |
| `HTTPS_PROXY` | Not set | Squid is the proxy, not a client |

### API proxy container

The API proxy sidecar receives **real credentials** and routing configuration:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_API_KEY` | Real API key | `--enable-api-proxy` and env set | OpenAI API key (injected into requests) |
| `ANTHROPIC_API_KEY` | Real API key | `--enable-api-proxy` and env set | Anthropic API key (injected into requests) |
| `COPILOT_GITHUB_TOKEN` | Real token | `--enable-api-proxy` and env set | GitHub Copilot token (injected into requests) |
| `COPILOT_API_KEY` | Real API key | `--enable-api-proxy` and env set | GitHub Copilot BYOK key (injected into requests) |
| `GEMINI_API_KEY` | Real API key | `--enable-api-proxy` and env set | Google Gemini API key (injected into requests) |
| `HTTP_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid for domain filtering |
| `HTTPS_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid for domain filtering |

:::danger[Real credentials in api-proxy]
The api-proxy container holds **real, unredacted credentials**. These are used to authenticate requests to LLM providers. This container is isolated from the agent and has all capabilities dropped for security.
:::

### Agent container

The agent container receives **redacted placeholders** and proxy URLs:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_BASE_URL` | `http://172.30.0.30:10000` | `OPENAI_API_KEY` provided to host | Redirects OpenAI SDK to proxy |
| `ANTHROPIC_BASE_URL` | `http://172.30.0.30:10001` | `ANTHROPIC_API_KEY` provided to host | Redirects Anthropic SDK to proxy |
| `ANTHROPIC_AUTH_TOKEN` | `placeholder-token-for-credential-isolation` | `ANTHROPIC_API_KEY` provided to host | Placeholder token (real auth via BASE_URL) |
| `CLAUDE_CODE_API_KEY_HELPER` | `/usr/local/bin/get-claude-key.sh` | `ANTHROPIC_API_KEY` provided to host | Helper script for Claude Code CLI |
| `COPILOT_API_URL` | `http://172.30.0.30:10002` | `COPILOT_GITHUB_TOKEN` or `COPILOT_API_KEY` provided to host | Redirects Copilot CLI to proxy |
| `COPILOT_TOKEN` | `placeholder-token-for-credential-isolation` | `COPILOT_GITHUB_TOKEN` or `COPILOT_API_KEY` provided to host | Placeholder token (real auth via API_URL) |
| `COPILOT_GITHUB_TOKEN` | `placeholder-token-for-credential-isolation` | `COPILOT_GITHUB_TOKEN` provided to host | Placeholder token protected by one-shot-token |
| `COPILOT_API_KEY` | `placeholder-token-for-credential-isolation` | `COPILOT_API_KEY` provided to host | BYOK placeholder token protected by one-shot-token |
| `COPILOT_OFFLINE` | `true` | `COPILOT_API_KEY` provided to host | Enables offline+BYOK mode (skips GitHub OAuth handshake) |
| `COPILOT_PROVIDER_BASE_URL` | `http://172.30.0.30:10002` | `COPILOT_API_KEY` provided to host | Points Copilot CLI BYOK provider at sidecar |
| `COPILOT_PROVIDER_API_KEY` | `placeholder-token-for-credential-isolation` | `COPILOT_API_KEY` provided to host | BYOK provider API key placeholder (real key in sidecar) |
| `GEMINI_API_BASE_URL` | `http://172.30.0.30:10003` | `GEMINI_API_KEY` provided to host | Redirects Gemini CLI to proxy |
| `GEMINI_API_KEY` | `gemini-api-key-placeholder-for-credential-isolation` | `GEMINI_API_KEY` provided to host | Placeholder so Gemini CLI auth check passes (real key in sidecar) |
| `OPENAI_API_KEY` | Not set | `--enable-api-proxy` | Excluded from agent (held in api-proxy) |
| `ANTHROPIC_API_KEY` | Not set | `--enable-api-proxy` | Excluded from agent (held in api-proxy) |
| `HTTP_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `HTTPS_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `NO_PROXY` | `localhost,127.0.0.1,172.30.0.30` | `--enable-api-proxy` | Bypass proxy for localhost and api-proxy |
| `AWF_API_PROXY_IP` | `172.30.0.30` | `--enable-api-proxy` | Used by iptables setup script |
| `AWF_ONE_SHOT_TOKENS` | `COPILOT_GITHUB_TOKEN,GITHUB_TOKEN,...` | Always | Tokens protected by one-shot-token library |

:::note[Gemini setup is conditional]
`GEMINI_API_BASE_URL`, the `GEMINI_API_KEY` placeholder, the `~/.gemini` home directory mount, and the `AWF_GEMINI_ENABLED` signal are only configured when `GEMINI_API_KEY` is provided to the host AWF process. This avoids spurious log entries and unnecessary directory setup in non-Gemini runs (e.g. Copilot-only workflows).

**Important**: `GEMINI_API_KEY` must be set as a **runner-level environment variable** (e.g. `env: GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` in the workflow step), not only as a GitHub Actions secret. The AWF process running on the runner must be able to read it so it can pass the key to the api-proxy sidecar container.
:::

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
  ↓ (HTTP request to 172.30.0.30:10000)
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
- `GEMINI_API_KEY` — Google Gemini API key
- `COPILOT_GITHUB_TOKEN` — GitHub Copilot access token
- `COPILOT_API_KEY` — GitHub Copilot API key (BYOK)

:::caution[GitHub Actions: expose keys as runner env vars]
When running AWF in a GitHub Actions workflow, API keys must be available as **runner-level environment variables** — not just as GitHub Actions secrets. AWF reads the key from the environment at startup to pass it to the api-proxy sidecar container. Use `env:` in the workflow step and `sudo --preserve-env` to ensure keys pass through:

```yaml
- name: Run agent
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: sudo --preserve-env=GEMINI_API_KEY awf --enable-api-proxy ...
```

> **Note:** `sudo` strips most environment variables by default. Use `--preserve-env=VAR` (or `sudo -E` to preserve all) to ensure API keys are visible to the AWF process.

If the key is present only in `secrets.*` but not exported into the step's `env:`, AWF will warn that no Gemini key was found and the api-proxy Gemini listener will return `503`.
:::

**Recommended domain whitelist**:
- `api.openai.com` — for OpenAI/Codex
- `api.anthropic.com` — for Anthropic/Claude

**Optional flags for custom upstream endpoints**:

| Flag | Default | Description |
|------|---------|-------------|
| `--openai-api-target <host>` | `api.openai.com` | Custom upstream for OpenAI API requests (e.g. Azure OpenAI or an internal LLM router). Can also be set via `OPENAI_API_TARGET` env var. |
| `--anthropic-api-target <host>` | `api.anthropic.com` | Custom upstream for Anthropic API requests (e.g. an internal Claude router). Can also be set via `ANTHROPIC_API_TARGET` env var. |
| `--copilot-api-target <host>` | auto-derived | Custom upstream for GitHub Copilot API requests (useful for GHES). Can also be set via `COPILOT_API_TARGET` env var. |

> **Important**: When using a custom `--openai-api-target` or `--anthropic-api-target`, you must add the target domain to `--allow-domains` so the firewall permits outbound traffic. AWF will emit a warning if a custom target is set but not in the allowlist.

### Container configuration

The sidecar container:
- **Image**: `ghcr.io/github/gh-aw-firewall/api-proxy:latest`
- **Base**: `node:22-alpine`
- **Network**: `awf-net` at `172.30.0.30`
- **Ports**: 10000 (OpenAI), 10001 (Anthropic), 10002 (GitHub Copilot), 10003 (Google Gemini), 10004 (OpenCode)
- **Proxy**: Routes via Squid at `http://172.30.0.10:3128`

### Health check

Docker healthcheck on the `/health` endpoint (port 10000):
- **Interval**: 1s
- **Timeout**: 1s
- **Retries**: 5
- **Start period**: 2s

The `/health` endpoint returns a JSON object that includes a `models_fetch_complete` field, indicating whether the startup model-discovery pass has finished:

```json
{
  "status": "healthy",
  "service": "awf-api-proxy",
  "providers": { "openai": true, "anthropic": false, "gemini": false, "copilot": false },
  "key_validation": { "complete": true, "results": { "openai": "valid" } },
  "models_fetch_complete": true,
  ...
}
```

Use `models_fetch_complete` as a readiness gate before submitting the first inference request, ensuring model lists are warm. See the [Readiness polling](#readiness-polling) recipe below.

### Readiness polling

Poll `/health` (or `/reflect`) until `models_fetch_complete: true` before launching the agent command, so model lists are fully cached:

```bash
# Wait up to 30 seconds for model discovery to complete
for i in $(seq 1 30); do
  result=$(curl -sf http://172.30.0.30:10000/health 2>/dev/null)
  if [ "$(echo "$result" | jq -r '.models_fetch_complete')" = "true" ]; then
    echo "Model discovery complete"
    break
  fi
  echo "Waiting for model discovery... ($i/30)"
  sleep 1
done
```

Or use `/reflect` directly if you also need the model lists:

```bash
curl -sf http://172.30.0.30:10000/reflect | jq '.models_fetch_complete, .endpoints[].models'
```

### Reflection endpoint

The management port (10000) also exposes a `GET /reflect` endpoint for dynamic provider and model discovery. This allows agent harnesses to query which providers are configured and which models are available at runtime.

```bash
curl http://172.30.0.30:10000/reflect
```

**Example response:**

```json
{
  "endpoints": [
    {
      "provider": "openai",
      "port": 10000,
      "base_url": "http://api-proxy:10000",
      "configured": true,
      "models": ["gpt-4o", "gpt-4o-mini"],
      "models_url": "http://api-proxy:10000/v1/models"
    },
    {
      "provider": "anthropic",
      "port": 10001,
      "base_url": "http://api-proxy:10001",
      "configured": false,
      "models": null,
      "models_url": "http://api-proxy:10001/v1/models"
    },
    {
      "provider": "copilot",
      "port": 10002,
      "base_url": "http://api-proxy:10002",
      "configured": true,
      "models": ["gpt-4o", "claude-3.5-sonnet"],
      "models_url": "http://api-proxy:10002/models"
    },
    {
      "provider": "gemini",
      "port": 10003,
      "base_url": "http://api-proxy:10003",
      "configured": false,
      "models": null,
      "models_url": "http://api-proxy:10003/v1beta/models"
    },
    {
      "provider": "opencode",
      "port": 10004,
      "base_url": "http://api-proxy:10004",
      "configured": true,
      "models": null,
      "models_url": null
    }
  ],
  "models_fetch_complete": true
}
```

Fields:
- `configured` — `true` if an API key for this provider was found at startup
- `models` — list of model IDs fetched from the provider at startup; `null` if the provider is not configured or model fetch failed
- `models_fetch_complete` — `true` once the startup model-fetch pass has finished
- `models_url` — URL to query for the live model list; `null` for OpenCode (which routes to other providers)

## Troubleshooting

### Gemini proxy returns 503

When `--enable-api-proxy` is active, `GEMINI_API_BASE_URL` and a placeholder `GEMINI_API_KEY` are always injected into the agent container. If the real `GEMINI_API_KEY` was not set in the AWF runner environment, the api-proxy Gemini listener (port 10003) responds with **503** to all requests.

**Solution**: Export `GEMINI_API_KEY` in the runner environment before invoking AWF. In GitHub Actions, add it to the step's `env:` block and use `sudo --preserve-env`:

```yaml
- name: Run Gemini agent
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: |
    sudo --preserve-env=GEMINI_API_KEY \
      awf --enable-api-proxy \
          --allow-domains generativelanguage.googleapis.com \
          -- gemini ...
```

> **Note:** Exit code 41 ("no auth method") should no longer occur with `--enable-api-proxy` since the placeholder key satisfies the CLI's pre-flight check. If you see exit 41, ensure `--enable-api-proxy` is active.

### API keys not detected

```
⚠️  API proxy enabled but no API keys found in environment
   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, COPILOT_GITHUB_TOKEN, or COPILOT_API_KEY to use the proxy
```

**Solution**: Export API keys before running awf (use `sudo --preserve-env` in CI):

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

- Keys must be set as environment variables (not file-based)
- No support for Azure OpenAI endpoints (use `--openai-api-target` for custom endpoints)
- No request/response logging (by design, for security)

## Related documentation

- [Authentication Architecture](./authentication-architecture.md) — detailed credential isolation internals
- [Security](./security.md) — overall security model
- [Environment Variables](./environment.md) — environment variable configuration
- [Troubleshooting](./troubleshooting.md) — common issues and solutions
- [Architecture](./architecture.md) — overall system architecture
