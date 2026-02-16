# Troubleshooting

## Domain Access Issues

### Domain is Blocked

**Problem:** Request to allowed domain is being blocked

**Solution:**
1. Check domain spelling in `--allow-domains`
2. Add subdomains if needed (e.g., `api.github.com` in addition to `github.com`)
3. Enable debug logging to see Squid access logs:
   ```bash
   sudo awf \
     --allow-domains github.com \
     --log-level debug \
     'your-command'
   ```
4. Check Squid logs for blocked requests:
   ```bash
   sudo grep "TCP_DENIED" /tmp/squid-logs-<timestamp>/access.log
   ```

## Container Issues

### Container Won't Start

**Problem:** Docker Compose fails to start containers

**Solution:**
1. Ensure Docker is running:
   ```bash
   docker ps
   ```
2. Check for port conflicts (port 3128 must be available):
   ```bash
   netstat -tulpn | grep 3128
   ```
3. Verify Docker Compose is installed:
   ```bash
   docker compose version
   ```
4. Check for orphaned networks:
   ```bash
   docker network ls | grep awf
   ```
   If found, clean them up:
   ```bash
   docker network rm awf-net
   ```

## Permission Issues

### iptables Permission Denied

**Problem:** `Permission denied: iptables commands require root privileges`

**Solution:**
- **All commands MUST be run with `sudo`** for host-level iptables manipulation
- Run: `sudo awf --allow-domains ... 'your-command'`
- In GitHub Actions, the runner already has root access (no `sudo` needed)

### DOCKER-USER Chain Missing

**Problem:** `DOCKER-USER chain does not exist`

**Solution:**
- Ensure Docker is properly installed and running
- Docker creates the DOCKER-USER chain automatically
- Verify Docker version is recent (tested on 20.10+):
  ```bash
  docker version
  ```

### Environment Variables Not Preserved

**Problem:** `GITHUB_TOKEN` or other environment variables not available in container

**Solution:**
- Use `sudo -E` to preserve environment variables:
  ```bash
  sudo -E awf --allow-domains ... 'your-command'
  ```
- Verify variables are exported before running:
  ```bash
  export GITHUB_TOKEN="your-token"
  echo $GITHUB_TOKEN  # Should print the token
  ```

### Token Caching Issues

**Problem:** Sensitive tokens (GITHUB_TOKEN, OPENAI_API_KEY, etc.) not being properly cached or cleared

**Solution:**
1. Enable debug logging for the one-shot-token library:
   ```bash
   export AWF_ONE_SHOT_TOKEN_DEBUG=1
   sudo -E awf --allow-domains ... 'your-command'
   ```
2. Check the debug output for:
   - `Initialized with N default token(s)` - Library loaded successfully
   - `Token <NAME> accessed and cached` - Token was read and cached
   - `INFO: Token <NAME> cleared from process environment` - Token removed from /proc/environ
   - `WARNING: Token <NAME> still exposed` - Token cleanup failed (security concern)
3. If tokens are still exposed, check:
   - The token name is in the default protected list (see `containers/agent/one-shot-token/README.md`)
   - Or set `AWF_ONE_SHOT_TOKENS` to explicitly protect custom tokens:
     ```bash
     export AWF_ONE_SHOT_TOKENS="MY_CUSTOM_TOKEN,ANOTHER_TOKEN"
     export AWF_ONE_SHOT_TOKEN_DEBUG=1
     sudo -E awf --allow-domains ... 'your-command'
     ```

**Note:** Debug output goes to stderr. Use `2>&1 | tee debug.log` to capture it.

## MCP Server Issues

### MCP Server Can't Connect

**Problem:** MCP server cannot reach external API

**Solution:**
1. Add MCP server's domain to `--allow-domains`
2. Check if MCP server uses subdomain (e.g., `api.example.com`)
3. Verify DNS resolution is working:
   ```bash
   sudo awf --allow-domains example.com \
     'nslookup api.example.com'
   ```
4. Check Squid logs for blocked requests:
   ```bash
   sudo grep "api.example.com" /tmp/squid-logs-<timestamp>/access.log
   ```

### MCP Tools Not Available

**Problem:** MCP tools not showing up in Copilot CLI

**Solution:**
1. Verify MCP config has `"tools": ["*"]` field:
   ```bash
   cat ~/.copilot/mcp-config.json
   ```
2. Ensure `--allow-tool` flag matches MCP server name:
   ```bash
   # MCP config has "github" as server name
   copilot --allow-tool github --prompt "..."
   ```
3. Check if built-in MCP is disabled:
   ```bash
   copilot --disable-builtin-mcps --prompt "..."
   ```
4. Review agent logs for MCP connection errors:
   ```bash
   cat /tmp/awf-agent-logs-<timestamp>/*.log
   ```

