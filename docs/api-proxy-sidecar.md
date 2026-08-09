---
title: API Proxy Sidecar
description: Secure LLM API credential management using an isolated proxy sidecar container.
---

The AWF firewall includes a Node.js-based API proxy sidecar that securely holds LLM API credentials, automatically injects authentication headers, and routes outbound HTTP/HTTPS through Squid. The sidecar is a trusted component and is explicitly exempt from Squid's domain allowlist.

:::note
For a deep dive into how AWF handles authentication tokens and credential isolation, see the [Authentication Architecture](./authentication-architecture.md) guide.
:::

## Overview

The API proxy sidecar is **always enabled**. It:
- **Isolates credentials**: API keys are never exposed to the agent container
- **Auto-authentication**: Automatically injects Bearer tokens and API keys
- **Multi-provider support**: Supports OpenAI, Anthropic, Copilot, Gemini, and Google Vertex AI
- **Transparent proxying**: Agent code uses standard SDK environment variables
- **Squid routing**: Outbound HTTP/HTTPS routes through Squid, with the trusted sidecar exempt from domain ACLs

### OTLP workload identity federation

For Google Cloud OTLP collectors, gh-aw can supply
`GH_AW_OTLP_WORKLOAD_IDENTITY` as a JSON object with `provider: gcp` (or
`google`), the Workload Identity Provider resource in `audience`, and an
optional `service-account`. The required `endpoint` field binds the exchanged
credential to one exact HTTPS collector endpoint. In fan-out mode, other
collectors retain their endpoint-specific headers and never receive the Google
access token. AWF forwards the GitHub Actions OIDC runtime credentials only to
the api-proxy sidecar. The sidecar exchanges the JWT via `sts.googleapis.com`,
optionally impersonates the service account, and injects the short-lived bearer
token into OTLP export requests for that endpoint. The sidecar is trusted and
already exempt from the agent egress allowlist, so its STS calls are not blocked.

This authenticates only spans exported by the api-proxy sidecar. It does not
configure cloud-token exchange for separate gh-aw jobs such as activation,
conclusion, or safe outputs; gh-aw must implement that per-job exchange.

:::note[Implementation vs. provider documentation]
The `--enable-api-proxy` CLI flag is deprecated and ignored — it is kept only so existing command lines and workflows continue to work. `--no-enable-api-proxy` is rejected as a runtime error; the API proxy cannot be disabled. Do not add the deprecated flag to new commands.
:::

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
          │ (Trusted sidecar: domain ACL bypass)
          ↓
  api.openai.com or api.anthropic.com
```

**Traffic flow:**
1. Agent makes a request to `172.30.0.30:10000` (OpenAI) or `172.30.0.30:10001` (Anthropic)
2. API proxy strips any client-supplied auth headers and injects the real credentials
3. API proxy routes the request through Squid via `HTTP_PROXY`/`HTTPS_PROXY`
4. Squid recognizes the trusted sidecar source IP and bypasses domain ACL evaluation
5. Request reaches `api.openai.com` or `api.anthropic.com`

## Usage

### Basic usage

```bash
# Set API keys in environment
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# The API proxy sidecar is always active; no flag is needed to enable it
sudo awf \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-command
```

### Codex (OpenAI) example

```bash
export OPENAI_API_KEY="sk-..."

sudo awf \
  --allow-domains api.openai.com \
  -- npx @openai/codex -p "write a hello world function"
```

The agent container automatically uses `http://172.30.0.30:10000` as the OpenAI base URL.

### Claude Code example

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf \
  --allow-domains api.anthropic.com \
  -- claude-code "write a hello world function"
```

The agent container automatically uses `http://172.30.0.30:10001` as the Anthropic base URL.

### Both providers

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

sudo awf \
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
| `OPENAI_API_KEY` | Real API key | env set on host | OpenAI API key (injected into requests) |
| `ANTHROPIC_API_KEY` | Real API key | env set on host | Anthropic API key (injected into requests) |
| `COPILOT_GITHUB_TOKEN` | Real token | env set on host | GitHub Copilot token — sidecar uses it to talk to `api.githubcopilot.com` (CAPI BYOK / offline mode). Triggers Copilot sidecar routing. |
| `COPILOT_PROVIDER_API_KEY` | Real API key | env set on host | BYOK provider API key (e.g. Azure / OpenRouter) injected into upstream requests. **Independently** triggers Copilot sidecar routing (no `COPILOT_GITHUB_TOKEN` required); typically combined with `COPILOT_PROVIDER_BASE_URL` to point at an arbitrary upstream. |
| `COPILOT_PROVIDER_BASE_URL` | Real upstream URL | env set on host | User-supplied upstream URL for direct-BYOK mode; sidecar forwards Copilot CLI requests there instead of `api.githubcopilot.com`. |
| `GEMINI_API_KEY` | Real API key | env set on host | Google Gemini API key (injected into requests) |
| `GOOGLE_API_KEY` | Real API key | env set on host | Google Vertex AI API key (injected into `x-goog-api-key` header) |
| `HTTP_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid; sidecar traffic is exempt from domain ACLs |
| `HTTPS_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid; sidecar traffic is exempt from domain ACLs |

:::danger[Real credentials in api-proxy]
The api-proxy container holds **real, unredacted credentials**. These are used to authenticate requests to LLM providers. This container is isolated from the agent and has all capabilities dropped for security.
:::

### Agent container

The agent container receives **redacted placeholders** and proxy URLs:

