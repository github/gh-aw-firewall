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

REAL_DOCKER="${AWF_REAL_DOCKER:-}"
if [ -z "$REAL_DOCKER" ] || [ ! -x "$REAL_DOCKER" ]; then
  echo "ERROR: AWF_REAL_DOCKER is not set or not executable: '$REAL_DOCKER'" >&2
  exit 127
fi

AGENT_CONTAINER="${AWF_AGENT_CONTAINER:-awf-agent}"

# Get the subcommand (first non-flag argument)
get_subcommand() {
  for arg in "$@"; do
    case "$arg" in
      -*) continue ;;
      *) echo "$arg"; return ;;
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

    # Build the extra flags to inject
    INJECT_FLAGS=("--network" "container:${AGENT_CONTAINER}")

    # Propagate host.docker.internal DNS to child containers when host access is enabled.
    # The agent container gets this via Docker's extra_hosts in docker-compose.yml,
    # but child containers spawned via 'docker run' don't inherit it automatically.
    if [ "${AWF_ENABLE_HOST_ACCESS:-}" = "1" ]; then
      INJECT_FLAGS+=("--add-host" "host.docker.internal:host-gateway")
    fi

    exec "$REAL_DOCKER" "$CMD" "${INJECT_FLAGS[@]}" "${FILTERED_ARGS[@]}"
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
