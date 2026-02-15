# Quick Start Guide

Get started with the firewall in 5 minutes!

## Prerequisites

- **Docker**: 20.10+ with Docker Compose v2 installed and running
- **Node.js**: 20.12.0+ and npm (for building from source)
- **OS**: Ubuntu 22.04+ or compatible Linux distribution
- **GitHub Copilot CLI**: (optional, if testing with copilot)

See [Compatibility](compatibility.md) for full version details and tested configurations.

## Installation

### Option 1: Install Script (Recommended for Local Use)

```bash
# Install latest version
curl -sSL https://raw.githubusercontent.com/github/gh-aw-firewall/main/install.sh | sudo bash

# Verify installation
sudo awf --version
```

### Option 2: GitHub Action (Recommended for CI/CD)

```yaml
- name: Setup awf
  uses: github/gh-aw-firewall@main
```

See [GitHub Actions Integration](github_actions.md) for more details.

### Option 3: Build from Source

```bash
# Clone the repository
git clone https://github.com/github/gh-aw-firewall.git awf
cd awf

# Install dependencies
npm install

# Build the project
npm run build

# Make it available globally
npm link
```

## Verify Installation

```bash
awf --version
```

You should see the current version number (e.g., `0.18.0`)

## Your First Command

```bash
# Domains match subdomains: github.com allows api.github.com
awf --allow-domains github.com 'curl -f https://api.github.com'
```

Expected output:
- `[INFO] Allowed domains: github.com`
- `[INFO] Starting containers...`
- `[SUCCESS] Containers started successfully`
- GitHub API JSON response
- `[SUCCESS] Command completed with exit code: 0`

## Test Domain Blocking

Verify that non-whitelisted domains are blocked:

```bash
awf \
  --allow-domains github.com \
  'curl -f --max-time 10 https://example.com'
```

This should **fail** with a connection error - that's correct behavior!

## Enable Debug Logging

See what's happening under the hood:

```bash
awf \
  --allow-domains github.com \
  --log-level debug \
  'curl https://api.github.com'
```

You'll see:
- Configuration details
- Squid config generation
- Docker container logs
- iptables rules being applied
- Network diagnostics

## Use with GitHub Copilot CLI

```bash
# Install GitHub Copilot CLI
npm install -g @github/copilot@latest

# Set your token
export GITHUB_TOKEN="your_copilot_token"

# Run copilot through the firewall
awf \
  --allow-domains github.com,api.github.com,githubusercontent.com \
  'copilot --prompt "What is GitHub Actions?"'
```

## Common Workflows

### Test MCP Server Access

```bash
# Allow arxiv domain
awf \
  --allow-domains arxiv.org \
  'curl -f https://arxiv.org'

# This should fail (domain not whitelisted)
awf \
  --allow-domains github.com \
  'curl -f https://arxiv.org'
```

### Debugging Failed Requests

When a command fails, keep containers running to inspect logs:

```bash
awf \
  --allow-domains github.com \
  --keep-containers \
  'your-failing-command'

# Then inspect logs
docker logs awf-squid
docker logs awf-agent

# Clean up manually when done
docker stop awf-squid awf-agent
docker rm awf-squid awf-agent
```

### Multiple Domains

```bash
awf \
  --allow-domains github.com,api.github.com,githubusercontent.com,arxiv.org \
  'bash -c "curl https://api.github.com && curl https://arxiv.org"'
```

### Domain Formatting

```bash
# Case-insensitive, spaces/dots trimmed
awf --allow-domains " GitHub.COM. " 'curl https://api.github.com'
```

## What Gets Blocked

```bash
# ✓ Bypass attempts are blocked
awf --allow-domains github.com \
  "curl -f --connect-to ::github.com: https://example.com"
# Fails with SSL certificate mismatch (as expected)
```

## Limitations