| Variable | Value | When set | Description |
|----------|-------|----------|-------------|
| `OPENAI_BASE_URL` | `http://172.30.0.30:10000` | `OPENAI_API_KEY` provided to host | Redirects OpenAI SDK to proxy |
| `ANTHROPIC_BASE_URL` | `http://172.30.0.30:10001` | `ANTHROPIC_API_KEY` provided to host | Redirects Anthropic SDK to proxy |
| `ANTHROPIC_AUTH_TOKEN` | `sk-ant-placeholder-key-for-credential-isolation` | `ANTHROPIC_API_KEY` provided to host, or Anthropic WIF configured | Non-secret placeholder accepted by Claude clients (real auth via `ANTHROPIC_BASE_URL`) |
| `CLAUDE_CODE_API_KEY_HELPER` | `/usr/local/bin/get-claude-key.sh` | `ANTHROPIC_API_KEY` provided to host | Helper script for Claude Code CLI |
| `COPILOT_API_URL` | `http://172.30.0.30:10002` | `COPILOT_GITHUB_TOKEN` or `COPILOT_PROVIDER_API_KEY` provided to host | Redirects Copilot CLI to sidecar |
| `COPILOT_TOKEN` | `ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `COPILOT_GITHUB_TOKEN` or `COPILOT_PROVIDER_API_KEY` provided to host | Placeholder token (real auth via API_URL) |
| `COPILOT_GITHUB_TOKEN` | `ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `COPILOT_GITHUB_TOKEN` provided to host | Placeholder token protected by one-shot-token (real token in sidecar) |
| `COPILOT_OFFLINE` | `true` | `COPILOT_GITHUB_TOKEN` or `COPILOT_PROVIDER_API_KEY` provided to host | Enables offline+BYOK mode (skips GitHub OAuth handshake) |
| `COPILOT_PROVIDER_BASE_URL` | `http://172.30.0.30:10002` | `COPILOT_GITHUB_TOKEN` or `COPILOT_PROVIDER_API_KEY` provided to host | Points Copilot CLI BYOK provider at sidecar (real upstream URL, if any, held in sidecar) |
| `COPILOT_PROVIDER_API_KEY` | `ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `COPILOT_GITHUB_TOKEN` or `COPILOT_PROVIDER_API_KEY` provided to host | BYOK provider API key placeholder (real key in sidecar) |
| `GOOGLE_GEMINI_BASE_URL` | `http://172.30.0.30:10003` | `GEMINI_API_KEY` provided to host | Redirects Gemini CLI to proxy (primary var read by Gemini CLI) |
| `GEMINI_API_BASE_URL` | `http://172.30.0.30:10003` | `GEMINI_API_KEY` provided to host | Redirects Gemini SDK to proxy (kept for backward compatibility) |
| `GEMINI_API_KEY` | `gemini-api-key-placeholder-for-credential-isolation` | `GEMINI_API_KEY` provided to host | Placeholder so Gemini CLI auth check passes (real key in sidecar) |
| `GOOGLE_VERTEX_BASE_URL` | `http://172.30.0.30:10004` | `GOOGLE_API_KEY` provided to host | Redirects Vertex AI requests to proxy |
| `GOOGLE_API_KEY` | `google-api-key-placeholder-for-credential-isolation` | `GOOGLE_API_KEY` provided to host | Placeholder so Vertex mode auth checks pass (real key in sidecar) |
| `OPENAI_API_KEY` | `sk-placeholder-for-api-proxy` | `OPENAI_API_KEY` provided to host | Non-secret placeholder required by newer Codex clients; the real host value is excluded and held in the sidecar |
| `CODEX_API_KEY` | `sk-placeholder-for-api-proxy` | `OPENAI_API_KEY` provided to host | Non-secret placeholder for Codex routing; the sidecar replaces its auth header |
| `ANTHROPIC_API_KEY` | Not set | Always | Excluded from agent (held in api-proxy) |
| `HTTP_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `HTTPS_PROXY` | `http://172.30.0.10:3128` | Always | Routes through Squid proxy |
| `NO_PROXY` | `localhost,127.0.0.1,172.30.0.30` | Always | Bypass proxy for localhost and api-proxy |
| `AWF_API_PROXY_IP` | `172.30.0.30` | Always | Used by iptables setup script |
| `AWF_ONE_SHOT_TOKENS` | `COPILOT_GITHUB_TOKEN,GITHUB_TOKEN,...` | Always | Tokens protected by one-shot-token library |

:::note[Gemini setup is conditional]
`GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_BASE_URL`, the `GEMINI_API_KEY` placeholder, the `GOOGLE_VERTEX_BASE_URL`/`GOOGLE_API_KEY` placeholders, the `~/.gemini` home directory mount, and the `AWF_GEMINI_ENABLED` signal are only configured when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is provided to the host AWF process. This avoids spurious log entries and unnecessary directory setup in non-Gemini runs (e.g. Copilot-only workflows).

`GOOGLE_GEMINI_BASE_URL` is the primary variable read by the Gemini CLI (`google-gemini/gemini-cli`). `GEMINI_API_BASE_URL` is kept for backward compatibility with older SDK versions.

**Important**: `GEMINI_API_KEY` must be set as a **runner-level environment variable** (e.g. `env: GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` in the workflow step), not only as a GitHub Actions secret. The AWF process running on the runner must be able to read it so it can pass the key to the api-proxy sidecar container.
:::

