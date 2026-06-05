# Chroot Mode

## Overview

AWF always runs in **chroot mode**, providing **transparent host binary execution** within the firewall's network isolation. User commands run inside a `chroot /host` jail, making the host filesystem appear as the root filesystem. This allows commands to use host-installed binaries (Python, Node.js, Go, etc.) with their normal paths, while all network traffic remains controlled by the firewall.

**Key insight**: Chroot changes the filesystem view, not network isolation. The agent sees the host filesystem as `/`, but iptables rules still redirect all HTTP/HTTPS traffic through Squid.

**Primary use case**: Running AI agents on GitHub Actions runners where Python, Node.js, Go, and other tools are pre-installed. Instead of bundling everything in the container, use the host's tooling directly.

## How It Works

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Host (GitHub Actions Runner)                                            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Docker Network Namespace (awf-net: 172.30.0.0/24)                 │ │
│  │                                                                    │ │
│  │   ┌──────────────────────────┐     ┌──────────────────────────┐  │ │
│  │   │ Agent Container          │     │ Squid Container          │  │ │
│  │   │ (172.30.0.20)            │────→│ (172.30.0.10)            │──┼─┼→ Internet
│  │   │                          │     │                          │  │ │
│  │   │ chroot /host             │     │ Domain ACL filtering     │  │ │
│  │   │ └─ command runs here     │     │                          │  │ │
│  │   │    sees host filesystem  │     │                          │  │ │
│  │   │    as /                  │     │                          │  │ │
│  │   └──────────────────────────┘     └──────────────────────────┘  │ │
│  │   ↑ iptables NAT redirects all HTTP/HTTPS to Squid               │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  Host binaries: /usr/bin/python3, /usr/bin/node, /usr/bin/curl, etc.  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Execution Flow

```
Container starts
    ↓
entrypoint.sh runs as root (container context)
    ↓
iptables rules applied (redirect HTTP/HTTPS to Squid)
    ↓
If AWF_CHROOT_ENABLED=true:
    ↓
    1. Verify capsh exists on host
    2. Mount container-scoped procfs at /host/proc (for Java/dotnet)
    3. Copy DNS configuration to /host/etc/resolv.conf
    4. Map host user by UID
    5. Write command to temp script with PATH setup
    6. chroot /host
    7. Drop capabilities (CAP_NET_ADMIN, CAP_SYS_CHROOT, CAP_SYS_ADMIN)
    8. Switch to host user
    9. Execute command
    ↓
All child processes inherit chroot environment
All HTTP/HTTPS traffic → Squid proxy → Domain filtering
```

### What Changes in Chroot Mode

| Aspect | Without Chroot | With Chroot |
|--------|----------------|-------------|
| Filesystem root | Container's / | Host's / (via `chroot /host`) |
| Binary resolution | Container's `/usr/bin/python3` | Host's `/usr/bin/python3` |
| Host filesystem | Accessible at `/host` | Accessible at `/` |
| User context | awfuser (container) | Host user (by UID) |
| PATH | Container PATH | Reconstructed for host binaries |
| Network isolation | iptables → Squid | iptables → Squid (unchanged) |

### Procfs Mounting for Java and .NET

As of v0.13.13, chroot mode mounts a fresh container-scoped procfs at `/host/proc` to support Java and .NET runtimes:

**Why this is needed:**
- Java's JVM requires access to `/proc/cpuinfo` for CPU detection
- .NET's CLR requires `/proc/self/exe` to resolve the runtime binary path
- Static bind mounts of `/proc/self` always resolve to the parent shell, not the current process

**How it works:**
1. Before chroot, the entrypoint mounts a fresh procfs: `mount -t proc -o nosuid,nodev,noexec proc /host/proc`
2. This requires `CAP_SYS_ADMIN` capability, which is granted during container startup
3. The procfs is container-scoped, showing only container processes (not host processes)
4. `CAP_SYS_ADMIN` is dropped via capsh before executing user commands
5. The command script writes the user command directly (not wrapped in an extra `bash -c` layer), ensuring runtimes see their own binary via `/proc/self/exe` instead of `/bin/bash`

