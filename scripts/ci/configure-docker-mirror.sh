#!/usr/bin/env bash
set -euo pipefail

# Restart only the ephemeral GitHub-hosted runner daemon, before any workloads.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo "Docker mirror setup requires a GitHub-hosted Linux Actions runner" >&2
  exit 1
fi

mirror=https://mirror.gcr.io
config=$(mktemp)
trap 'rm -f "$config" "$config.updated"' EXIT

if sudo test -f /etc/docker/daemon.json; then
  sudo cat /etc/docker/daemon.json > "$config"
else
  printf '{}\n' > "$config"
fi

# Preserve runner settings and existing mirrors; never relax TLS verification.
jq --exit-status --arg mirror "$mirror" \
  --arg snapshotter "${AWF_DOCKER_CONTAINERD_SNAPSHOTTER:-false}" '
  if type != "object" then error("Docker daemon config must be an object") else . end
  | .["registry-mirrors"] = ([$mirror] + ((.["registry-mirrors"] // []) | map(select(. != $mirror))))
  | if $snapshotter == "true" then .features["containerd-snapshotter"] = true
    elif $snapshotter == "false" then .
    else error("AWF_DOCKER_CONTAINERD_SNAPSHOTTER must be true or false") end
' "$config" > "$config.updated"
mv "$config.updated" "$config"
sudo dockerd --validate --config-file "$config"
sudo install -m 0644 "$config" /etc/docker/daemon.json
sudo systemctl restart docker
docker info --format '{{json .RegistryConfig.Mirrors}}' |
  jq --exit-status --arg mirror "$mirror/" 'index($mirror) != null'
if [[ "${AWF_DOCKER_CONTAINERD_SNAPSHOTTER:-false}" == true ]]; then
  # The Docker Buildx driver needs this store for external cache export while
  # keeping locally loaded images available to dependent FROM instructions.
  docker info --format '{{json .DriverStatus}}' |
    jq --exit-status 'any(.[]; . == ["driver-type", "io.containerd.snapshotter.v1"])'
fi
