#!/bin/bash
# SECURITY: Docker command interceptor for AWF (Agentic Workflow Firewall)
#
# When DinD is NOT enabled (default): blocks all Docker commands with a helpful error.
# When DinD IS enabled (AWF_DIND_ENABLED=1): intercepts docker run/create to force
# shared network namespace with the agent container, preventing proxy bypass.
#
# This ensures child containers inherit the agent's NAT rules and cannot make
# direct outbound requests that bypass the Squid proxy.

set -euo pipefail

# --- DinD disabled: block all Docker commands ---
if [ "${AWF_DIND_ENABLED:-}" != "1" ]; then
  cat >&2 <<'EOF'
ERROR: Docker-in-Docker support was removed in AWF v0.9.1

Docker commands are no longer available inside the firewall container.

If you need to:
- Use MCP servers: Migrate to stdio-based MCP servers (see docs)
- Run Docker: Execute Docker commands outside AWF wrapper
- Build images: Run Docker build before invoking AWF

See PR #205: https://github.com/github/gh-aw-firewall/pull/205
EOF
  exit 127
fi

# --- DinD enabled: enforce shared network namespace ---

# SECURITY: Read the real Docker path from a private file rather than an environment
# variable. Environment variables are visible to (and modifiable by) user code, which
# could invoke the real Docker binary directly to bypass the wrapper.
AWF_DOCKER_CONFIG="/tmp/awf-lib/.docker-path"
if [ ! -f "$AWF_DOCKER_CONFIG" ]; then
  echo "ERROR: Docker wrapper config not found at $AWF_DOCKER_CONFIG" >&2
  exit 127
fi
REAL_DOCKER=$(cat "$AWF_DOCKER_CONFIG")
if [ -z "$REAL_DOCKER" ] || [ ! -x "$REAL_DOCKER" ]; then
  echo "ERROR: Real Docker binary not found or not executable: '$REAL_DOCKER'" >&2
  exit 127
fi

# SECURITY: Hardcode the agent container name to prevent user code from tampering
# via the AWF_AGENT_CONTAINER environment variable to join arbitrary container namespaces.
AGENT_CONTAINER="awf-agent"

# Known Docker subcommands we intercept or pass through.
# We match against this list rather than assuming the first non-flag token is
# a subcommand, because Docker global options can take values (e.g., --context foo,
# -H unix:///...) which would be misidentified as subcommands.
KNOWN_SUBCOMMANDS="run create exec build buildx pull push network compose images ps logs inspect rm rmi tag stop start restart kill pause unpause wait top stats attach commit cp diff export history import load save port rename update volume system info version events"

get_subcommand() {
  for arg in "$@"; do
    case "$arg" in
      -*) continue ;;
      *)
        # Check if this token is a known Docker subcommand
        for cmd in $KNOWN_SUBCOMMANDS; do
          if [ "$arg" = "$cmd" ]; then
            echo "$arg"
            return
          fi
        done
        # Unknown token — could be a value for a global option (e.g., --context foo),
        # so skip it and keep looking.
        continue
        ;;
    esac
  done
}

SUBCOMMAND=$(get_subcommand "$@")

# Block commands that could attach containers to other networks
case "$SUBCOMMAND" in
  "network")
    # Check for 'docker network connect' which could bypass firewall
    # Allow 'docker network ls', 'docker network inspect', etc.
    shift  # remove 'network'
    NETWORK_SUBCMD=$(get_subcommand "$@")
    if [ "$NETWORK_SUBCMD" = "connect" ]; then
      echo "ERROR: 'docker network connect' is blocked by AWF firewall." >&2
      echo "Child containers must share the agent's network namespace for security." >&2
      exit 1
    fi
    exec "$REAL_DOCKER" network "$@"
    ;;

  "run"|"create")
    # Intercept 'docker run' and 'docker create' to enforce shared network namespace
    # This ensures child containers use the agent's NAT rules (traffic -> Squid proxy)
    CMD="$1"
    shift  # remove 'run' or 'create'

    FILTERED_ARGS=()
    SKIP_NEXT=false

    for arg in "$@"; do
      if [ "$SKIP_NEXT" = true ]; then
        SKIP_NEXT=false
        continue
      fi

      case "$arg" in
        # Strip --network=* and --net=* (combined flag=value form)
        --network=*|--net=*)
          echo "WARNING: AWF stripped '$arg' — child containers must share agent's network namespace" >&2
          continue
          ;;
        # Strip --network and --net (separate flag value form)
        --network|--net)
          echo "WARNING: AWF stripped '$arg' — child containers must share agent's network namespace" >&2
          SKIP_NEXT=true
          continue
          ;;
        *)
          FILTERED_ARGS+=("$arg")
          ;;
      esac
    done

    # Inject --network container:<agent> to share network namespace
    exec "$REAL_DOCKER" "$CMD" --network "container:${AGENT_CONTAINER}" "${FILTERED_ARGS[@]}"
    ;;

  "build")
    # SECURITY: Block 'docker build' because BuildKit intermediate containers get their
    # own network namespace and are not subject to the agent's NAT/iptables rules.
    # This means build steps (e.g., RUN curl) could make unrestricted outbound requests,
    # bypassing the Squid proxy entirely.
    echo "ERROR: 'docker build' is blocked by AWF firewall." >&2
    echo "BuildKit containers bypass NAT rules and could make unrestricted network requests." >&2
    echo "Build images outside the AWF wrapper before invoking awf." >&2
    exit 1
    ;;

  "buildx")
    # SECURITY: Block 'docker buildx' for the same reason as 'docker build' above.
    echo "ERROR: 'docker buildx' is blocked by AWF firewall." >&2
    echo "BuildKit containers bypass NAT rules and could make unrestricted network requests." >&2
    echo "Build images outside the AWF wrapper before invoking awf." >&2
    exit 1
    ;;

  "compose")
    # For docker compose, we cannot easily rewrite compose files.
    # Block it to prevent spawning services on separate networks.
    echo "ERROR: 'docker compose' is blocked by AWF firewall." >&2
    echo "Use 'docker run' instead — AWF will enforce shared network namespace." >&2
    exit 1
    ;;

  *)
    # All other commands (ps, logs, inspect, exec, build, images, etc.) pass through
    exec "$REAL_DOCKER" "$@"
    ;;
esac
