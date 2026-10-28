#!/bin/bash
set -euo pipefail

AWF_SMOKE_IMAGE_TAG="run-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
HOST_UID="$(node -p "require('./dist/host-identity').getSafeHostUid()")"
HOST_GID="$(node -p "require('./dist/host-identity').getSafeHostGid()")"
for image in squid agent api-proxy; do
  build_args=()
  if [ "$image" = agent ]; then
    build_args+=(--build-arg "USER_UID=$HOST_UID" --build-arg "USER_GID=$HOST_GID")
  fi
  docker build "${build_args[@]}" --tag "awf-smoke/${image}:${AWF_SMOKE_IMAGE_TAG}" "containers/${image}"
  docker image inspect "awf-smoke/${image}:${AWF_SMOKE_IMAGE_TAG}" > /dev/null
done
printf 'AWF_SMOKE_IMAGE_TAG=%s\n' "$AWF_SMOKE_IMAGE_TAG" >> "$GITHUB_ENV"
