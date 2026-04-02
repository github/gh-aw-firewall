---
title: Domain Filtering
description: Control network access with allowlists, blocklists, and wildcard patterns.
---

Control which domains your AI agents can access using allowlists and blocklists. This guide covers all domain filtering options including wildcard patterns and file-based configuration.

## How domain matching works

Domains automatically match all subdomains:

```bash
# Allowing github.com permits:
# ✓ github.com
# ✓ api.github.com  
# ✓ raw.githubusercontent.com
# ✗ example.com (not in allowlist)

sudo awf --allow-domains github.com -- curl https://api.github.com
```

:::tip
You don't need to list every subdomain. Adding the base domain covers all subdomains automatically.
:::

## Allowlist options

### Command-line flag

Use `--allow-domains` with a comma-separated list:

```bash
sudo awf --allow-domains github.com,npmjs.org,googleapis.com -- <command>
```

### File-based allowlist

Use `--allow-domains-file` for managing large domain lists:

```bash
# Create a domains file
cat > allowed-domains.txt << 'EOF'
# GitHub domains
github.com
api.github.com

# NPM registry  
npmjs.org, registry.npmjs.org

# Wildcard patterns
*.googleapis.com
EOF

# Use the file
sudo awf --allow-domains-file allowed-domains.txt -- <command>
```

**File format:**
- One domain per line or comma-separated
- Comments start with `#` (full line or inline)
- Empty lines are ignored
- Whitespace is trimmed

### Combining methods

You can use both flags together - domains are merged:

```bash
sudo awf \
  --allow-domains github.com \
  --allow-domains-file my-domains.txt \
  -- <command>
```

## Wildcard patterns

Use `*` to match multiple domains:

```bash
# Match any subdomain of github.com
--allow-domains '*.github.com'

# Match api-v1.example.com, api-v2.example.com, etc.
--allow-domains 'api-*.example.com'

# Combine plain domains and wildcards
--allow-domains 'github.com,*.googleapis.com,api-*.example.com'
```

:::caution
Use quotes around patterns to prevent shell expansion of `*`.
:::

**Pattern matching rules:**

| Pattern | Matches | Does Not Match |
|---------|---------|----------------|
| `*.github.com` | `api.github.com`, `raw.github.com` | `github.com` |
| `api-*.example.com` | `api-v1.example.com`, `api-test.example.com` | `api.example.com` |
| `github.com` | `github.com`, `api.github.com` | `notgithub.com` |

**Security restrictions:**
- Overly broad patterns like `*`, `*.*`, or `*.*.*` are rejected
- Patterns are case-insensitive (DNS is case-insensitive)

## Blocklist options

Block specific domains while allowing others. **Blocked domains take precedence over allowed domains.**

### Basic blocklist usage

```bash
# Allow example.com but block internal.example.com
sudo awf \
  --allow-domains example.com \
  --block-domains internal.example.com \
  -- curl https://api.example.com  # ✓ allowed

sudo awf \
  --allow-domains example.com \
  --block-domains internal.example.com \
  -- curl https://internal.example.com  # ✗ blocked
```

### Blocklist with wildcards

```bash
# Allow all of example.com except internal-* subdomains
sudo awf \
  --allow-domains example.com \
  --block-domains 'internal-*.example.com' \
  -- curl https://api.example.com  # ✓ allowed

# Allow broad pattern, block sensitive subdomains
sudo awf \
  --allow-domains '*.example.com' \
  --block-domains '*.secret.example.com' \
  -- curl https://api.example.com  # ✓ allowed
```

### File-based blocklist

```bash
# Create a blocklist file
cat > blocked-domains.txt << 'EOF'
# Internal services that should never be accessed
internal.example.com
admin.example.com

# Block all subdomains of sensitive.org
*.sensitive.org
EOF

# Use the blocklist file
sudo awf \
  --allow-domains example.com,sensitive.org \
  --block-domains-file blocked-domains.txt \
  -- <command>
```

### Combining all options

```bash
sudo awf \
  --allow-domains github.com \
  --allow-domains-file allowed.txt \
  --block-domains internal.github.com \
  --block-domains-file blocked.txt \
  -- <command>
```

## Common use cases

### AI agent with API access

Allow an AI agent to access specific APIs while blocking internal services:

```bash
sudo awf \
  --allow-domains 'api.openai.com,*.github.com' \
  --block-domains 'internal.github.com,admin.github.com' \
  -- npx @github/copilot@latest --prompt "Analyze this code"
```

### CI/CD pipeline restrictions

Restrict network access during builds:

```bash
sudo awf \
  --allow-domains npmjs.org,registry.npmjs.org,github.com \
  --block-domains-file ci-blocklist.txt \
  -- npm install && npm test
```

### MCP server isolation

Test MCP servers with controlled network access:

```bash
sudo awf \
  --allow-domains arxiv.org,api.github.com \
  -- npx @github/copilot@latest \
    --mcp-server ./my-mcp-server.js \
    --prompt "Search for papers"
```

## Protocol-specific filtering

Restrict domains to HTTP-only or HTTPS-only traffic by prefixing with the protocol:

```bash
# HTTPS only - blocks HTTP traffic to this domain
sudo awf --allow-domains 'https://secure.example.com' -- curl https://secure.example.com

# HTTP only - blocks HTTPS traffic to this domain
sudo awf --allow-domains 'http://legacy-api.example.com' -- curl http://legacy-api.example.com

# Both protocols (default, no prefix)
sudo awf --allow-domains 'example.com' -- curl https://example.com
```

| Format | HTTP | HTTPS |
|--------|------|-------|
| `domain.com` | ✓ | ✓ |
| `https://domain.com` | ✗ | ✓ |
| `http://domain.com` | ✓ | ✗ |

Protocol prefixes work with wildcard patterns: `https://*.secure.example.com` matches only HTTPS traffic to any subdomain of `secure.example.com`.

## Normalization

Domains are normalized before matching:

- **Case-insensitive**: `GitHub.COM` = `github.com`
- **Whitespace trimmed**: `" github.com "` = `github.com`
- **Trailing dots removed**: `github.com.` = `github.com`

:::note
Protocol prefixes (`http://`, `https://`) are **not** stripped — they enable [protocol-specific filtering](#protocol-specific-filtering). A bare domain (no prefix) allows both HTTP and HTTPS.
:::

## Debugging domain filtering

### Enable debug logging

See which domains are being allowed or blocked:

```bash
sudo awf \
  --allow-domains github.com \
  --block-domains internal.github.com \
  --log-level debug \
  -- <command>
```

### Check Squid logs

View traffic decisions after execution:

```bash
# Find blocked requests
sudo grep "TCP_DENIED" /tmp/squid-logs-*/access.log

# Find allowed requests  
sudo grep "TCP_TUNNEL" /tmp/squid-logs-*/access.log
```

### Use the logs command

```bash
# View recent traffic with formatting
awf logs

# Filter to blocked requests only
awf logs --format json | jq 'select(.isAllowed == false)'
```

## See also

- [CLI Reference](/gh-aw-firewall/reference/cli-reference) - Complete option documentation including implicit behaviors
- [Playwright Testing](/gh-aw-firewall/guides/playwright-testing) - Using the `localhost` keyword for local development
- [Security Architecture](/gh-aw-firewall/reference/security-architecture) - How filtering works