```bash
# ✓ Wildcard syntax is supported
--allow-domains '*.github.com'    # matches any subdomain of github.com
--allow-domains github.com        # also matches subdomains automatically

# ✗ No internationalized domains (use punycode)
--allow-domains bücher.ch
--allow-domains xn--bcher-kva.ch  # ✓ use in URL too: https://xn--bcher-kva.ch

# ✗ HTTP→HTTPS redirects may fail (use HTTPS directly)
awf --allow-domains github.com "curl -fL http://github.com"
awf --allow-domains github.com "curl -fL https://github.com"  # ✓ works

# ✗ HTTP/3 not supported (container's curl limitation)
awf --allow-domains github.com "curl --http3 https://api.github.com"
awf --allow-domains github.com "curl https://api.github.com"  # ✓ works

# ✗ IPv6 not supported (only IPv4 configured)
awf --allow-domains github.com "curl -6 https://api.github.com"
awf --allow-domains github.com "curl https://api.github.com"  # ✓ works (IPv4)

# ✗ Some tools not pre-installed (install first or use curl/nodejs/npm)
awf --allow-domains echo.websocket.events "wscat -c wss://echo.websocket.events"
awf --allow-domains echo.websocket.events "npm install -g wscat && wscat -c wss://..."  # ✓
```

## Understanding the Output

### Normal Run
```
[INFO] Allowed domains: github.com, api.github.com
[INFO] Generating configuration files...
[INFO] Starting containers...
[SUCCESS] Containers started successfully
[INFO] Executing copilot command...
[your command output here]
[SUCCESS] Command completed with exit code: 0
```

### With Debug Logging
```
[DEBUG] Configuration: {...}
[DEBUG] Squid config written to: /tmp/awf-xxx/squid.conf
[DEBUG] Docker Compose config written to: /tmp/awf-xxx/docker-compose.yml
[INFO] Starting containers...
[entrypoint] Setting up iptables rules...
[iptables] Redirect HTTP (port 80) to Squid...
[SUCCESS] Containers started successfully
```

### When Domain is Blocked
```
[ERROR] curl: (28) Connection timed out
[INFO] Stopping containers...
[SUCCESS] Command completed with exit code: 28
```

## Troubleshooting

### "Command not found: awf"

**Solution**: Run `npm link` again or use the full path:
```bash
./dist/cli.js --allow-domains github.com 'curl https://api.github.com'
```

### "Cannot connect to Docker daemon"

**Solution**: Start Docker Desktop or the Docker service:
```bash
# macOS/Windows
# Start Docker Desktop

# Linux
sudo systemctl start docker
```

### "Port 3128 already in use"

**Solution**: Stop any existing Squid proxies or change the port in `src/docker-manager.ts`:
```bash
# Find what's using port 3128
lsof -i :3128

# Or kill existing containers
docker stop $(docker ps -q --filter "expose=3128")
```

### "iptables: Permission denied"

**Solution**: This shouldn't happen as we use `NET_ADMIN` capability. If it does:
```bash
# Verify Docker can use iptables
docker run --rm --cap-add NET_ADMIN ubuntu iptables -L
```

## Next Steps

1. **Read the full documentation**: [README.md](../README.md)
2. **Review the architecture**: [architecture.md](architecture.md)
3. **Run the test suite**: `npm test` (unit tests) or `sudo npm run test:integration` (integration tests)
4. **Check GitHub Actions tests**: `.github/workflows/test-coverage.yml` and smoke test workflows (`.github/workflows/smoke-*.md`)

## Getting Help

- Check [README.md](../README.md) for detailed documentation
- Review [troubleshooting.md](troubleshooting.md) for common issues
- Look at test examples in `.github/workflows/` directory
- Enable `--log-level debug` for detailed diagnostics
- Use `--keep-containers` to inspect container state

## Tips & Tricks

### Shell Alias
Add to your `.bashrc` or `.zshrc`:
```bash
alias fw='awf'
```

Then use:
```bash
fw --allow-domains github.com 'curl https://api.github.com'
```

### Environment Variable for Domains
```bash
export ALLOWED_DOMAINS="github.com,api.github.com,githubusercontent.com"
fw --allow-domains "$ALLOWED_DOMAINS" 'copilot ...'
```

### Quick Domain Testing
```bash
# Function to test if a domain is reachable through the firewall
test-domain() {
  awf --allow-domains "$1" "curl -f -s -o /dev/null https://$1 && echo '✓ $1 reachable' || echo '✗ $1 blocked'"
}

test-domain github.com
test-domain example.com
```

## Success!

You're now ready to use the firewall. Try integrating it into your GitHub Actions workflow or use it locally for testing restricted network environments.

Happy firewalling! 🔥🧱
