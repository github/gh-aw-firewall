# GitHub Enterprise Configuration

This guide explains how to configure AWF for GitHub Enterprise Cloud (GHEC) and GitHub Enterprise Server (GHES) customers.

## Overview

AWF automatically detects your GitHub environment and configures the appropriate API endpoints. The API proxy sidecar intelligently routes GitHub Copilot API traffic based on your `GITHUB_SERVER_URL` environment variable.

## GitHub Enterprise Cloud (*.ghe.com)

GitHub Enterprise Cloud customers use domains like `https://mycompany.ghe.com`. AWF automatically detects GHEC domains and routes traffic to the tenant-specific API endpoint.

### Automatic Configuration

When `GITHUB_SERVER_URL` is set to a `*.ghe.com` domain, AWF automatically derives the correct Copilot API endpoint:

```bash
# Example: GITHUB_SERVER_URL=https://acme.ghe.com
# AWF automatically uses: api.acme.ghe.com
```

**How it works:**
1. AWF reads `GITHUB_SERVER_URL` from your environment
2. Detects that the hostname ends with `.ghe.com`
3. Extracts the subdomain (e.g., `acme` from `acme.ghe.com`)
4. Routes Copilot API traffic to `api.<subdomain>.ghe.com`

### Required Domains for GHEC

For GHEC environments, you need to whitelist your tenant-specific domains:

```bash
export GITHUB_SERVER_URL="https://acme.ghe.com"
export GITHUB_TOKEN="<your-copilot-cli-token>"

sudo -E awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com,raw.githubusercontent.com \
  --enable-api-proxy \
  -- npx @github/copilot@latest --prompt "your prompt here"
```

**Domain breakdown:**
- `acme.ghe.com` - Your GHEC tenant domain (git operations, web UI)
- `api.acme.ghe.com` - Your tenant-specific Copilot API endpoint (automatically routed by AWF)
- `raw.githubusercontent.com` - Raw content access (if using GitHub MCP server)

### GitHub Actions (GHEC)

In GitHub Actions workflows running on GHEC, the `GITHUB_SERVER_URL` environment variable is automatically set by GitHub Actions. No additional configuration is needed:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Setup awf
        uses: github/gh-aw-firewall@main

      - name: Run Copilot with GHEC
        env:
          GITHUB_TOKEN: ${{ secrets.COPILOT_CLI_TOKEN }}
          # GITHUB_SERVER_URL is automatically set by GitHub Actions
        run: |
          sudo -E awf \
            --allow-domains ${{ github.server_url_hostname }},api.${{ github.server_url_hostname }},raw.githubusercontent.com \
            --enable-api-proxy \
            -- npx @github/copilot@latest --prompt "generate tests"
```

**Note:** Use `${{ github.server_url_hostname }}` to dynamically get your GHEC hostname (e.g., `acme.ghe.com`).

### MCP Server Configuration (GHEC)

When using GitHub MCP server with GHEC, ensure your MCP configuration uses the correct endpoint:

```json
{
  "mcpServers": {
    "github": {
      "type": "local",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_SERVER_URL",
        "ghcr.io/github/github-mcp-server:latest"
      ],
      "tools": ["*"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "GITHUB_SERVER_URL": "${GITHUB_SERVER_URL}"
      }
    }
  }
}
```

Then run with both environment variables:

```bash
export GITHUB_SERVER_URL="https://acme.ghe.com"
export GITHUB_TOKEN="<your-copilot-cli-token>"
export GITHUB_PERSONAL_ACCESS_TOKEN="<your-github-pat>"

sudo -E awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com,raw.githubusercontent.com,registry.npmjs.org \
  --enable-api-proxy \
  "npx @github/copilot@latest \
    --disable-builtin-mcps \
    --allow-tool github \
    --prompt 'create an issue'"
```

## GitHub Enterprise Server (GHES)

GitHub Enterprise Server customers host their own GitHub instance on a custom domain (e.g., `github.company.com`). AWF automatically routes Copilot API traffic to the enterprise endpoint.

### Automatic Configuration

When `GITHUB_SERVER_URL` is set to a non-github.com, non-ghe.com domain, AWF automatically routes to the GHES Copilot endpoint:

```bash
# Example: GITHUB_SERVER_URL=https://github.company.com
# AWF automatically uses: api.enterprise.githubcopilot.com
```

### Required Domains for GHES

```bash
export GITHUB_SERVER_URL="https://github.company.com"
export GITHUB_TOKEN="<your-copilot-cli-token>"

sudo -E awf \
  --allow-domains github.company.com,api.enterprise.githubcopilot.com \
  --enable-api-proxy \
  -- npx @github/copilot@latest --prompt "your prompt here"
```

**Domain breakdown:**
- `github.company.com` - Your GHES instance (git operations, web UI)
- `api.enterprise.githubcopilot.com` - Enterprise Copilot API endpoint (used for all GHES instances)

### GitHub Actions (GHES)

```yaml
jobs:
  test:
    runs-on: self-hosted  # GHES typically uses self-hosted runners
    steps:
      - name: Setup awf
        uses: github/gh-aw-firewall@main

      - name: Run Copilot with GHES
        env:
          GITHUB_TOKEN: ${{ secrets.COPILOT_CLI_TOKEN }}
        run: |
          sudo -E awf \
            --allow-domains ${{ github.server_url_hostname }},api.enterprise.githubcopilot.com \
            --enable-api-proxy \
            -- npx @github/copilot@latest --prompt "generate tests"