:::tip[Placeholder tokens]
Token variables in the agent are set to placeholder values (for Copilot, `ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) instead of real values. This ensures:
- Agent code cannot exfiltrate credentials
- CLI tools that check for token presence still work
- Real authentication happens via the `*_BASE_URL` or `*_API_URL` environment variables
- The one-shot-token library protects placeholder values from being read more than once
:::

:::note[Implementation vs. provider documentation]
`ANTHROPIC_AUTH_TOKEN` is an official Anthropic SDK environment variable for bearer-token authentication. AWF does not currently consume it as a host-side source credential. AWF accepts `ANTHROPIC_API_KEY` for static auth, or Anthropic WIF configuration for short-lived bearer auth, and overwrites any host `ANTHROPIC_AUTH_TOKEN` with the non-secret agent placeholder shown above.
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

AWF separates agent egress control from trusted sidecar routing:
- The agent can only reach the API proxy IP (`172.30.0.30`) for API calls
- The sidecar routes all traffic through Squid proxy
- Squid enforces domain ACLs for agent-originated traffic
- Squid explicitly allows all traffic from the trusted api-proxy source IP before domain ACL evaluation
- iptables rules prevent the agent from bypassing the proxy

:::danger[The sidecar is allowlist-exempt]
The api-proxy holds live credentials and has unrestricted outbound HTTP/HTTPS access through Squid. It is part of AWF's trusted computing base. The agent domain allowlist does not contain a compromised sidecar.
:::

:::note[Squid allow rule for api-proxy IP]
Squid includes an explicit `allow_api_proxy_ip` ACL that permits traffic to the api-proxy IP **before** the raw-IP deny rules. This is required because some HTTP clients (such as Node.js `fetch`/`undici` with a `ProxyAgent`) route requests to the api-proxy through `HTTP_PROXY` without honouring `NO_PROXY` for raw IP addresses. Without this rule, those requests would be rejected by Squid's raw-IP deny rules even though `NO_PROXY=172.30.0.30` is set in the agent container.
:::

### Resource limits

The sidecar has strict resource constraints:
- 512 MB memory limit
- 100 process limit
- All capabilities dropped
- `no-new-privileges` security option

## How it works

### 1. Container startup

The API proxy sidecar is always started:
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
  ↓ (trusted sidecar bypasses domain ACLs)
  ↓ (TLS connection to api.openai.com)
OpenAI API
```

### 3. Header injection

The Node.js proxy automatically:
- **Strips** any client-supplied `Authorization`, `x-api-key`, `Proxy-Authorization`, and `X-Forwarded-*` headers
- **Injects** the correct authentication headers:
  - **OpenAI**: `Authorization: Bearer $OPENAI_API_KEY`
  - **Anthropic**: `x-api-key: $ANTHROPIC_API_KEY` and `anthropic-version: 2023-06-01` (if not already set by the client)

#### Anthropic deprecated header value handling

The proxy automatically detects and corrects deprecated `anthropic-beta` header values:
- **Automatic retry**: When Anthropic returns a 400 error indicating a deprecated `anthropic-beta` value (e.g., `context-1m-2025-08-07`), the proxy removes the deprecated value and retries the request without affecting other beta values
- **Learning**: After detecting a deprecated value in one request, the proxy proactively strips it from all subsequent requests in the same run
- **Transparent**: This retry and correction happens automatically without requiring any changes to client code

Example: If a request includes `anthropic-beta: context-1m-2025-08-07,other-beta` and Anthropic rejects the first value, the proxy retries with `anthropic-beta: other-beta`, and future requests in the same run will also skip the deprecated value.

:::caution
The proxy enforces a 10 MB request body size limit to prevent denial-of-service via large payloads.
:::

### 4. Pre-flight health check

Before running the user command, the agent container runs a health check script (`api-proxy-health-check.sh`) that verifies:
- Real API keys are **not** present in the agent environment; expected placeholders are allowed
- The API proxy is reachable and responding (connectivity established)

The script currently checks configured Anthropic, OpenAI, and Copilot routes. It does not pre-flight the Gemini or Vertex listeners. If a checked route fails credential-isolation or TCP-connectivity validation, the agent exits without running the user command.

## Configuration reference

### CLI options

```bash
sudo awf [OPTIONS] -- COMMAND
```

`--enable-api-proxy` is accepted but deprecated (no-op) — see the note at the top of this document.

**Provider credential environment variables** (configure at least one to use an LLM provider):
- `OPENAI_API_KEY` — OpenAI API key
- `ANTHROPIC_API_KEY` — Anthropic API key
- `GEMINI_API_KEY` — Google Gemini API key
- `GOOGLE_API_KEY` — Google Vertex AI API key
- `COPILOT_GITHUB_TOKEN` — GitHub Copilot access token. Sidecar routes Copilot CLI to `api.githubcopilot.com` (CAPI BYOK / offline mode).
- `COPILOT_PROVIDER_API_KEY` — BYOK provider API key (Azure Foundry / OpenRouter / custom OpenAI-compatible upstream). **Independently** enables Copilot sidecar routing without `COPILOT_GITHUB_TOKEN`; typically combined with `COPILOT_PROVIDER_BASE_URL` to point at an arbitrary upstream.

:::caution[GitHub Actions: expose keys as runner env vars]
When running AWF in a GitHub Actions workflow, API keys must be available as **runner-level environment variables** — not just as GitHub Actions secrets. AWF reads the key from the environment at startup to pass it to the api-proxy sidecar container. Use `env:` in the workflow step and `sudo --preserve-env` to ensure keys pass through:

```yaml
- name: Run agent
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: sudo --preserve-env=GEMINI_API_KEY awf ...
```

> **Note:** `sudo` strips most environment variables by default. Use `--preserve-env=VAR` (or `sudo -E` to preserve all) to ensure API keys are visible to the AWF process.

If the key is present only in `secrets.*` but not exported into the step's `env:`, AWF will warn that no Gemini key was found and the api-proxy Gemini listener will return `503`.
:::

**Recommended agent domain policy**:
- `api.openai.com` — for OpenAI/Codex
- `api.anthropic.com` — for Anthropic/Claude

These entries document and constrain agent-originated traffic. They do not constrain the trusted api-proxy, whose source IP bypasses Squid's domain ACLs.

**Optional flags for custom upstream endpoints**:

| Flag | Default | Description |
|------|---------|-------------|
| `--openai-api-target <host>` | `api.openai.com` | Custom upstream for OpenAI API requests (e.g. Azure OpenAI or an internal LLM router). Can also be set via `OPENAI_API_TARGET` env var (or `OPENAI_ENDPOINT_OVERRIDE` for runtime secret-backed endpoint injection). |
| `--anthropic-api-target <host>` | `api.anthropic.com` | Custom upstream for Anthropic API requests (e.g. an internal Claude router). Can also be set via `ANTHROPIC_API_TARGET` env var. |
| `--copilot-api-target <host>` | auto-derived | Custom upstream for GitHub Copilot API requests (useful for GHES). Can also be set via `COPILOT_API_TARGET` env var. |
| `--gemini-api-target <host>` | `generativelanguage.googleapis.com` | Custom upstream for Gemini API requests. Can also be set via `GEMINI_API_TARGET` env var. |
| `--gemini-api-base-path <path>` | empty | Base path prefix for Gemini API requests. Can also be set via `GEMINI_API_BASE_PATH` env var. |
| `--vertex-api-target <host>` | `aiplatform.googleapis.com` | Custom upstream for Vertex API requests. Can also be set via `VERTEX_API_TARGET` env var. |
| `--vertex-api-base-path <path>` | empty | Base path prefix for Vertex API requests. Can also be set via `VERTEX_API_BASE_PATH` env var. |
| `--openai-api-auth-header <name>` | `Authorization` (with `Bearer` prefix) | Custom auth header name for OpenAI requests — sends the raw key/token value with no prefix. Can also be set via `AWF_OPENAI_AUTH_HEADER` env var. |
| `--anthropic-api-auth-header <name>` | `x-api-key` | Custom auth header name for Anthropic requests — sends the raw key/token value with no prefix. Can also be set via `AWF_ANTHROPIC_AUTH_HEADER` env var. |

> **Important**: When using a custom `--openai-api-target` or `--anthropic-api-target`, you must add the target domain to `--allow-domains` so the firewall permits outbound traffic. AWF will emit a warning if a custom target is set but not in the allowlist.

### Anthropic prompt-cache optimizations

Use `--anthropic-auto-cache` to enable automatic Anthropic prompt-caching in the API proxy. When enabled, the proxy:

- Injects cache breakpoints on tools, system, and messages blocks
- Upgrades the cache TTL to 1 hour via the `anthropic-beta: extended-cache-ttl-2025-04-11` header
- Strips ANSI escape codes from request payloads (which can prevent cache hits)

This typically saves ~90% on Anthropic API input costs for repeated or long-running agentic sessions.

```bash
sudo awf \
  --anthropic-auto-cache \
  --allow-domains api.anthropic.com \
  -- claude --dangerously-skip-permissions
```

Use `--anthropic-cache-tail-ttl` to control the TTL for the rolling-tail cache breakpoint:

| Value | When to use |
|-------|-------------|
| `5m` (default) | Fast interactive sessions where prompts change frequently |
| `1h` | Long agentic tasks with large stable context windows |

```bash
# Long-running agentic task — use 1h TTL for maximum cache reuse
sudo awf \
  --anthropic-auto-cache \
  --anthropic-cache-tail-ttl 1h \
  --allow-domains api.anthropic.com \
  -- claude --dangerously-skip-permissions
```

**Config file equivalent:**

```yaml
apiProxy:
  anthropicAutoCache: true
  anthropicCacheTailTtl: "1h"
```

### Container configuration

The sidecar container:
- **Image**: `ghcr.io/github/gh-aw-firewall/api-proxy:latest`
- **Base**: `node:22-alpine`
- **Network**: `awf-net` at `172.30.0.30`
- **Ports**: 10000 (OpenAI), 10001 (Anthropic), 10002 (GitHub Copilot), 10003 (Google Gemini), 10004 (Google Vertex AI)
- **Proxy**: Routes via Squid at `http://172.30.0.10:3128`

## Model Fallback

When a model requested by an agent is unavailable on the target provider, the API proxy can automatically select an alternative using the **middle-power strategy**. This ensures requests complete without interruption.

### Configuration

Enable model fallback in your AWF config or via CLI:

**Config file:**
```yaml
apiProxy:
  modelFallback:
    enabled: true
    strategy: middle_power
```

**CLI:**
Currently, model fallback is enabled by default when the API proxy is active. Set `apiProxy.modelFallback.enabled: false` in the config file to disable it.

### How it works

When a model request is not found:

1. The proxy checks if an exact model match exists on the provider — if so, use it
2. For `gpt-5.*` requests on OpenAI, check if a lower `gpt-5.*` version is available — if so, use it
3. Check if a model alias can resolve the request — if so, use the result
4. **Activate fallback** (if enabled): Select the median-tier model from all available models
   - Sorts models by capability tier: **Opus/GPT-5** (tier 5) → **Sonnet/GPT-4** (tier 4) → **Haiku/GPT-3.5** (tier 3) → others
   - Selects the middle model from this sorted list
   - Logs the fallback reason and full candidate list

For Copilot BYOK configurations that target non-`githubcopilot` endpoints (for
example Azure OpenAI deployment URLs), middle-power fallback is automatically
suppressed to avoid rewriting provider-specific deployment names.

**Example:**
```
Agent requests: "unknown-model" on Anthropic
Available models: ["claude-haiku-4-5", "claude-opus-4-1", "claude-sonnet-4-5"]
Sorted by tier: ["claude-opus-4-1" (tier 5), "claude-sonnet-4-5" (tier 4), "claude-haiku-4-5" (tier 3)]
Selected: claude-sonnet-4-5 (median)
Reason: no_alias_match_and_not_in_available_models
```

### Extended Alias Syntax

Model aliases now support per-alias fallback control:

**Legacy syntax** (string array) — fallback is **enabled**:
```yaml
apiProxy:
  models:
    sonnet: ["copilot/*sonnet*", "openai/*sonnet*"]
```

**Extended syntax** (object with patterns and fallback flag):
```yaml
apiProxy:
  models:
    fast:
      patterns: ["copilot/gpt-4*", "openai/gpt-4*"]
      fallback: false  # Disable fallback for this alias
    sonnet:
      patterns: ["copilot/*sonnet*"]
      fallback: true   # Enable fallback (default)
```

When `fallback: false`, if the alias patterns produce no candidates, resolution fails instead of trying middle-power fallback.

### Disabling Fallback

To disable automatic fallback and return an error when a model is unavailable:

```yaml
apiProxy:
  modelFallback:
    enabled: false
```

Or for a specific alias:

```yaml
apiProxy:
  models:
    strict-sonnet:
      patterns: ["copilot/*sonnet*"]
      fallback: false
```

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
  "squid_proxy": "http://172.30.0.10:3128",
  "providers": { "openai": true, "anthropic": false, "gemini": false, "copilot": false },
  "key_validation": { "complete": true, "results": { "openai": "valid" } },
  "models_fetch_complete": true,
  "model_fallback": { "enabled": true, "strategy": "middle_power" },
  "metrics_summary": { "total_requests": 0, "success_rate": 100, "avg_latency_ms": 0 },
  "rate_limits": {}
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
      "model_metadata": [
        {
          "id": "gpt-4o",
          "source": "provider",
          "observed_at": "2026-07-28T00:00:00.000Z",
          "api_version": "2026-07-01",
          "pricing": {
            "default": {
              "input": 2.5,
              "cachedInput": 0.25,
              "cacheWrite": null,
              "output": 10,
              "threshold": 272000
            }
          }
        }
      ],
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
  ],
  "models_fetch_complete": true
}
```

Fields:
- `configured` — `true` if an API key for this provider was found at startup
- `models` — list of model IDs fetched from the provider at startup; `null` if the provider is not configured or model fetch failed
- `model_metadata` — sanitized provider metadata, including pricing and provenance when the provider supplies it; currently Copilot supplies runtime pricing
- `models_fetch_complete` — `true` once the startup model-fetch pass has finished
- `models_url` — URL to query for the live model list

Copilot discovery requests use API version `2026-07-01`. Runtime Copilot prices
override bundled prices, including default and long-context tiers. Other
providers continue to use bundled pricing because their model-list APIs do not
currently advertise token prices. Failed or empty refreshes retain the last
successful snapshot.

Explicit `apiProxy.providers` model-cost overlays take precedence over runtime
and bundled pricing. Overlay costs use the models.dev format (dollars per token)
and are normalized to dollars per million tokens inside the proxy.

## Troubleshooting

The [Auth Doctor Updater workflow](../.github/workflows/auth-doctor-updater.md) periodically audits this guide against current implementation, recent repository changes, and official provider guidance. It opens file-bounded documentation pull requests without probing credentials, exchanging tokens, or calling inference APIs.

### Gemini proxy returns 503

When `GEMINI_API_KEY` is provided to the AWF runner, `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_BASE_URL`, and a placeholder `GEMINI_API_KEY` are injected into the agent container. If the real `GEMINI_API_KEY` was not set in the AWF runner environment, the Gemini routing vars are never set and the api-proxy Gemini listener (port 10003) responds with **503** to any requests that do reach it.

**Solution**: Export `GEMINI_API_KEY` in the runner environment before invoking AWF. In GitHub Actions, add it to the step's `env:` block and use `sudo --preserve-env`:

```yaml
- name: Run Gemini agent
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: |
    sudo --preserve-env=GEMINI_API_KEY \
      awf \
          --allow-domains generativelanguage.googleapis.com \
          -- gemini ...