## Java / Maven / Gradle Issues

### How AWF Handles Java Proxy

AWF automatically sets `JAVA_TOOL_OPTIONS` with `-Dhttp.proxyHost`, `-Dhttp.proxyPort`, `-Dhttps.proxyHost`, `-Dhttps.proxyPort`, and `-Dhttp.nonProxyHosts` inside the agent container. This works for most Java tools that read standard JVM system properties, including Gradle and SBT.

### Maven Requires Extra Configuration

**Problem:** Maven builds fail with network errors even though the domain is in `--allow-domains`

**Cause:** Maven's HTTP transport (Apache HttpClient / Maven Resolver) ignores Java system properties for proxy configuration. Unlike Gradle and most other Java tools, Maven does **not** read `-DproxyHost`/`-DproxyPort` from `JAVA_TOOL_OPTIONS`.

**Solution:** Create `~/.m2/settings.xml` with proxy configuration before running Maven:

```bash
mkdir -p ~/.m2
cat > ~/.m2/settings.xml << EOF
<settings>
  <proxies>
    <proxy>
      <id>awf-http</id><active>true</active><protocol>http</protocol>
      <host>${SQUID_PROXY_HOST}</host><port>${SQUID_PROXY_PORT}</port>
    </proxy>
    <proxy>
      <id>awf-https</id><active>true</active><protocol>https</protocol>
      <host>${SQUID_PROXY_HOST}</host><port>${SQUID_PROXY_PORT}</port>
    </proxy>
  </proxies>
</settings>
EOF
```

The `SQUID_PROXY_HOST` and `SQUID_PROXY_PORT` environment variables are automatically set by AWF in the agent container.

For agentic workflows, add this as a setup step in the workflow `.md` file so the agent creates the file before running Maven commands.

### Gradle Works Automatically

Gradle reads JVM system properties via `ProxySelector.getDefault()`, so the `JAVA_TOOL_OPTIONS` environment variable set by AWF is sufficient. No extra configuration is needed for Gradle builds.

### Why This Is Needed

AWF uses a forward proxy (Squid) for HTTPS egress control rather than transparent interception. This means tools must be proxy-aware:

- **Most tools**: Use `HTTP_PROXY`/`HTTPS_PROXY` environment variables (set automatically by AWF)
- **Java tools**: Use `JAVA_TOOL_OPTIONS` with JVM system properties (set automatically by AWF)
- **Maven**: Requires `~/.m2/settings.xml` (must be configured manually — see above)

## Log Analysis

### Finding Blocked Domains

```bash
# View all blocked domains
sudo grep "TCP_DENIED" /tmp/squid-logs-<timestamp>/access.log | awk '{print $3}' | sort -u

# Count blocked attempts by domain
sudo grep "TCP_DENIED" /tmp/squid-logs-<timestamp>/access.log | awk '{print $3}' | sort | uniq -c | sort -rn
```

### Checking Container Logs

**While containers are running** (with `--keep-containers`):
```bash
docker logs awf-agent
docker logs awf-squid
```

**After command completes:**
```bash
# Agent logs (includes GitHub Copilot CLI logs)
cat /tmp/awf-agent-logs-<timestamp>/*.log

# Squid logs (requires sudo)
sudo cat /tmp/squid-logs-<timestamp>/access.log
```

### Checking iptables Logs

Blocked UDP and non-standard protocols are logged to kernel logs:

```bash
# From host (requires sudo)
sudo dmesg | grep FW_BLOCKED

# From within container
docker exec awf-agent dmesg | grep FW_BLOCKED
```

## Network Issues

### DNS Resolution Failures

**Problem:** Domains cannot be resolved

**Solution:**
1. Verify DNS is allowed in iptables rules (should be automatic)
2. Test DNS resolution:
   ```bash
   sudo awf --allow-domains example.com \
     'nslookup example.com'
   ```
3. Check if DNS servers are reachable:
   ```bash
   sudo awf --allow-domains example.com \
     'cat /etc/resolv.conf'
   ```

### Connection Timeouts

**Problem:** Requests timeout instead of being blocked

**Solution:**
1. Check if Squid proxy is running:
   ```bash
   docker ps | grep awf-squid
   ```
2. Verify iptables rules are applied:
   ```bash
   docker exec awf-agent iptables -t nat -L -n -v
   ```
3. Increase timeout in your command:
   ```bash
   sudo awf --allow-domains github.com \
     'curl --max-time 30 https://api.github.com'
   ```

### Proxy Connection Refused

**Problem:** `curl: (7) Failed to connect to 172.30.0.10 port 3128`