```

## Manual Override

If automatic detection doesn't work for your setup, you can manually specify the Copilot API endpoint using the `--copilot-api-target` flag:

```bash
# For GHEC with custom configuration
sudo awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com \
  --copilot-api-target api.acme.ghe.com \
  --enable-api-proxy \
  -- your-command

# For GHES with custom configuration
sudo awf \
  --allow-domains github.company.com,api.enterprise.githubcopilot.com \
  --copilot-api-target api.enterprise.githubcopilot.com \
  --enable-api-proxy \
  -- your-command
```

The `--copilot-api-target` flag takes precedence over automatic detection.

## Priority Order

AWF determines the Copilot API endpoint in this order:

1. **`--copilot-api-target` flag** (highest priority) - Manual override
2. **`GITHUB_SERVER_URL` with `*.ghe.com`** - Automatic GHEC detection → `api.<subdomain>.ghe.com`
3. **`GITHUB_SERVER_URL` non-github.com** - Automatic GHES detection → `api.enterprise.githubcopilot.com`
4. **Default** - Public GitHub → `api.githubcopilot.com`

## Verification

To verify your configuration is working correctly:

### 1. Check Environment Variables

```bash
echo "GITHUB_SERVER_URL: $GITHUB_SERVER_URL"
echo "GITHUB_TOKEN: ${GITHUB_TOKEN:+[set]}"
```

### 2. Run with Debug Logging

Add `--keep-containers` to inspect the configuration:

```bash
sudo -E awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com \
  --enable-api-proxy \
  --keep-containers \
  -- npx @github/copilot@latest --prompt "test"
```

### 3. Check API Proxy Logs

```bash
# View the derived endpoint in startup logs
docker logs awf-api-proxy | grep "Copilot proxy"

# Expected for GHEC:
# Copilot proxy listening on port 10002 (target: api.acme.ghe.com)

# Expected for GHES:
# Copilot proxy listening on port 10002 (target: api.enterprise.githubcopilot.com)
```

### 4. Check Squid Logs

```bash
# View allowed/denied requests
sudo cat /tmp/squid-logs-*/access.log | grep copilot

# Verify traffic is going to the correct endpoint
```

## Troubleshooting

### Wrong API Endpoint

**Problem:** Traffic is going to the wrong Copilot API endpoint

**Solutions:**
1. Check that `GITHUB_SERVER_URL` is set correctly and exported
2. Use `sudo -E` to preserve environment variables when running awf
3. Use `--copilot-api-target` to manually override if needed
4. Verify the domain is in your `--allow-domains` list

### Domain Not Whitelisted

**Problem:** Requests are blocked with "TCP_DENIED"

**Solution:** Add the missing domain to `--allow-domains`:

```bash
# Check Squid logs for blocked domains
sudo cat /tmp/squid-logs-*/access.log | grep TCP_DENIED

# Add the blocked domain to your allowlist
sudo -E awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com,<blocked-domain> \
  --enable-api-proxy \
  -- your-command
```

### MCP Server Not Connecting to GHEC

**Problem:** GitHub MCP server fails to connect to your GHEC instance

**Solutions:**
1. Ensure `GITHUB_SERVER_URL` is in the MCP server environment variables
2. Add your GHEC domain to `--allow-domains`
3. Verify `GITHUB_PERSONAL_ACCESS_TOKEN` has the correct scopes for your GHEC tenant

### Invalid GITHUB_SERVER_URL

**Problem:** AWF falls back to default (public GitHub) even though you set GITHUB_SERVER_URL

**Solutions:**
1. Verify the URL format is correct: `https://hostname` (with protocol)
2. Check that the variable is exported before running awf
3. Use `sudo -E` to preserve environment variables

## Examples

### Complete GHEC Setup

```bash
# 1. Set environment variables
export GITHUB_SERVER_URL="https://acme.ghe.com"
export GITHUB_TOKEN="ghp_..."
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."

# 2. Create MCP config (if using GitHub MCP server)
mkdir -p ~/.copilot
cat > ~/.copilot/mcp-config.json << 'EOF'
{
  "mcpServers": {
    "github": {
      "type": "local",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_SERVER_URL",
        "ghcr.io/github/github-mcp-server:latest"
      ],
      "tools": ["*"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "GITHUB_SERVER_URL": "${GITHUB_SERVER_URL}"
      }
    }
  }
}
EOF

# 3. Pull MCP server image
docker pull ghcr.io/github/github-mcp-server:latest

# 4. Run Copilot with AWF
sudo -E awf \
  --allow-domains acme.ghe.com,api.acme.ghe.com,raw.githubusercontent.com,registry.npmjs.org \
  --enable-api-proxy \
  "npx @github/copilot@latest \
    --disable-builtin-mcps \
    --allow-tool github \
    --prompt 'create an issue in repo/name'"
```

### Complete GHES Setup

```bash
# 1. Set environment variables
export GITHUB_SERVER_URL="https://github.company.com"
export GITHUB_TOKEN="ghp_..."

# 2. Run Copilot with AWF
sudo -E awf \
  --allow-domains github.company.com,api.enterprise.githubcopilot.com \
  --enable-api-proxy \
  -- npx @github/copilot@latest --prompt "your prompt here"
```

## See Also

- [API Proxy Sidecar](api-proxy-sidecar.md) - Secure credential management architecture
- [GitHub Actions Integration](github_actions.md) - CI/CD setup with AWF
- [Environment Variables](environment.md) - Environment variable configuration
- [Usage Guide](usage.md) - General CLI usage and examples
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
