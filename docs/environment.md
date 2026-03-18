# Environment Variables

## Usage

```bash
# Pass specific variables
awf -e MY_API_KEY=secret 'command'

# Pass multiple variables
awf -e FOO=1 -e BAR=2 'command'

# Pass all host variables (development only)
awf --env-all 'command'
```

## Default Behavior

When using `sudo -E`, these host variables are automatically passed: `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `USER`, `TERM`, `HOME`, `XDG_CONFIG_HOME`.

The following are always set/overridden: `PATH` (container values).

Variables from `--env` flags override everything else.

**Proxy variables set automatically:** `HTTP_PROXY`, `HTTPS_PROXY`, and `https_proxy` are always set to point to the Squid proxy (`http://172.30.0.10:3128`). Note that lowercase `http_proxy` is intentionally **not** set — some curl builds on Ubuntu 22.04 ignore uppercase `HTTP_PROXY` for HTTP URLs (httpoxy mitigation), so HTTP traffic falls through to iptables DNAT interception instead. iptables DNAT serves as a defense-in-depth fallback for both HTTP and HTTPS.

## Security Warning: `--env-all`

Using `--env-all` passes all host environment variables to the container, which creates security risks:

1. **Credential Exposure**: All variables (API keys, tokens, passwords) are written to `/tmp/awf-<timestamp>/docker-compose.yml` in plaintext
2. **Log Leakage**: Sharing logs or debug output exposes sensitive credentials
3. **Unnecessary Access**: Extra variables increase attack surface (violates least privilege)
4. **Accidental Sharing**: Easy to forget what's in your environment when sharing commands

**Excluded variables** (even with `--env-all`): `PATH`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `SUDO_*`

**Proxy variables:** `HTTP_PROXY`, `HTTPS_PROXY`, `https_proxy` (and their lowercase/uppercase variants) from the host are ignored when using `--env-all` because the firewall always sets these to point to Squid. Host proxy settings cannot be passed through as they would conflict with the firewall's traffic routing.

## Best Practices

✅ **Use `--env` for specific variables:**
```bash
sudo awf --allow-domains github.com -e MY_API_KEY="$MY_API_KEY" 'command'
```

✅ **Use `sudo -E` for auth tokens:**
```bash
sudo -E awf --allow-domains github.com 'copilot --prompt "..."'
```

⚠️ **Use `--env-all` only in trusted local development** (never in production/CI/CD)

❌ **Avoid `--env-all` when:**
- Sharing logs or configs
- Working with untrusted code
- In production/CI environments

## Internal Environment Variables

The following environment variables are set internally by the firewall and used by container scripts:

| Variable | Description | Example |
|----------|-------------|---------|
| `HTTP_PROXY` | Squid forward proxy for HTTP traffic | `http://172.30.0.10:3128` |
| `HTTPS_PROXY` | Squid forward proxy for HTTPS traffic (explicit CONNECT) | `http://172.30.0.10:3128` |
| `https_proxy` | Lowercase alias for tools that only check lowercase (e.g., Yarn 4, undici) | `http://172.30.0.10:3128` |
| `SQUID_PROXY_HOST` | Squid proxy hostname (for tools needing host separately) | `squid-proxy` |
| `SQUID_PROXY_PORT` | Squid proxy port | `3128` |
| `AWF_DNS_SERVERS` | Comma-separated list of trusted DNS servers | `8.8.8.8,8.8.4.4` |
| `AWF_CHROOT_ENABLED` | Whether chroot mode is enabled | `true` |
| `AWF_HOST_PATH` | Host PATH passed to chroot environment | `/usr/local/bin:/usr/bin` |
| `NO_PROXY` | Domains bypassing Squid (host access mode) | `localhost,host.docker.internal` |

**Note:** These are set automatically based on CLI options and should not be overridden manually.

## Debugging Environment Variables

The following environment variables control debugging behavior:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `AWF_ONE_SHOT_TOKEN_DEBUG` | Enable debug logging for one-shot-token library | `off` | `1` or `true` |

### One-Shot Token Debug Logging

The one-shot-token library protects sensitive tokens (GITHUB_TOKEN, OPENAI_API_KEY, etc.) from environment variable inspection. By default, it operates silently. To troubleshoot token caching issues, enable debug logging:

```bash
# Enable debug logging
export AWF_ONE_SHOT_TOKEN_DEBUG=1

# Run AWF with sudo -E to preserve the variable
sudo -E awf --allow-domains github.com 'your-command'
```

When enabled, the library logs:
- Token initialization messages
- Token access and caching events
- Environment cleanup confirmations

**Note:** Debug output goes to stderr and does not interfere with command stdout. See `containers/agent/one-shot-token/README.md` for complete documentation.

## Troubleshooting

**Variable not accessible:** Use `sudo -E` or pass explicitly with `--env VAR="$VAR"`

**Variable empty:** Check if it's in the excluded list or wasn't exported on host (`export VAR=value`)
