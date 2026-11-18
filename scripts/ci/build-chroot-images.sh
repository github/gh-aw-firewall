#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo "Cached chroot image builds require a GitHub-hosted Linux Actions runner" >&2
  exit 1
fi

: "${ACTIONS_RUNTIME_TOKEN:?Buildx cache runtime token is required}"
: "${ACTIONS_RESULTS_URL:?Buildx cache results URL is required}"
: "${CHROOT_CACHE_VARIANT:?Chroot cache variant is required}"
if [[ ! "$CHROOT_CACHE_VARIANT" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Invalid chroot cache variant" >&2
  exit 1
fi
case "${CHROOT_BROWSER:-false}" in
  true) images=(squid agent api-proxy) ;;
  false) images=(squid agent) ;;
  *) echo "CHROOT_BROWSER must be true or false" >&2; exit 1 ;;
esac

# Import only today's package layers; never freeze apt/apk security updates.
cache_day=$(date -u +%F)
log_dir=$(mktemp -d)
trap 'rm -rf "$log_dir"' EXIT
pids=()
for image in "${images[@]}"; do
  (
    started=$SECONDS
    tag="ghcr.io/github/gh-aw-firewall/${image}:latest"
    scope="chroot-v1-${CHROOT_CACHE_VARIANT}-${image}-${cache_day}"
    status=0
    docker buildx build --load --pull --progress=plain \
      --cache-from "type=gha,version=2,scope=${scope}" \
      --cache-to "type=gha,version=2,mode=max,scope=${scope}" \
      --tag "$tag" "containers/${image}/" || status=$?
    if (( status == 0 )); then
      docker image inspect "$tag" >/dev/null || status=$?
    fi
    echo "Chroot image ${image} wall time: $((SECONDS - started)) s (exit ${status})"
    exit "$status"
  ) >"${log_dir}/${image}.log" 2>&1 &
  pids+=("$!")
done

result=0
failed_images=()
for index in "${!images[@]}"; do
  image=${images[$index]}
  tag="ghcr.io/github/gh-aw-firewall/${image}:latest"
  status=0
  wait "${pids[$index]}" || status=$?
  echo "::group::Build chroot image ${image}"
  cat "${log_dir}/${image}.log"
  echo "::endgroup::"
  if (( status != 0 )); then
    echo "::error::Chroot image build/cache export/inspection failed for ${image} (exit ${status})" >&2
    failed_images+=("$tag")
    if (( result == 0 )); then result=$status; fi
  fi
done

if (( result != 0 )); then
  # Wait for all builds before cleanup; export can fail after --load creates a tag.
  for tag in "${failed_images[@]}"; do
    docker image rm --force "$tag" >/dev/null 2>&1 || true
  done
  docker builder prune --all --force || true
  exit "$result"
fi
# Retain exact loaded images for integration tests, not intermediate layers.
docker builder prune --all --force