**Solution:**
1. Ensure Squid container is healthy:
   ```bash
   docker ps --filter name=awf-squid
   # Should show "healthy" status
   ```
2. Check Squid logs for errors:
   ```bash
   sudo cat /tmp/squid-logs-<timestamp>/cache.log
   ```
3. Verify network connectivity:
   ```bash
   docker exec awf-agent ping -c 3 172.30.0.10
   ```

## Cleanup Issues

### Orphaned Containers

**Problem:** Containers remain after command exits

**Solution:**
1. Manually clean up containers:
   ```bash
   docker rm -f awf-agent awf-squid
   ```
2. Clean up networks:
   ```bash
   docker network rm awf-net
   ```
3. Use cleanup script:
   ```bash
   ./scripts/ci/cleanup.sh
   ```

### Disk Space Issues

**Problem:** `/tmp` directory filling up with logs

**Solution:**
1. Manually remove old logs:
   ```bash
   rm -rf /tmp/awf-agent-logs-*
   rm -rf /tmp/squid-logs-*
   rm -rf /tmp/awf-*
   ```
2. Empty log directories are not preserved automatically
3. Use `--keep-containers` only when needed for debugging

## GitHub Actions Specific Issues

### Workflow Timeout

**Problem:** GitHub Actions workflow times out

**Solution:**
1. Increase timeout in workflow:
   ```yaml
   timeout-minutes: 15
   ```
2. Use `timeout` command in script:
   ```bash
   timeout 60s awf --allow-domains ... 'your-command'
   ```

### Cleanup Not Running

**Problem:** Cleanup step not executing in workflow

**Solution:**
1. Ensure cleanup step has `if: always()`:
   ```yaml
   - name: Cleanup
     if: always()
     run: ./scripts/ci/cleanup.sh
   ```
2. Add pre-test cleanup to prevent resource accumulation:
   ```yaml
   - name: Pre-test cleanup
     run: ./scripts/ci/cleanup.sh
   ```

### Network Pool Exhaustion

**Problem:** `Pool overlaps with other one on this address space`

**Solution:**
1. Run cleanup before tests:
   ```bash
   ./scripts/ci/cleanup.sh
   ```
2. Add network pruning:
   ```bash
   docker network prune -f
   ```
3. This is why pre-test cleanup is critical in CI/CD

## SSL Bump Issues

### Certificate Validation Failures

**Problem:** Agent reports SSL/TLS certificate errors when `--ssl-bump` is enabled

**Solution:**
1. Verify the CA was injected into the trust store:
   ```bash
   docker exec awf-agent ls -la /usr/local/share/ca-certificates/
   docker exec awf-agent cat /etc/ssl/certs/ca-certificates.crt | grep -A1 "AWF Session CA"
   ```
2. Check if the application uses certificate pinning (incompatible with SSL Bump)
3. For Node.js applications, verify NODE_EXTRA_CA_CERTS is not overriding:
   ```bash
   docker exec awf-agent printenv | grep -i cert
   ```

### URL Patterns Not Matching

**Problem:** Allowed URL patterns are being blocked with `--ssl-bump`

**Solution:**
1. Enable debug logging to see pattern matching:
   ```bash
   sudo awf --log-level debug --ssl-bump --allow-urls "..." 'your-command'
   ```
2. Check the exact URL format in Squid logs:
   ```bash
   sudo cat /tmp/squid-logs-*/access.log | grep your-domain
   ```
3. Ensure patterns include the scheme:
   ```bash
   # ✗ Wrong: github.com/myorg/*
   # ✓ Correct: https://github.com/myorg/*
   ```

### Application Fails with Certificate Pinning

**Problem:** Application refuses to connect due to certificate pinning

**Solution:**
- Applications with certificate pinning are incompatible with SSL Bump
- Use domain-only filtering without `--ssl-bump` for these applications:
  ```bash
  sudo awf --allow-domains github.com 'your-pinned-app'
  ```

## Getting More Help

If you're still experiencing issues:

1. **Enable debug logging:**
   ```bash
   sudo awf --log-level debug --allow-domains ... 'your-command'
   ```

2. **Keep containers for inspection:**
   ```bash
   sudo awf --keep-containers --allow-domains ... 'your-command'
   ```

3. **Review all logs:**
   - Agent logs: `/tmp/awf-agent-logs-<timestamp>/`
   - Squid logs: `/tmp/squid-logs-<timestamp>/`
   - Container logs: `docker logs awf-agent`

4. **Check documentation:**
   - [Architecture](architecture.md) - Understand how the system works
   - [Usage Guide](usage.md) - Detailed usage examples
   - [SSL Bump](ssl-bump.md) - HTTPS content inspection and URL filtering
   - [Logging Quick Reference](logging_quickref.md) - Log queries and monitoring
