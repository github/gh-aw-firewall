# Environment Variables

## Usage

```bash
# Pass specific variables
awf -e MY_API_KEY=secret 'command'

# Pass multiple variables
awf -e FOO=1 -e BAR=2 'command'

# Pass all host variables (development only)
awf --env-all 'command'

# Read variables from a file
awf --env-file /tmp/runtime-paths.env 'command'

# Combine file and explicit overrides (--env takes precedence over --env-file)
awf --env-file /tmp/runtime-paths.env -e MY_VAR=override 'command'
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

## `--env-file` Support

`--env-file <path>` reads environment variables from a file and injects them into the agent container. This is useful when variables are written to a file rather than exported into the current shell (e.g., step outputs from earlier GitHub Actions steps).

**File format:**
- One `KEY=VALUE` pair per line
- Lines starting with `#` are comments and are ignored
- Blank lines are ignored
- Values are taken literally (no quote stripping, no variable expansion)

**Precedence (lowest → highest):**
1. Built-in framework variables (proxy, DNS, etc.)
2. `--env-all` host variables
3. `--env-file` variables
4. `--env` / `-e` explicit variables (highest priority)

**Excluded variables** in `--env-file` (same list as `--env-all`): `PATH`, `PWD`, `HOME`, `SUDO_*`, etc.

**Example use case — Safe Outputs MCP:**
```bash
# Step output written to a file by the compiler
echo "GH_AW_SAFE_OUTPUTS_CONFIG_PATH=/tmp/config.json" >> /tmp/runtime-paths.env

# AWF picks it up via --env-file
awf --env-file /tmp/runtime-paths.env --allow-domains github.com -- agent-command
```

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

## `COPILOT_GITHUB_TOKEN` and Classic PAT Compatibility

When `COPILOT_GITHUB_TOKEN` is set in the host environment, AWF injects it into the agent container so the Copilot CLI can authenticate against the GitHub Copilot API.

### ⚠️ Classic PAT + `COPILOT_MODEL` Incompatibility (Copilot CLI 1.0.21+)

Copilot CLI 1.0.21 introduced a startup model validation step: when `COPILOT_MODEL` is set, the CLI calls `GET /models` before executing any task. **This endpoint does not accept classic PATs** (`ghp_*` tokens), causing the agent to fail at startup with exit code 1 — before any useful work begins.

**Affected combination:**
- `COPILOT_GITHUB_TOKEN` is a classic PAT (prefixed with `ghp_`)
- `COPILOT_MODEL` is set in the agent environment (e.g., via `--env COPILOT_MODEL=...`, `--env-file`, or `--env-all`)

**Unaffected:** Workflows that do not set `COPILOT_MODEL` are not affected — the `/models` validation is only triggered when `COPILOT_MODEL` is set.

**AWF detects this combination at startup** and emits a `[WARN]` message:
```
⚠️  COPILOT_MODEL is set with a classic PAT (ghp_* token)
   Copilot CLI 1.0.21+ validates COPILOT_MODEL via GET /models at startup.
   Classic PATs are rejected by this endpoint — the agent will likely fail with exit code 1.
   Use a fine-grained PAT or OAuth token, or unset COPILOT_MODEL to skip model validation.
```

**Remediation options:**
1. Replace the classic PAT with a **fine-grained PAT** or **OAuth token** (these are accepted by the `/models` endpoint).
2. Remove `COPILOT_MODEL` from the agent environment to skip model validation entirely.

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
| `AWF_SESSION_STATE_DIR` | Directory for Copilot CLI session state output (equivalent to `--session-state-dir`) | *(unset)* |
| `NO_PROXY` | Domains bypassing Squid (host access mode) | `localhost,host.docker.internal` |

**Note:** Most of these are set automatically based on CLI options and should not be overridden manually. `AWF_SESSION_STATE_DIR` is an exception — it is the environment-variable equivalent of `--session-state-dir` and can be set by users to configure a predictable session-state output path.

## GitHub Actions `setup-*` Tool Availability

Tools installed by GitHub Actions `setup-*` actions (e.g., `astral-sh/setup-uv`, `actions/setup-node`, `ruby/setup-ruby`, `actions/setup-python`) are **automatically available inside the AWF chroot**. This works by:

1. `setup-*` actions write their tool bin directories to the `$GITHUB_PATH` file.
2. AWF reads this file at startup and merges its entries (prepended, higher priority) into `AWF_HOST_PATH`.
3. The chroot entrypoint exports `AWF_HOST_PATH` as `PATH` inside the chroot, so tools like `uv`, `node`, `python3`, `ruby`, etc. resolve correctly.

This behavior was introduced in **awf v0.60.0** and is active automatically — no extra flags are required.

**Fallback behavior:** If `GITHUB_PATH` is not set (e.g., outside GitHub Actions or on self-hosted runners that don't set it), AWF uses `process.env.PATH` as the chroot PATH. If `sudo` has reset `PATH` before AWF runs and `GITHUB_PATH` is also absent, the tool's directory may be missing from the chroot PATH. In that case, invoke the tool via its absolute path or ensure `GITHUB_PATH` is set.

**Troubleshooting:** Run AWF with `--log-level debug` to see whether `GITHUB_PATH` is set and how many entries were merged:

```
[DEBUG] Merged 3 path(s) from $GITHUB_PATH into AWF_HOST_PATH
```

If you see instead:

```
[DEBUG] GITHUB_PATH env var is not set; skipping $GITHUB_PATH file merge …
```

the runner did not set `GITHUB_PATH`, and the tool's bin directory must already be in `$PATH` at AWF launch time.

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

## Workflow-Scope Docker-in-Docker (`DOCKER_HOST`)

When a GitHub Actions workflow enables Docker-in-Docker (DinD) at the **workflow scope** — for example by starting a `docker:dind` service container and setting `DOCKER_HOST: tcp://localhost:2375` in the runner's environment — AWF handles the conflict automatically.

### What happens

AWF's container orchestration (Squid proxy, agent, iptables-init) must run on the **local** Docker daemon so that:
- bind mounts from the runner host filesystem work correctly,
- AWF's fixed subnet (`172.30.0.0/24`) and iptables DNAT rules are created in the right network namespace, and
- port binding expectations between containers are satisfied.

When `DOCKER_HOST` is set to a TCP address, AWF:

1. **Emits a warning** (not an error) informing you that the local socket will be used for AWF's own containers.
2. **Clears `DOCKER_HOST`** for all `docker` / `docker compose` calls it makes internally, so they target the local daemon.
3. **Forwards the original `DOCKER_HOST`** into the agent container's environment, so Docker commands run *by the agent* still reach the DinD daemon.

### Example workflow structure

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      dind:
        image: docker:dind
        options: --privileged
        ports:
          - 2375:2375
    env:
      DOCKER_HOST: tcp://localhost:2375
    steps:
      - uses: actions/checkout@v4
      - name: Run agent with AWF
        run: |
          # AWF warns about DOCKER_HOST but proceeds with local socket for its own containers.
          # The agent can run `docker build` / `docker run` and they will reach the DinD daemon
          # via the forwarded DOCKER_HOST inside the container.
          awf --allow-domains registry-1.docker.io,ghcr.io -- docker build -t myapp .
```

### Explicit socket override

If your local Docker daemon is at a non-standard Unix socket path, use `--docker-host`:

```bash
awf --docker-host unix:///run/user/1000/docker.sock \
    --allow-domains github.com \
    -- agent-command
```

This overrides the socket used for AWF's own operations without affecting the agent's `DOCKER_HOST`.

### Limitation

The DinD TCP address (e.g., `tcp://localhost:2375`) typically refers to the runner's localhost from outside the container. From *inside* the agent container, `localhost` resolves to the container's own loopback interface, not the host's. To make docker commands inside the agent reach the DinD daemon you need one of:

- **`--enable-host-access`** — allows the agent to reach `host.docker.internal` and set `DOCKER_HOST=tcp://host.docker.internal:2375` inside the agent.
- **`--enable-dind`** — mounts the local Docker socket (`/var/run/docker.sock`) directly into the agent container (only works when using the local daemon, not a remote DinD TCP socket).



## Troubleshooting

**Variable not accessible:** Use `sudo -E` or pass explicitly with `--env VAR="$VAR"`

**Variable empty:** Check if it's in the excluded list or wasn't exported on host (`export VAR=value`)