```

> **Note:** Exit code 41 ("no auth method") should no longer occur since the placeholder key satisfies the CLI's pre-flight check. If you see exit 41, verify `GEMINI_API_KEY` is exported in the AWF runner environment.

### Gemini requests blocked by Squid (connection refused / raw-IP denied)

Some versions of the Gemini CLI use the Node.js `undici` HTTP client, which routes requests to the api-proxy sidecar (`http://172.30.0.30:10003`) through `HTTP_PROXY` even when `NO_PROXY=172.30.0.30` is set. Squid's raw-IP deny rules would then reject these connections.

**Resolution (v0.x+):** AWF now adds a `allow_api_proxy_ip` ACL in the Squid configuration that explicitly permits connections to the api-proxy IP **before** the raw-IP deny rules. No action is required on your part — upgrading AWF to a version that includes this fix is sufficient.

### API keys not detected

```
⚠️  API proxy enabled but no API keys found in environment
   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, COPILOT_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY to use the proxy
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
sudo awf \
  --allow-domains api.openai.com,api.anthropic.com \
  -- your-command
```

Check Squid logs for denied requests:

```bash
docker exec awf-squid cat /var/log/squid/access.log | grep DENIED
```

## OIDC Authentication

AWF supports OIDC-based credential exchange with multiple cloud providers via GitHub Actions workload identity federation. Set `AWF_AUTH_TYPE=github-oidc` and `AWF_AUTH_PROVIDER` to select the provider.

