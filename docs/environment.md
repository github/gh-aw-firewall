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

### Self-hosted runner home directory support

AWF derives the effective home directory at runtime from the host environment (`$HOME`, with sudo-aware handling), not from a hardcoded `/home/runner` path.

This means self-hosted Linux runners with non-standard service-account homes are supported, as long as `$HOME` is set correctly before invoking `awf`.

Variables from `--env` flags override everything else.

**Proxy variables set automatically:** `HTTP_PROXY`, `HTTPS_PROXY`, and `https_proxy` are always set to point to the Squid proxy (`http://172.30.0.10:3128`). Note that lowercase `http_proxy` is intentionally **not** set — some curl builds on Ubuntu 22.04 ignore uppercase `HTTP_PROXY` for HTTP URLs (httpoxy mitigation), so HTTP traffic falls through to iptables DNAT interception instead. iptables DNAT serves as a defense-in-depth fallback for both HTTP and HTTPS.

## Security Warning: `--env-all`

Using `--env-all` passes all host environment variables to the container, which creates security risks:

1. **Credential Exposure**: All variables (API keys, tokens, passwords) are written to `/tmp/awf-<timestamp>/docker-compose.yml` in plaintext
2. **Log Leakage**: Sharing logs or debug output exposes sensitive credentials
3. **Unnecessary Access**: Extra variables increase attack surface (violates least privilege)
4. **Accidental Sharing**: Easy to forget what's in your environment when sharing commands

**Excluded variables** (even with `--env-all`): `PATH`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `SUDO_*`