**Security implications:**
- The mounted procfs only exposes container processes, not host processes
- Mount operation completes before user code runs (capability dropped)
- procfs is mounted with security restrictions: `nosuid,nodev,noexec`
- User code cannot unmount or remount (no `CAP_SYS_ADMIN`, umount blocked in seccomp)

**Backwards compatibility:**
- Existing code continues to work without changes
- Java and .NET commands now succeed in chroot mode (previously failed with cryptic errors)
- No impact on non-chroot mode

## Usage

### Basic Usage

```bash
# Run a command using host binaries
sudo awf --allow-domains api.github.com \
  -- python3 -c "import requests; print(requests.get('https://api.github.com').status_code)"

# Run with environment variable passthrough
sudo awf --env-all --allow-domains api.github.com \
  -- curl https://api.github.com
```

### Combined with --env-all

The `--env-all` flag passes host environment variables:

```bash
sudo awf --env-all --allow-domains api.github.com \
  -- bash -c 'echo "Home: $HOME, User: $USER"'
```

Environment variables preserved include:
- `GOPATH`, `PYTHONPATH`, `NODE_PATH` (tool configuration)
- `GOROOT` (automatically passed for Go support on GitHub Actions)
- `HOME` (user's real home directory)
- `GITHUB_TOKEN`, `GH_TOKEN` (credentials)
- Custom environment variables

**Note**: System variables like `PATH`, `PWD`, and `SUDO_*` are excluded for security. PATH is reconstructed inside the chroot.

### Go Runtime Support

Go on GitHub Actions uses "trimmed" binaries that require `GOROOT` to be explicitly set. AWF automatically handles this:

1. If `GOROOT` is set in the environment, it's passed to the chroot via `AWF_GOROOT`
2. The entrypoint script exports `GOROOT` in the command script
3. Go commands work transparently in chroot mode

For GitHub Actions workflows, ensure GOROOT is captured after `actions/setup-go`:

```yaml
- name: Setup Go
  uses: actions/setup-go@v5
  with:
    go-version: '1.22'

- name: Capture GOROOT
  run: |
    echo "GOROOT=$(go env GOROOT)" >> $GITHUB_ENV
```

### GitHub Actions Example

```yaml
- name: Run AI agent with host tools
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    sudo -E npx awf \
      --env-all \
      --allow-domains api.github.com,github.com \
      -- copilot -p "Review this PR" --allow-tool github
```

## Volume Mounts

In chroot mode, selective paths are mounted for security instead of the entire filesystem:

### Read-Only Mounts (System Binaries)

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `/usr` | `/host/usr:ro` | System binaries and libraries |
| `/bin` | `/host/bin:ro` | Essential binaries |
| `/sbin` | `/host/sbin:ro` | System binaries |
| `/lib` | `/host/lib:ro` | Shared libraries |
| `/lib64` | `/host/lib64:ro` | 64-bit shared libraries |
| `/opt` | `/host/opt:ro` | Tool cache (Python, Node, Go) |
| `/etc/ssl` | `/host/etc/ssl:ro` | SSL certificates |
| `/etc/ca-certificates` | `/host/etc/ca-certificates:ro` | CA certificates |
| `/etc/passwd` | `/host/etc/passwd:ro` | User lookup |
| `/etc/group` | `/host/etc/group:ro` | Group lookup |

**Note:** As of v0.13.13, `/proc` is no longer bind-mounted. Instead, a fresh container-scoped procfs is mounted at `/host/proc` during entrypoint initialization. This provides dynamic `/proc/self/exe` resolution required by Java and .NET runtimes.

### Read-Write Mounts

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `$HOME` | `$HOME:rw` | User's home directory |
| `/tmp` | `/host/tmp:rw` | Temporary files |

### Hidden Paths (Security)

| Host Path | Mount Target | Purpose |
|-----------|--------------|---------|
| `/var/run/docker.sock` | `/dev/null` | Prevents firewall bypass via `docker run` |
| `/run/docker.sock` | `/dev/null` | Prevents firewall bypass |

## Security Model

### Capability Management

The container starts with capabilities needed for setup, then drops them before executing user commands:

| Capability | During Setup | Before User Command | Purpose |
|------------|--------------|---------------------|---------|
| `CAP_NET_ADMIN` | Granted | **Dropped** | iptables setup, then prevented |
| `CAP_SYS_CHROOT` | Granted | **Dropped** | Entrypoint chroot, then prevented |
| `CAP_SYS_ADMIN` | Granted (chroot mode) | **Dropped** | procfs mount for Java/dotnet, then prevented |
| `CAP_NET_RAW` | Denied | Denied | Prevents raw socket bypass |
| `CAP_SYS_PTRACE` | Denied | Denied | Prevents process debugging |
| `CAP_SYS_MODULE` | Denied | Denied | Prevents kernel module loading |

**Note:** `CAP_SYS_ADMIN` is only granted in chroot mode (v0.13.13+) for mounting procfs. It's dropped immediately after mount completes, before user commands run.

After capability drop, the process has:
```
CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000  # No effective capabilities
CapBnd: 00000000a00005fb  # Cannot regain NET_ADMIN or SYS_CHROOT
```

### Attack Vector Analysis

| Attack Vector | Protection | Mechanism |
|---------------|------------|-----------|
| Bypass firewall via raw sockets | Protected | `CAP_NET_RAW` dropped |
| Modify iptables rules | Protected | `CAP_NET_ADMIN` dropped |
| Nested chroot escape | Protected | `CAP_SYS_CHROOT` dropped |
| Spawn container to bypass | Protected | Docker socket hidden (`/dev/null`) |
| Direct host network access | Protected | Network namespace isolation |
| Kernel exploits | Not protected | Container limitation (shares host kernel) |

### Why Firewall Still Works in Chroot

Linux namespaces operate independently:

| Namespace | Affected by chroot? | Security Implication |
|-----------|---------------------|----------------------|
| **Network namespace** | NO | iptables rules still apply |
| **PID namespace** | NO | Process isolation maintained |
| **Mount namespace** | Partially | Filesystem view changes, isolation preserved |
| **User namespace** | NO | Runs as regular user, not root |

**Critical point**: `chroot` only changes which filesystem tree is visible. It does NOT:
- Escape Docker's network namespace
- Bypass iptables rules
- Give access to host's network stack

## Security Trade-offs

### Documented Risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Host file access | HIGH | `$HOME` is read-write | CI/CD secrets should use env vars, not files |
| DNS override | LOW | Host's `/etc/resolv.conf` temporarily modified | Backup created, restored on exit |
| /dev visibility | LOW | Device nodes visible | Read-only, cannot create new devices |

### Host File Access

With chroot mode, the agent can read/write to the user's home directory:

| Path | Access | Risk |
|------|--------|------|
| `$HOME/.ssh/*` | READ/WRITE | SSH keys accessible |
| `$HOME/.aws/*` | READ/WRITE | AWS credentials accessible |
| `$HOME/.config/*` | READ/WRITE | Various configs |
| `/etc/passwd` | READ | User enumeration |
| `/usr/bin/*` | READ | System binaries |

**Mitigation**: This is a documented trade-off for the egress control use case. For GitHub Actions:
- Use GitHub Secrets (env vars, not files)
- Use short-lived tokens (`GITHUB_TOKEN` expires)
- Consider what files exist on your runners

### DNS Configuration

The container copies its DNS configuration to the host:

```bash
# Host's /etc/resolv.conf is backed up and replaced
/etc/resolv.conf.awf-backup-<pid>  # Backup
/etc/resolv.conf                    # AWF DNS config during execution
```

**Recovery**: If AWF crashes without cleanup:
```bash
sudo mv /etc/resolv.conf.awf-backup-* /etc/resolv.conf
```

## Requirements

### Host System Requirements

| Requirement | Description |
|-------------|-------------|
| glibc-based host userspace | Required for chroot execution chain (`capsh` + `bash`) |
| `capsh` | Must be installed on host (usually in `libcap2-bin` package) |
| `/bin/bash` | Must exist and be executable on host |
| User by UID | Host user should exist in `/etc/passwd` (auto-synthesized in DinD mode if missing) |
| Docker | Standard Docker requirement |
| sudo | Required for iptables manipulation |

**Important:** Alpine/musl daemon hosts are not currently supported in chroot mode. AWF now fails fast with a clear startup error when musl/Alpine is detected under `/host`.

### Installing capsh

```bash
# Debian/Ubuntu
sudo apt-get install libcap2-bin

# RHEL/Fedora
sudo dnf install libcap
```

## Troubleshooting

### Error: capsh not found

```
[entrypoint][ERROR] capsh not found on host system
[entrypoint][ERROR] Install libcap2-bin package: apt-get install libcap2-bin
```

**Fix**: Install the `libcap2-bin` package on the host.

### Error: Alpine/musl host detected

```
[entrypoint][ERROR] AWF chroot mode requires a glibc-based daemon host ...
```

**Cause**: The Docker daemon host filesystem mounted at `/host` is Alpine/musl-based. Chroot mode currently expects glibc-compatible host binaries for `capsh` and `/bin/bash`.

**Fix**: Run AWF on a glibc-based daemon host (for example Ubuntu/Debian/RHEL-family).

### DinD Identity Synthesis

In ARC (Actions Runner Controller) environments using the DinD (Docker-in-Docker) sidecar pattern, the Docker daemon's filesystem is separate from the runner's. This means `/etc/passwd` and `/etc/group` may not exist or may not contain the runner's UID/GID.

AWF handles this automatically at two layers:

1. **Mount staging** (`etc-mounts.ts`): When `--docker-host-path-prefix` uses a `/tmp/...` prefix (the DinD staging path) and `/etc/passwd` or `/etc/group` cannot be staged from the runner, AWF synthesizes minimal identity files containing `root` and a `runner` entry matching the host UID/GID. If staging succeeds but the staged files are missing the runner UID/GID, AWF supplements them before mounting.

2. **Runtime fallback** (`entrypoint.sh`): If `getent passwd $UID` fails inside the chroot (user not found), the entrypoint attempts to synthesize `/etc/passwd` and `/etc/group` entries. If those mounts are read-only, it falls back to running with numeric `UID:GID` directly.

No configuration is required — synthesis is triggered automatically when user lookup fails.

### Chroot Identity Override (ARC/DinD)

On split-filesystem ARC/DinD runners, you can explicitly override chroot identity values via stdin config:

```json
{
  "chroot": {
    "identity": {
      "home": "/tmp/gh-aw/home",
      "user": "runner",
      "uid": 1001,
      "gid": 1001
    }
  }
}
```

AWF forwards these values to the agent entrypoint and applies them **after** `chroot /host`, overriding default `HOME`, `USER`, and `LOGNAME` values for the chrooted command runtime.

### Error: Working directory does not exist

```
[entrypoint][WARN] Working directory /home/user does not exist on host, will use /
```

**Fix**: Ensure the working directory exists on the host, or use `--work-dir` to specify a different directory.

### Binary not found

If a binary isn't found inside the chroot, check:

1. Is the binary installed on the host?
2. Is it in a standard PATH location?
3. For GitHub Actions tool cache, check `/opt/hostedtoolcache/`

### Network requests fail

Chroot doesn't affect network isolation. If requests fail:

1. Check `--allow-domains` includes the target domain
2. Check Squid logs: `sudo cat /tmp/squid-logs-*/access.log`
3. Verify iptables rules are in place

## Comparison with Alternatives

### Option A: Chroot Mode (Current)

```bash
sudo awf --allow-domains api.github.com \
  -- python3 script.py
```

**Pros**: Transparent binary access, minimal container, uses host tools
**Cons**: Host filesystem access, /proc visible

### Option B: Full Container (Default)

```bash
sudo awf --agent-image act --allow-domains api.github.com \
  -- python3 script.py
```

**Pros**: Isolated filesystem, all tools in container
**Cons**: Larger container, may miss host-specific tools

### Option C: Custom Volume Mounts

```bash
sudo awf --mount /opt/tools:/opt/tools:ro --allow-domains api.github.com \
  -- /opt/tools/python3 script.py
```

**Pros**: Selective access, explicit paths
**Cons**: Requires explicit paths, more configuration

## Related Documentation

- [Architecture](./architecture.md) - Overall firewall architecture
- [Security Architecture](../docs-site/src/content/docs/reference/security-architecture.md) - Detailed security model
- [Environment Variables](./environment.md) - Environment configuration with `--env-all`
- [CLI Reference](../docs-site/src/content/docs/reference/cli-reference.md) - Complete CLI options