### Common environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWF_AUTH_TYPE` | ✅ | Set to `github-oidc` to enable OIDC authentication |
| `AWF_AUTH_PROVIDER` | No | Cloud provider: `azure` (default), `aws`, `gcp`, or `anthropic` |
| `AWF_AUTH_OIDC_AUDIENCE` | No | Override the OIDC audience (provider-specific defaults apply) |
| `ACTIONS_ID_TOKEN_REQUEST_URL` | ✅ | Provided automatically by the GitHub Actions runtime |
| `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | ✅ | Provided automatically by the GitHub Actions runtime |

Never print or inspect either Actions OIDC variable. Documentation audits should verify the `id-token: write` permission and the presence/consistency of non-secret provider configuration instead.

:::note[OIDC request capability is sidecar-only]
AWF forwards `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` only to the api-proxy sidecar when `AWF_AUTH_TYPE=github-oidc`. The variables are excluded from the agent even when `--env-all`, `--env-file`, or explicit `--env` options request them. The minted GitHub JWT and exchanged provider credentials also remain inside the sidecar.

GitHub Agentic Workflows handles HTTP MCP `auth.type: github-oidc` separately: the compiler-generated, runner-owned **Start MCP Gateway** step passes the Actions variables directly to the MCP gateway, which mints an audience-bound JWT for the remote server. AWF neither launches nor configures that gateway, and the variables do not need to pass through the agent. [github/gh-aw#50053](https://github.com/github/gh-aw/issues/50053) is resolved by [github/gh-aw#50054](https://github.com/github/gh-aw/pull/50054); recompile older workflow lock files that predate this direct runner-to-gateway path.
:::

When `AWF_AUTH_TYPE=github-oidc` is set but `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` are not available in the sidecar, Anthropic OIDC requests fail closed with:

- `503 Anthropic OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write).`

### Azure OpenAI (Entra-only)

Exchanges the GitHub OIDC JWT for an Azure AD access token via workload identity federation, then injects it as a Bearer token on upstream requests.

#### Azure-specific environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWF_AUTH_AZURE_TENANT_ID` | ✅ | — | Azure AD tenant ID |
| `AWF_AUTH_AZURE_CLIENT_ID` | ✅ | — | Azure AD application (client) ID for the federated credential |
| `AWF_AUTH_AZURE_SCOPE` | No | `https://cognitiveservices.azure.com/.default` | Azure token scope |
| `AWF_AUTH_AZURE_CLOUD` | No | `public` | Azure cloud environment (`public`, `usgovernment`, or `china`) |

Default OIDC audience: `api://AzureADTokenExchange`

:::caution[Agent routing is not automatically configured]
Azure OIDC can initialize in the sidecar, but OIDC configuration alone does not set `OPENAI_BASE_URL` or OpenAI compatibility placeholders in the agent. `buildOpenAiCredentialEnv()` currently enables agent routing only when `OPENAI_API_KEY` is configured. Until OIDC-aware OpenAI routing is implemented, AWF does not provide a complete keyless Azure OpenAI invocation path.
:::

### AWS Bedrock

Exchanges the GitHub OIDC JWT for temporary AWS credentials via STS `AssumeRoleWithWebIdentity`, caches/refreshes them, and signs outbound Bedrock Runtime requests with SigV4.

#### AWS-specific environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWF_AUTH_AWS_ROLE_ARN` | ✅ | — | IAM role ARN to assume via OIDC federation |
| `AWF_AUTH_AWS_REGION` | ✅ | — | AWS region for the Bedrock endpoint |
| `AWF_AUTH_AWS_ROLE_SESSION_NAME` | No | `awf-oidc-session` | Session name for the STS call |

Default OIDC audience: `sts.amazonaws.com`

:::note[SigV4 signing]
The OpenAI and Copilot adapters sign each final outbound HTTP request with the temporary STS access key, secret key, and session token. Signing covers the method, canonical path/query, transformed body hash, regional target host, `AWF_AUTH_AWS_REGION`, and the `bedrock-runtime` service. Credentials remain inside the sidecar, retries are re-signed, and requests fail closed with `503` while credentials are unavailable.

For credential-leak prevention, the target must exactly match `bedrock-runtime.<region>.amazonaws.com` (or `bedrock-runtime.<region>.amazonaws.com.cn` in China). Configure that host through `OPENAI_API_TARGET` or `COPILOT_PROVIDER_BASE_URL`. Adding it to the agent allowlist may document the intended policy, but does not constrain sidecar egress.
:::

SigV4 support applies to buffered HTTP requests, including streaming HTTP responses. WebSocket upgrades in AWS OIDC mode are rejected rather than forwarded unsigned.

### GCP Vertex AI

Exchanges the GitHub OIDC JWT for a GCP access token via the Security Token Service, optionally followed by service account impersonation. The resulting token is injected as a Bearer token.

#### GCP-specific environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER` | ✅ | — | Full resource name of the Workload Identity Provider |
| `AWF_AUTH_GCP_SERVICE_ACCOUNT` | No | — | Service account email to impersonate (omit for direct access) |
| `AWF_AUTH_GCP_SCOPE` | No | `https://www.googleapis.com/auth/cloud-platform` | OAuth2 scope |

Default OIDC audience: the `gcpWorkloadIdentityProvider` value

