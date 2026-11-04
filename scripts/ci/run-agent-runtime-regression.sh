#!/usr/bin/env bash
set -euo pipefail

case "${AGENT:?}" in
  copilot) test -n "${COPILOT_GITHUB_TOKEN:-}" || { echo "::error::Missing Copilot credential"; exit 1; } ;;
  codex) test -n "${OPENAI_API_KEY:-}" || { echo "::error::Missing Codex credential"; exit 1; } ;;
  claude) test -n "${ANTHROPIC_API_KEY:-}" || { echo "::error::Missing Claude credential"; exit 1; } ;;
  *) echo "::error::Unknown agent: $AGENT"; exit 1 ;;
esac

root="${GITHUB_WORKSPACE:?}"
results="$root/.awf-regression/results"
mkdir -p "$results"
marker="AWF-REGRESSION-$AGENT-${RUNTIME:?}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
printf '%s\n' "${SOURCE_SHA:?}" > "$results/source-sha.txt"
args=(
  --image-registry awf-regression --image-tag "$SOURCE_SHA" --skip-pull
  --network-isolation --enable-api-proxy --agent-timeout 10
  --allow-domains 'github.com,githubusercontent.com,githubcopilot.com,api.openai.com,api.anthropic.com'
  --env "PATH=$root/.awf-regression/tools/node_modules/.bin:$PATH"
  --proxy-logs-dir "$results/proxy-logs"
  --audit-dir "$results/audit"
  --log-level info
)
guest_root=/workspace
case "$RUNTIME" in
  docker)
    guest_root="$root"
    ;;
  cloud-hypervisor)
    artifacts="${RUNNER_TEMP:?}/agent-runtime-cloud-hypervisor"
    (cd "$artifacts" && sha256sum --check SHA256SUMS)
    chmod 0755 "$artifacts/cloud-hypervisor" "$artifacts/virtiofsd" "$artifacts/awf-supervisor"
    export AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1
    args+=(
      --container-runtime cloud-hypervisor --cloud-hypervisor-preview
      --cloud-hypervisor-development-allow-unattested-artifacts
      --cloud-hypervisor-mount-policy workspace-and-tool-cache
      --cloud-hypervisor-vcpus 1 --cloud-hypervisor-memory-mib 4096
      --cloud-hypervisor-binary "$artifacts/cloud-hypervisor"
      --cloud-hypervisor-kernel "$artifacts/vmlinux.bin"
      --cloud-hypervisor-rootfs "$artifacts/rootfs.ext4"
      --cloud-hypervisor-supervisor "$artifacts/awf-supervisor"
    )
    for pair in binary:cloud-hypervisor virtiofsd:virtiofsd kernel:vmlinux.bin rootfs:rootfs.ext4 supervisor:awf-supervisor; do
      digest=$(awk -v file="${pair#*:}" '$2 == file { print $1 }' "$artifacts/SHA256SUMS")
      test -n "$digest"
      args+=("--cloud-hypervisor-${pair%%:*}-sha256" "$digest")
    done
    # The workspace is remapped, but Node.js stays at its read-only tool-cache path.
    args+=(--env "PATH=/workspace/.awf-regression/tools/node_modules/.bin:$PATH")
    ;;
  nvx)
    artifacts="${RUNNER_TEMP:?}/agent-runtime-nvx"
    layer="$RUNNER_TEMP/agent-runtime-nvx-layer"
    mkdir -p "$layer"
    sudo tar -xzf "$artifacts/layer.tar.gz" -C "$layer"
    sudo chown root:root "$artifacts"/{openvmm,vmlinux,initramfs.cpio.gz,manifest.json,manifest.sigstore.jsonl}
    sudo chmod 0555 "$artifacts/openvmm"
    sudo chmod 0444 "$artifacts"/{vmlinux,initramfs.cpio.gz,manifest.json,manifest.sigstore.jsonl}
    args+=(
      --container-runtime nvx --nvx-preview --nvx-layer "$layer"
      --nvx-openvmm "$artifacts/openvmm" --nvx-kernel "$artifacts/vmlinux"
      --nvx-initramfs "$artifacts/initramfs.cpio.gz"
      --nvx-artifact-manifest "$artifacts/manifest.json"
      --nvx-artifact-manifest-bundle "$artifacts/manifest.sigstore.jsonl"
      --nvx-signer-workflow github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml
      --nvx-mount-policy workspace-only --nvx-scratch-bytes 1073741824
      --nvx-memory-mib 2048 --nvx-memory-max-bytes 3221225472
      --env PATH=/usr/local/bin:/usr/bin:/bin
    )
    ;;
  *) echo "::error::Unknown runtime: $RUNTIME"; exit 1 ;;
esac
args+=(--container-workdir "$guest_root")

status=0
sudo --preserve-env=COPILOT_GITHUB_TOKEN,OPENAI_API_KEY,ANTHROPIC_API_KEY,AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS,GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS,RUNNER_TOOL_CACHE,AGENT_TOOLSDIRECTORY,RUNNER_TEMP,GITHUB_WORKSPACE \
  "$(command -v node)" "$root/dist/cli.js" "${args[@]}" \
  -- bash "$guest_root/scripts/ci/run-agent-regression-guest.sh" "$AGENT" "$marker" \
  2>&1 | tee "$results/awf.log" || status=$?
sudo chown -R "$(id -u):$(id -g)" "$results"
if [ "$status" -ne 0 ]; then
  echo "::error::$AGENT / $RUNTIME failed with exit code $status; see regression evidence"
  exit "$status"
fi
# Neither a model's claimed PASS nor a noop can satisfy these checks.
if [ ! -f "$results/agent-proof.txt" ] || [ "$(cat "$results/agent-proof.txt")" != "$marker" ]; then
  echo "::error::Missing or incorrect agent-written workspace proof"
  exit 1
fi
if ! grep -Fxq "$marker" "$results/response.txt" ||
   ! grep -Fxq 'AWF-REGRESSION-COMPLETE' "$results/awf.log"; then
  echo "::error::Missing exact inference response or guest completion marker"
  exit 1
fi
printf "### %s / %s: PASS\n\nSource: \`%s\`\n" "$AGENT" "$RUNTIME" "$SOURCE_SHA" >> "$GITHUB_STEP_SUMMARY"