**Proxy variables:** `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY`, and `FTP_PROXY` (all case variants) from the host are **excluded from container passthrough** when using `--env-all`. The firewall sets its own proxy variables pointing to Squid inside the container. However, host proxy variables **are read** for upstream proxy auto-detection — if the host has `https_proxy`/`http_proxy` set, AWF configures Squid to chain outbound traffic through that corporate proxy (see [Upstream Proxy Support](#upstream-corporate-proxy-support)).

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

## Anthropic WIF environment notes

When using Anthropic Workload Identity Federation (OIDC exchange in the API proxy), AWF supports:

- `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID`
- `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID`
- `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID`
- `AWF_AUTH_ANTHROPIC_WORKSPACE_ID` (optional)
- `AWF_AUTH_ANTHROPIC_TOKEN_URL` (optional override; defaults to `https://api.anthropic.com/v1/oauth/token`)

### Credential precedence warning

Anthropic SDK credential precedence favors `ANTHROPIC_API_KEY` ahead of federation configuration.
If both are set in the same runtime, the API key can silently shadow WIF/OIDC auth.

In AWF API-proxy mode this is mitigated by placeholder values (`sk-ant-placeholder`) in the
agent container, but avoid setting a real `ANTHROPIC_API_KEY` alongside WIF variables in the
same process.

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
| `AWF_DIND` | Operator hint that AWF is running in a split runner/daemon (ARC/DinD) filesystem. Set to `1` to trigger the DinD warning when `--docker-host-path-prefix` is missing. See [arc-dind.md](arc-dind.md). | `1` |
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

## OpenTelemetry (OTEL) Environment Variables

AWF automatically forwards all `OTEL_*` environment variables and `COPILOT_OTEL_FILE_EXPORTER_PATH` into the agent container — no `--env-all` or explicit `--env` flags are required. This covers the full set of [OpenTelemetry SDK environment variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/).

### Automatic forwarding

Any variable present in the host environment with the `OTEL_` prefix is passed through:

```bash
export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $MY_OTEL_TOKEN"
sudo -E awf --allow-domains otel.example.com -- agent-command
```

### Security: one-shot token protection for OTEL credentials

The following OTEL variables often carry bearer tokens or other credentials and are included in the one-shot token protection list (`AWF_ONE_SHOT_TOKENS`). They are cached on first access and removed from `/proc/self/environ`, preventing exfiltration by compromised subprocesses:

| Variable | Content |
|----------|---------|
| `OTEL_EXPORTER_OTLP_HEADERS` | Global auth headers (e.g. `Authorization=Bearer <token>`) |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Per-signal auth headers |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Per-signal auth headers |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Per-signal auth headers |

### Network requirements

- **OTLP/HTTP (`http/protobuf`, default):** Traffic goes through the Squid proxy on ports 80/443. Add the OTLP collector domain to `--allow-domains`:

  ```bash
  awf --allow-domains otel.example.com -- agent-command
  ```

- **OTLP/gRPC (port 4317):** gRPC clients typically do not respect `HTTP_PROXY` env vars, and port 4317 is not covered by AWF's iptables DNAT rules (only 80/443). Traffic to port 4317 hits the default DROP rule and is blocked. Use `http/protobuf` protocol instead:

  ```bash
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  ```

- **File-based export (`COPILOT_OTEL_FILE_EXPORTER_PATH`):** Writes spans to a local file — no network access needed. AWF forwards this variable automatically. gh-aw uploads the file as an Actions artifact.

### Key OTEL variables by category

| Category | Variables |
|----------|-----------|
| **Sensitive (one-shot protected)** | `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` |
| **Network-affecting** | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` |
| **Safe / local config** | `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SDK_DISABLED`, `OTEL_LOG_LEVEL`, `OTEL_PROPAGATORS`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_COMPRESSION` |
| **Copilot-specific** | `COPILOT_OTEL_FILE_EXPORTER_PATH` |

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

This overrides the socket used for AWF's own operations. When combined with `--enable-dind`, AWF also mounts that Unix socket into the agent and sets the agent's `DOCKER_HOST` to the same value so in-agent `docker` commands use the matching socket by default.

### ARC / Kubernetes DinD sidecar pattern

On ARC self-hosted runners that expose Docker via a shared Unix socket volume instead of a TCP listener, set `DOCKER_HOST` to that Unix socket and enable DinD passthrough:

```yaml
env:
  DOCKER_HOST: unix:///var/run/docker.sock
steps:
  - name: Run agent with AWF
    run: |
      awf --enable-dind --allow-domains github.com -- docker ps
```

When `DOCKER_HOST` points to a Unix socket, AWF now uses that socket path for DinD exposure instead of assuming `/var/run/docker.sock`. If your runner uses a different socket path, AWF will honor it automatically. If you need an explicit override, `--docker-host unix:///path/to/docker.sock` also becomes the DinD socket exposed to the agent when `--enable-dind` is set, and AWF sets the agent's `DOCKER_HOST` to that same Unix URI.

### Split runner/daemon filesystem (--docker-host-path-prefix)

On ARC runners using the DinD sidecar pattern, the runner pod and the Docker daemon container have **separate filesystems**. The runner sees paths like `/home/runner/work/repo`, but the Docker daemon cannot resolve those paths because they don't exist in its mount namespace.

Use `--docker-host-path-prefix` to tell AWF how the runner's filesystem is visible to the Docker daemon:

```bash
awf --docker-host-path-prefix /host \
    --allow-domains github.com \
    -- agent-command
```

This prefixes all AWF-managed bind-mount source paths so the daemon can resolve them. For example, `/tmp` becomes `/host/tmp`, and `/home/runner/.cache` becomes `/host/home/runner/.cache`.

**Kernel virtual filesystems are excluded from prefixing.** Paths under `/dev`, `/sys`, and `/proc` are provided by the Docker daemon's own kernel and must not be prefixed. AWF handles this automatically.

**Shared `/tmp` staging for ARC + DinD.** When `--docker-host-path-prefix` points at a daemon-visible shared `/tmp` path, AWF automatically stages the invoking CLI binary plus `/etc/passwd`, `/etc/group`, and the generated chroot `/etc/hosts` there. Stale per-run chroot-host staging directories are pruned automatically.

**Config file equivalent:**

```yaml
container:
  dockerHostPathPrefix: /host
```

**When to use this flag:**

| Scenario | Flag needed? |
|----------|-------------|
| Standard GitHub-hosted runner | No |
| Self-hosted runner (single daemon) | No |
| ARC runner with DinD sidecar | Yes — set to the host mount prefix (e.g. `/host`) |
| ARC runner with Docker socket mount | Only if the runner and daemon have different filesystem views |

### Security: procfs and credential isolation

AWF mounts a container-scoped procfs at `/host/proc` with `hidepid=2` to prevent the agent from reading other processes' environment variables. This is critical because:

- PID 1 (the entrypoint) may briefly hold authentication tokens before `unset_sensitive_tokens()` clears them
- Without `hidepid=2`, an agent could race to read `/proc/1/environ` and extract credentials
- The `/dev/fd` → `/proc/self/fd` symlink provides an indirect path to procfs that `hidepid=2` also blocks

### Limitation

The DinD TCP address (e.g., `tcp://localhost:2375`) typically refers to the runner host's localhost interface. From *inside* the agent container, `localhost` resolves to the container's own loopback interface, not the host's. To make docker commands inside the agent reach the DinD daemon you need one of:

- **`--enable-host-access`** — allows the agent to reach `host.docker.internal` and set `DOCKER_HOST=tcp://host.docker.internal:2375` inside the agent.
- **`--enable-dind`** — mounts the local Docker socket (`/var/run/docker.sock`) directly into the agent container (only works when using the local daemon, not a remote DinD TCP socket).

## Upstream (Corporate) Proxy Support

When running on self-hosted runners behind a corporate proxy, AWF can chain Squid
through the upstream proxy using the `cache_peer` directive.

### Auto-detection

If the host has `https_proxy`/`HTTPS_PROXY` or `http_proxy`/`HTTP_PROXY` set, AWF
automatically configures Squid to route outbound traffic through that proxy.
`no_proxy`/`NO_PROXY` domain suffixes are honored as bypass rules (`always_direct`).

```bash
# Auto-detected — no flags needed when host proxy env vars are set
export https_proxy=http://proxy.corp.com:3128
export no_proxy=.internal.corp.com,localhost
awf --allow-domains github.com 'curl https://api.github.com'
```

### Explicit override

Use `--upstream-proxy <url>` to specify the proxy explicitly (overrides auto-detection):

```bash
awf --upstream-proxy http://proxy.corp.com:3128 --allow-domains github.com 'curl https://api.github.com'
```

### Limitations (v1)

- **HTTP proxies only** — Squid `cache_peer` requires an HTTP proxy (HTTPS tunneling uses CONNECT)
- **No proxy credentials** — `user:pass@proxy` URLs are rejected; configure auth on the proxy server
- **No loopback** — `localhost`/`127.0.0.1` proxies are rejected (Squid is in a container)
- **Single proxy** — If `http_proxy` and `https_proxy` differ, use `--upstream-proxy` to disambiguate
- **Domain-only bypass** — `no_proxy` IPs, CIDRs, and wildcards are ignored (only domain suffixes work)

### Proxy environment variable exclusion

Host proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`,
`ALL_PROXY`, `NO_PROXY`, etc.) are **always excluded** from container passthrough, even with
`--env-all`. AWF sets its own proxy variables pointing to Squid (`172.30.0.10:3128`).

## Troubleshooting

**Variable not accessible:** Use `sudo -E` or pass explicitly with `--env VAR="$VAR"`

**Variable empty:** Check if it's in the excluded list or wasn't exported on host (`export VAR=value`)