:::note
`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are injected by the Actions runner automatically. AWF forwards them to the sidecar when `AWF_AUTH_TYPE=github-oidc` and excludes them from the agent container.
:::

:::tip
When `gcpServiceAccount` is omitted, the federated token is used directly without service account impersonation. This requires that the federated principal has direct access grants on the target resource.
:::

:::note[Implementation vs. provider documentation]
GCP OIDC with Vertex-hosted models is served through the **OpenAI adapter** (`OPENAI_API_TARGET`/`--openai-api-target` pointed at a Vertex AI OpenAI-compatible endpoint), not through the native Vertex AI adapter (port 10004). The native Vertex adapter is static-`GOOGLE_API_KEY`-only and has no OIDC/WIF support today — see the [auth matrix](./auth-matrix.md#provider-google-vertex-ai) for details.

The OpenAI-compatible Vertex endpoint also requires a resource-specific base path such as `/v1/projects/PROJECT_ID/locations/LOCATION/endpoints/openapi`. Set it with `OPENAI_API_BASE_PATH` or `--openai-api-base-path`; replace the example project and location with your own values.
:::

:::caution[Agent routing is not automatically configured]
GCP OIDC can initialize in the sidecar, but OIDC configuration alone does not set `OPENAI_BASE_URL` or OpenAI compatibility placeholders in the agent. `buildOpenAiCredentialEnv()` currently enables agent routing only when `OPENAI_API_KEY` is configured. Until OIDC-aware OpenAI routing is implemented, AWF does not provide a complete keyless Vertex OpenAI-compatible invocation path.
:::

### Anthropic API

Exchanges the GitHub OIDC JWT for an Anthropic Workload Identity Federation access token, then injects it as an `Authorization` header on upstream Anthropic API requests.

#### Anthropic-specific environment variables

| Environment variable | Required | Description |
|---|---|---|
| `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID` | ✅ | Anthropic federation rule ID (e.g. `fdrl_...`) |
| `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID` | ✅ | Anthropic organization UUID |
| `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID` | ✅ | Anthropic service account ID (e.g. `svac_...`) |
| `AWF_AUTH_ANTHROPIC_WORKSPACE_ID` | Conditional¹ | Anthropic workspace ID (e.g. `wrkspc_...`) |

¹ Required when the federation rule covers multiple workspaces. May be omitted when the rule is scoped to a single workspace.

Default OIDC audience: `https://api.anthropic.com`

For compatibility with Anthropic's official SDKs, AWF sends `anthropic-beta: oauth-2025-04-20,oidc-federation-2026-04-01` only on its JWT-bearer `POST /v1/oauth/token` exchange. Requests authenticated with the resulting bearer token send `oauth-2025-04-20`; they do not send the federation beta. Static `x-api-key` requests receive neither value, and forwarded refresh-token exchanges never receive the federation beta. AWF merges required values with client-supplied `anthropic-beta` values and the optional auto-cache beta without duplicates.

**Official references:** [Anthropic WIF documentation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) · [Anthropic TypeScript SDK federation exchange](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/lib/credentials/oidc-federation.ts) · [credential beta constants](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/lib/credentials/types.ts)

#### GitHub Actions example (Anthropic)

```yaml
jobs:
  agent:
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Run agent with Anthropic WIF
        env:
          AWF_AUTH_TYPE: github-oidc
          AWF_AUTH_PROVIDER: anthropic
          AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: fdrl_...
          AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: <your-org-uuid>
          AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: svac_...
          # AWF_AUTH_ANTHROPIC_WORKSPACE_ID: wrkspc_...  # required for multi-workspace rules
        run: |
          sudo --preserve-env=AWF_AUTH_TYPE,AWF_AUTH_PROVIDER,AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID,AWF_AUTH_ANTHROPIC_ORGANIZATION_ID,AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID,AWF_AUTH_ANTHROPIC_WORKSPACE_ID,ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN \
            awf \
                --allow-domains api.anthropic.com \
                -- your-agent-command
```

## Effective token budget

The API proxy can enforce a cumulative **effective token budget** per run. When enabled, the proxy tracks weighted token usage across all LLM requests and rejects new requests once the budget is exhausted.

### Configuration

Set in the AWF config file or via the `--max-model-multiplier` CLI flag:

```json
{
  "apiProxy": {
    "maxEffectiveTokens": 500000,
    "modelMultipliers": {
      "o3-pro": 15,
      "o3": 4,
      "claude-sonnet-4-20250514": 1,
      "gpt-4.1-mini": 0.5
    },
    "defaultModelMultiplier": 15
  }
}
```

Or equivalently from the command line:

```bash
awf --max-model-multiplier o3-pro:15,o3:4,claude-sonnet-4-20250514:1,gpt-4.1-mini:0.5 ...
```

When both the config file and the CLI flag specify a multiplier for the same model, the **CLI flag takes precedence**.

### How tokens are weighted

Raw token counts from upstream responses are not treated equally. Each category has a fixed weight that reflects its relative cost:

| Category | Weight | Example fields |
|----------|--------|----------------|
| Input | ×1.0 | `prompt_tokens`, `input_tokens` |
| Cache read | ×0.1 | `cache_read_input_tokens` |
| Output | ×4.0 | `completion_tokens`, `output_tokens` |
| Reasoning | ×4.0 | `reasoning_tokens` |

The formula for a single response is:

```
effective_tokens = model_multiplier × (1.0×input + 0.1×cache_read + 4.0×output + 4.0×reasoning)
```

If no model multiplier is configured, it defaults to `1`.

### Enforcement

After each successful upstream response, the proxy accumulates the effective tokens. Before forwarding the *next* request, the proxy checks the running total:

- **Under budget**: Request is forwarded normally.
- **Budget reached or exceeded**: Request is rejected immediately with:
  - **HTTP `403 Forbidden`**
  - **Error body**:

    ```json
    {
      "error": {
        "type": "effective_tokens_limit_exceeded",
        "message": "Maximum effective tokens exceeded (512345.67 / 500000).",
        "total_effective_tokens": 512345.67,
        "max_effective_tokens": 500000
      }
    }
    ```

WebSocket upgrade requests are also rejected with `403` when the budget is reached or exceeded.

:::caution
Once the budget is reached or exceeded, **all subsequent requests in the run are rejected**. The budget is not recoverable — there is no way to "free up" tokens within a single run. The rejection uses **HTTP `403`** (not `429`) precisely because the limit is terminal: a `429` would invite LLM SDK clients to retry with backoff against a cap that never recovers, burning the remaining run budget until the step times out.
:::

### Threshold tracking and token steering

The proxy tracks which usage thresholds have been crossed. When token steering is enabled (see below), it **injects a budget-warning message** into the body of the next eligible request sent to the upstream model:

| Threshold | Tracked once per run | Warning injected (when steering enabled) |
|-----------|-----------------------|------------------------------------------|
| 80% | Yes | Yes |
| 90% | Yes | Yes |
| 95% | Yes | Yes |
| 99% | Yes | Yes |

#### Enabling token steering

