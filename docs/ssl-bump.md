# SSL Bump: HTTPS Content Inspection

> ⚠️ **Power-User Feature**: SSL Bump is an advanced feature that intercepts HTTPS traffic. It requires local Docker image builds and adds performance overhead. Only enable this when you need URL path filtering for HTTPS traffic. For most use cases, domain-based filtering (default mode) is sufficient.

> 🔐 **Security Warning**: SSL Bump fundamentally changes the security model by performing HTTPS interception. **Do not use SSL Bump for:**
> - Multi-tenant environments (other tenants could potentially access the CA key)
> - Untrusted workloads (malicious code with container access could extract the CA key)
> - Multi-user systems where `/tmp` may be readable by other users
>
> See [Security Considerations](#security-considerations) below for details.

SSL Bump enables deep inspection of HTTPS traffic, allowing URL path filtering instead of just domain-based filtering.

## Overview

By default, awf validates both the CONNECT target and the TLS ClientHello SNI
against the domain allowlist. Squid then splices the connection without
decrypting application traffic. This blocks domain-fronting attempts where a
client opens a tunnel to an allowed shared CDN host but requests a different,
non-allowlisted TLS server name.

Default SNI enforcement lets you allow or block `github.com`, but it cannot
restrict access to specific paths like `https://github.com/myorg/*`.

With SSL Bump enabled (`--ssl-bump`), the firewall generates a per-session CA certificate and intercepts HTTPS connections. This allows:

- **URL path filtering**: Restrict access to specific paths, not just domains
- **Full HTTP request inspection**: See complete URLs in logs
- **Wildcard URL patterns**: Use `*` wildcards in `--allow-urls` patterns

## Quick Start

```bash
# Enable SSL Bump for URL path filtering
sudo awf \
  --allow-domains github.com \
  --ssl-bump \
  --allow-urls "https://github.com/myorg/*,https://api.github.com/repos/*" \
  -- curl https://github.com/myorg/some-repo
```

## CLI Flags

### `--ssl-bump`

Enable SSL Bump for HTTPS content inspection.

- **Type**: Flag (boolean)
- **Default**: `false`

When enabled:
1. A per-session CA certificate is generated (valid for 1 day)
2. The CA is injected into the agent container's trust store
3. Squid intercepts HTTPS connections using SSL Bump (peek, stare, bump)
4. URL-based filtering becomes available via `--allow-urls`

### `--allow-urls <urls>`

Comma-separated list of allowed URL patterns for HTTPS traffic. Requires `--ssl-bump`.

- **Type**: String (comma-separated)
- **Requires**: `--ssl-bump` flag

**Wildcard syntax:**
- `*` matches any characters within a path segment
- Patterns must include the full URL scheme (`https://`)

**Examples:**
```bash
# Allow specific repository paths
--allow-urls "https://github.com/myorg/*"

# Allow API endpoints
--allow-urls "https://api.github.com/repos/*,https://api.github.com/users/*"

# Combine with domain allowlist
--allow-domains github.com --ssl-bump --allow-urls "https://github.com/myorg/*"
```

## How It Works

### Without SSL Bump (Default)

```
Agent → CONNECT github.com:443 → Squid checks domain ACL → Pass/Block
                                  (SNI only, no path visibility)
```

Squid sees only the domain from the TLS ClientHello SNI extension. The URL path is encrypted and invisible.

### With SSL Bump

```
Agent → CONNECT github.com:443 → Squid intercepts TLS
      → Squid presents session CA certificate
      → Agent trusts session CA (injected into trust store)
      → Full HTTPS request visible: GET /myorg/repo
      → Squid checks URL pattern ACL → Pass/Block
```

Squid terminates the TLS connection and establishes a new encrypted connection to the destination. This is commonly called a "man-in-the-middle" proxy, but in this case, you control both endpoints.

### Session CA Certificate Lifecycle

1. **Generation**: A unique CA key pair is generated at session start
2. **Validity**: Certificate is valid for 1 day maximum
3. **Injection**: CA certificate is added to the agent container's trust store
4. **Cleanup**: CA private key exists only in the temporary work directory
5. **Isolation**: Each awf execution uses a unique CA certificate

## Example Use Cases

### Restrict GitHub Access to Specific Organizations

```bash
sudo awf \
  --allow-domains github.com \
  --ssl-bump \
  --allow-urls "https://github.com/myorg/*,https://github.com/github/*" \
  -- copilot --prompt "Clone the myorg/copilot-workspace repo"
```

This allows access to repositories under `myorg` and `github` organizations, but blocks access to other GitHub repositories.

### API Endpoint Restrictions

```bash
sudo awf \
  --allow-domains api.github.com \
  --ssl-bump \
  --allow-urls "https://api.github.com/repos/myorg/*,https://api.github.com/users/*" \
  -- curl https://api.github.com/repos/github/gh-aw-firewall
```

Allow only specific API endpoint patterns while blocking others.

### Debugging with Verbose Logging

```bash
sudo awf \
  --allow-domains github.com \
  --ssl-bump \
  --allow-urls "https://github.com/*" \
  --log-level debug \
  -- curl https://github.com/github/gh-aw-firewall

# View full URL paths in Squid logs
sudo cat /tmp/squid-logs-*/access.log
```

With SSL Bump enabled, Squid logs show complete URLs, not just domain:port.

## Security Considerations

### Threat Model Change

**SSL Bump fundamentally changes the security model.** Without SSL Bump, the firewall only sees encrypted traffic and domain names (via SNI). With SSL Bump enabled, the proxy terminates TLS connections and can see all HTTPS traffic in plaintext.

**When SSL Bump is appropriate:**
- Single-user development environments
- Controlled CI/CD pipelines where you trust the workload
- Testing and debugging URL-based access patterns

**When SSL Bump is NOT appropriate:**
- Multi-tenant environments (shared infrastructure)
- Running untrusted code or AI agents
- Multi-user systems with shared `/tmp` directories
- Production security-critical workloads

### CA Private Key Exposure Risk

The CA private key grants the ability to impersonate any HTTPS site for the duration of its validity.

**Key storage:**
- Stored in `/tmp/awf-<timestamp>/ssl/ca-key.pem`
- Protected with file permissions `0600` (owner read/write only)
- Exists only for the session duration

**Risk scenarios:**
1. **Multi-user systems**: Other users may be able to read `/tmp` contents depending on system configuration
2. **Container escape**: If an attacker escapes the container, they can access the key from the host filesystem
3. **Squid compromise**: The Squid proxy process has access to the key; a vulnerability in Squid could expose it
4. **Incomplete cleanup**: If awf is killed with SIGKILL, cleanup may not complete

**Mitigations implemented:**
- Per-session unique CA (not shared across sessions)
- Short validity period (1 day)
- Restrictive file permissions (0600)
- Key is mounted read-only into Squid container
- Container security hardening (dropped capabilities, seccomp)

### Certificate Validity

- Session CA certificates are valid for 1 day maximum
- Short validity limits the window of exposure if a key is compromised
- Each execution generates a new CA, so old certificates become useless
- Future versions may support shorter validity periods (hours)

### Trust Store Modification

- The session CA is injected only into the agent container's trust store
- Host system trust stores are NOT modified
- Spawned containers inherit the modified trust store via volume mounts
- This means spawned containers can also have HTTPS traffic intercepted

### Traffic Visibility

When SSL Bump is enabled:
- Full HTTP request/response headers are visible to the proxy
- Request bodies can be logged (if configured)
- Full URLs appear in Squid access logs
- This is necessary for URL path filtering

**Warning**: SSL Bump means the proxy can see decrypted HTTPS traffic. Only use this feature when you control the environment and understand the implications.

### URL Pattern Validation

To prevent security bypasses, URL patterns (`--allow-urls`) are validated:
- Must start with `https://` (no HTTP or other protocols)
- Must include a path component (e.g., `https://github.com/org/*`)
- Overly broad patterns like `https://*` are rejected
- Domain-only patterns should use `--allow-domains` instead

### Comparison: SNI-Only vs SSL Bump

| Feature | SNI-Only (Default) | SSL Bump |
|---------|-------------------|----------|
| Domain filtering | ✓ | ✓ |
| Path filtering | ✗ | ✓ |
| End-to-end encryption | ✓ | Modified (proxy-terminated) |
| Certificate pinning | Works | Broken |
| Performance | Faster | Slight overhead |
| Log detail | Domain:port only | Full URLs |

## Troubleshooting

### Certificate Errors in Agent

**Problem**: Agent reports certificate validation failures

**Causes**:
1. CA not properly injected into trust store
2. Application uses certificate pinning
3. Custom CA bundle in application ignoring system trust store

**Solutions**:
```bash
# Check if CA was injected
docker exec awf-agent ls -la /usr/local/share/ca-certificates/

# Verify trust store was updated
docker exec awf-agent cat /etc/ssl/certs/ca-certificates.crt | grep -A1 "AWF Session CA"

# For Node.js apps, ensure NODE_EXTRA_CA_CERTS is not overriding
docker exec awf-agent printenv | grep -i cert
```

### URL Patterns Not Matching

**Problem**: Allowed URL patterns are being blocked

**Solutions**:
```bash
# Enable debug logging to see pattern matching
sudo awf --log-level debug --ssl-bump --allow-urls "..." -- your-command

# Check exact URL format in Squid logs
sudo cat /tmp/squid-logs-*/access.log | grep your-domain

# Ensure patterns include scheme (https://)
# ✗ Wrong: github.com/myorg/*
# ✓ Correct: https://github.com/myorg/*
```

### Performance Impact

SSL Bump adds overhead due to TLS termination and re-encryption. For performance-sensitive workloads:

```bash
# Use domain filtering without SSL Bump when path filtering isn't needed
sudo awf --allow-domains github.com -- your-command

# Only enable SSL Bump when you specifically need URL path filtering
sudo awf --allow-domains github.com --ssl-bump --allow-urls "..." -- your-command
```

## Limitations

### Certificate Pinning

Applications that implement certificate pinning will fail to connect when SSL Bump is enabled. The pinned certificate won't match the session CA's generated certificate.

**Affected applications may include**:
- Mobile apps (if running in container)
- Some security-focused CLI tools
- Applications with hardcoded certificate expectations

**Workaround**: Use domain-only filtering (`--allow-domains`) without SSL Bump for these applications.

### HTTP/2 and HTTP/3

SSL Bump works with HTTP/1.1 and HTTP/2 over TLS. HTTP/3 (QUIC) is not currently supported by Squid's SSL Bump implementation.

### WebSocket Connections

WebSocket connections over HTTPS (`wss://`) are intercepted and filtered the same as regular HTTPS traffic. The initial handshake URL is checked against `--allow-urls` patterns.

## Related Documentation

- [Usage Guide](usage.md) - Complete CLI reference
- [Architecture](architecture.md) - How the proxy works
- [Troubleshooting](troubleshooting.md) - Common issues and fixes
- [Logging Quick Reference](logging_quickref.md) - Viewing traffic logs