Token steering is **opt-in**. Pass `--enable-token-steering` on the CLI or set `apiProxy.enableTokenSteering: true` in the config file:

```yaml
apiProxy:
  maxEffectiveTokens: 500000
  enableTokenSteering: true
```

When disabled (the default), thresholds are still tracked and exposed via `/reflect`, but no warning messages are injected into request bodies.

To opt a workflow out explicitly, set `apiProxy.enableTokenSteering: false` (or omit the field). The CLI/config value is the only source of the sidecar's `AWF_ENABLE_TOKEN_STEERING` env var, which is emitted only when steering is enabled.

#### How steering messages are injected

When a threshold is crossed, the proxy modifies the outgoing request body of the *next* API call to include a system-level warning. This ensures the agent receives budget information even if it doesn't parse headers or error responses. The message format is:

```
[AWF TOKEN WARNING] You have used 90% of your effective token budget. Complete your current task and prepare final output.
```

When `--agent-timeout` is configured, the proxy also injects runtime steering messages at the same thresholds:

```
[AWF TIME WARNING] You have used 90% of your allotted run time. Complete your current task and prepare final output.
```

The injection is provider-aware:

| Provider | Injection mechanism |
|----------|---------------------|
| OpenAI / Copilot | Inserts `{"role":"system","content":"..."}` after existing system messages |
| Anthropic | Appends to the `system` field (string concat or block append) |
| Gemini | Appends `{"text":"..."}` to `systemInstruction.parts` |

Each threshold is injected **at most once** per run. If the body cannot be parsed as JSON, injection is silently skipped for that request.

Crossed thresholds are also exposed via `/reflect` in `effective_tokens.thresholds_crossed`.

### Introspection

Query the `/reflect` endpoint on any provider port to see the current budget state:

```bash
curl http://172.30.0.30:10000/reflect
```

The response includes:

```json
{
  "effective_tokens": {
    "enabled": true,
    "max_effective_tokens": 500000,
    "total_effective_tokens": 234567.89,
    "remaining_effective_tokens": 265432.11,
    "percent_used": 46.91,
    "thresholds_crossed": []
  }
}
```

### Detecting budget exhaustion

Agents and orchestrators should detect the `403` response and the `effective_tokens_limit_exceeded` error type. The error body is structured JSON and can be parsed programmatically:

```javascript
if (response.status === 403) {
  const body = await response.json();
  if (body.error?.type === 'effective_tokens_limit_exceeded') {
    // Budget exhausted — stop making API calls
    console.log(`Token budget exceeded: ${body.error.total_effective_tokens} / ${body.error.max_effective_tokens}`);
  }
}
```

## Max-runs limit

The API proxy can enforce an absolute **maximum number of LLM invocations** per run. When enabled, each successful upstream LLM response increments a counter, and further requests are rejected once the limit is reached.

### Configuration

Set in the AWF config file (not available as a CLI flag):

```json
{
  "apiProxy": {
    "maxTurns": 50
  }
}
```

### Enforcement

Before forwarding each request to the upstream provider, the proxy checks the invocation counter:

- **Under limit**: Request is forwarded normally.
- **Limit reached or exceeded**: Request is rejected immediately with:
  - **HTTP `403 Forbidden`**
  - **Error body**:

    ```json
    {
      "error": {
        "type": "max_runs_exceeded",
        "message": "Maximum LLM invocations exceeded (50 / 50).",
        "invocation_count": 50,
        "max_runs": 50
      }
    }
    ```

WebSocket upgrade requests are also rejected with `403` when the limit is reached.

:::caution
Once the limit is reached, **all subsequent requests in the run are rejected**. The counter is not recoverable within a single run.
:::

### Introspection

The `/reflect` endpoint exposes the current max-runs state under the `runs` key:

```json
{
  "runs": {
    "enabled": true,
    "max_runs": 50,
    "invocation_count": 23,
    "remaining_runs": 27
  }
}
```

When `maxTurns` is not configured, `enabled` is `false` and `max_runs`/`remaining_runs` are `null`.

### Detecting the limit

```javascript
if (response.status === 403) {
  const body = await response.json();
  if (body.error?.type === 'max_runs_exceeded') {
    console.log(`Run limit exceeded: ${body.error.invocation_count} / ${body.error.max_runs}`);
  }
}
```

## Max-permission-denied limit

The API proxy can enforce a **maximum number of upstream permission-denied (401/403) responses** per run. When enabled, each upstream 401 or 403 response increments a counter, and all further requests are rejected once the threshold is reached. This stops the run early when API credentials are misconfigured or missing, preventing the agent from burning tokens retrying a broken setup.

### Configuration

Set in the AWF config file (not available as a CLI flag):

```json
{
  "apiProxy": {
    "maxPermissionDenied": 3
  }
}
```

When `maxPermissionDenied` is not set, the guard is disabled and permission errors are not counted.

### Enforcement

Before forwarding each request to the upstream provider, the proxy checks the permission-denied counter:

- **Under limit**: Request is forwarded normally.
- **Limit reached or exceeded**: Request is rejected immediately with:
  - **HTTP `403 Forbidden`**
  - **Error body**:

    ```json
    {
      "error": {
        "type": "permission_denied_limit_exceeded",
        "message": "Permission denied limit exceeded (3 / 3). The run has been stopped due to repeated permission errors — check that all API keys and tokens are correctly configured.",
        "denied_count": 3,
        "max_permission_denied": 3
      }
    }
    ```

WebSocket upgrade requests are also rejected with `403` when the limit is reached.

:::caution
Once the limit is reached, **all subsequent requests in the run are rejected**. Check that all provider API keys and tokens are correctly configured before increasing this limit.
:::

### Introspection

The `/reflect` endpoint exposes the current permission-denied guard state under the `permission_denied` key:

```json
{
  "permission_denied": {
    "enabled": true,
    "max_permission_denied": 3,
    "denied_count": 1
  }
}
```

When `maxPermissionDenied` is not configured, `enabled` is `false` and `max_permission_denied` is `null`.

### Detecting the limit

```javascript
if (response.status === 403) {
  const body = await response.json();
  if (body.error?.type === 'permission_denied_limit_exceeded') {
    console.log(`Permission denied limit exceeded: ${body.error.denied_count} / ${body.error.max_permission_denied}`);
  }
}
```

## Model multiplier cap

The api-proxy can hard-cap the model cost multiplier on every request. When a request targets a model whose resolved multiplier exceeds the configured cap, the proxy rejects the request immediately before contacting the upstream provider.

This guards against unexpected pricing spikes caused by model routing changes — for example, an alias or fallback resolving to a much more expensive model than intended.

### Configuration

Set `apiProxy.maxModelMultiplierCap` in the AWF config file, or use the `--max-model-multiplier-cap` CLI flag:

```yaml
apiProxy:
  maxModelMultiplierCap: 5       # reject requests for models with multiplier > 5
  modelMultipliers:
    claude-opus-4.7: 27
    gpt-4o: 2
    gpt-4.1-mini: 0.5
```

Or from the command line:

```bash
awf --max-model-multiplier-cap 5 --max-model-multiplier claude-opus-4.7:27,gpt-4o:2 ...
```

### Enforcement

Before forwarding each POST/PUT/PATCH request, the proxy resolves the model's effective multiplier using the same lookup used by the effective-token guard (exact match → longest-prefix match → default). If the resolved multiplier exceeds the cap:

- **HTTP `400 Bad Request`**
- **Error body**:

  ```json
  {
    "error": {
      "type": "model_multiplier_cap_exceeded",
      "message": "Model multiplier cap exceeded: model \"claude-opus-4.7\" has multiplier 27 which exceeds the configured maximum of 5.",
      "model": "claude-opus-4.7",
      "model_multiplier": 27,
      "max_model_multiplier": 5
    }
  }
  ```

### Detecting the rejection

```javascript
if (response.status === 400) {
  const body = await response.json();
  if (body.error?.type === 'model_multiplier_cap_exceeded') {
    console.log(`Model blocked: ${body.error.model} (multiplier ${body.error.model_multiplier} > cap ${body.error.max_model_multiplier})`);
  }
}
```

## OpenTelemetry distributed tracing

The api-proxy sidecar emits one [OpenTelemetry](https://opentelemetry.io/) CLIENT span per
proxied LLM API request. Spans carry GenAI semantic-convention attributes (token usage, model,
provider) and are automatically attached as children of the parent workflow trace, enabling
end-to-end distributed tracing from the GitHub Actions workflow through the api-proxy to the
LLM provider.

### Activation

Network export is **opt-in** and activated by `OTEL_EXPORTER_OTLP_ENDPOINT`.
When the variable is absent, the api-proxy uses a best-effort local NDJSON fallback file
(`/var/log/api-proxy/otel.jsonl`) and emits no OTLP network traffic.

| Mode | When | Behaviour |
|------|------|-----------|
| **OTLP/HTTP export** | `OTEL_EXPORTER_OTLP_ENDPOINT` is set | Spans exported via HTTP POST routed through Squid; trusted sidecar traffic is exempt from domain ACLs. |
| **File fallback** | Endpoint not set | Spans appended as NDJSON to `/var/log/api-proxy/otel.jsonl`. |

### Environment variables

The following variables are automatically forwarded from the host into the api-proxy container
by AWF. You do **not** need to pass them explicitly.

| Variable | Required | Description |
|----------|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP/HTTP collector URL (e.g. `https://otel.example.com:4318`). Activates network export. Must be in the Squid allowlist. |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | Comma-separated `key=value` auth headers (e.g. `Authorization=******`). |
| `OTEL_SERVICE_NAME` | No | Service name tag on spans. Defaults to `awf-api-proxy`. |
| `GITHUB_AW_OTEL_TRACE_ID` | No | W3C trace-id of the parent workflow trace. Spans become children of this trace. |
| `GITHUB_AW_OTEL_PARENT_SPAN_ID` | No | W3C span-id of the parent workflow span. |

### Span design

Each proxied request produces a single span:

| Field | Value |
|-------|-------|
| **Name** | `api_proxy.{provider}.request` |
| **Kind** | `CLIENT` |
| **Parent** | Constructed from `GITHUB_AW_OTEL_TRACE_ID` + `GITHUB_AW_OTEL_PARENT_SPAN_ID` |

#### Span attributes (GenAI semantic conventions)

| Attribute | Source |
|-----------|--------|
| `gen_ai.system` | Provider name (`openai`, `anthropic`, `copilot`, …) |
| `gen_ai.response.model` | Model from response |
| `gen_ai.usage.input_tokens` | From token tracker |
| `gen_ai.usage.output_tokens` | From token tracker |
| `awf.cached_read` | Cache-read tokens (Anthropic prompt cache) |
| `awf.cached_write` | Cache-write tokens (Anthropic prompt cache) |
| `awf.reasoning` | Reasoning/thinking tokens |
| `http.request.method` | `GET` / `POST` |
| `http.response.status_code` | Upstream HTTP status |
| `url.path` | Request path |
| `awf.request_id` | Internal request UUID |
| `awf.streaming` | `true` when response is `text/event-stream` |
| `awf.provider` | Provider name |

#### Span events

| Event | When emitted |
|-------|-------------|
| `gen_ai.usage` | At span end; attributes mirror the token-usage attributes above |
| `exception` | On upstream or proxy errors |

### Proxy routing for OTLP export

OTLP/HTTP exports are routed through the Squid proxy (`HTTPS_PROXY` / `HTTP_PROXY`), but
the trusted sidecar bypasses domain ACLs. You can still list the collector hostname to
document the intended agent network policy:

```yaml
# awf-config.yml
allowDomains:
  - otel.example.com
```

### Integration with gh-aw workflows

If your workflow uses the `observability.otlp` frontmatter block, gh-aw automatically sets
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`,
`GITHUB_AW_OTEL_TRACE_ID`, and `GITHUB_AW_OTEL_PARENT_SPAN_ID`. AWF forwards all of these
into the api-proxy container, so no extra configuration is needed.

## Limitations

- Keys must be set as environment variables (not file-based)
- No request/response logging (by design, for security)
- **AWS Bedrock OIDC signs HTTP requests only**: WebSocket upgrades are rejected, and the signing target is restricted to the exact regional Bedrock Runtime hostname. See [OIDC Authentication > AWS Bedrock](#aws-bedrock).
- **Vertex AI adapter has no OIDC/WIF support**: the native Vertex adapter (port 10004) only accepts a static `GOOGLE_API_KEY`. To use GCP workload identity federation with Vertex-hosted models, point the OpenAI adapter (port 10000) at a Vertex OpenAI-compatible endpoint instead — see [OIDC Authentication > GCP Vertex AI](#gcp-vertex-ai).
- **GitHub Copilot Business tier target is never auto-derived**: set `COPILOT_API_TARGET=api.business.githubcopilot.com` explicitly (or `--copilot-api-target`); it is not inferred from `GITHUB_SERVER_URL`.

## Related documentation

- [Authentication Architecture](./authentication-architecture.md) — detailed credential isolation internals
- [Auth Matrix](./auth-matrix.md) — per-provider auth combination reference (static keys, OIDC, custom headers)
- [Security](./security.md) — overall security model
- [Environment Variables](./environment.md) — environment variable configuration
- [Troubleshooting](./troubleshooting.md) — common issues and solutions
- [Architecture](./architecture.md) — overall system architecture
