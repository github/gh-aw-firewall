---
description: Smoke test the NVX microVM runtime with a real Copilot agent
on:
  workflow_dispatch:
  label_command:
    name: test-nvx-copilot
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
  needs: [build_nvx_artifacts]
concurrency:
  job-discriminator: ${{ github.run_id }}
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke NVX Copilot
engine:
  id: copilot
sandbox:
  agent:
    # Keep this aligned with both AWF_RELEASE_TAG values below when upgrading gh-aw/AWF.
    version: v0.28.54
    runtime: nvx
    nvx:
      preview: true
      network-isolation: true
      api-proxy: true
      mount-policy: workspace-only
      layer-path: ${{ runner.temp }}/nvx-alpine-root
      openvmm-path: ${{ runner.temp }}/nvx-attested-artifacts/openvmm
      kernel-path: ${{ runner.temp }}/nvx-attested-artifacts/vmlinux
      initramfs-path: ${{ runner.temp }}/nvx-attested-artifacts/initramfs.cpio.gz
      artifact-manifest-path: ${{ runner.temp }}/nvx-attested-artifacts/nvx-test-x86_64.manifest.json
      artifact-manifest-bundle-path: ${{ runner.temp }}/nvx-attested-artifacts/nvx-test-x86_64.manifest.sigstore.jsonl
      signer-workflow: github/gh-aw-firewall/.github/workflows/smoke-nvx-copilot.lock.yml
      scratch-bytes: 536870912
      container-workdir: /workspace
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-nvx-copilot]
  noop:
  messages:
    footer: "> NVX + Copilot smoke test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing the NVX microVM runtime with Copilot..."
    run-success: "[{workflow_name}]({run_url}) completed. NVX + Copilot passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. NVX + Copilot failed."
timeout-minutes: 45
strict: false
jobs:
  build_nvx_artifacts:
    name: Build workflow-attested NVX artifacts
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    env:
      AWF_RELEASE_TAG: v0.28.54
    permissions:
      contents: read
      id-token: write
      attestations: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Fetch and verify pinned NVX release artifacts
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NVX_RELEASE: v0.1.0-dev.be859aa77ffa
          NVX_ARCHIVE: nvx-0.1.0-linux-kvm.tar.gz
          NVX_ARCHIVE_SHA256: ad6bf948d84d60d92f35103b52dc3ad33a421e9a4457ce0823d1890a6985a912
          SIGNER_WORKFLOW: github/gh-aw-firewall/.github/workflows/smoke-nvx-copilot.lock.yml
        run: |
          set -euo pipefail
          package_dir="$RUNNER_TEMP/nvx-package"
          artifact_dir="$RUNNER_TEMP/nvx-attested-artifacts"
          mkdir -p "$package_dir" "$artifact_dir"
          gh release download "$NVX_RELEASE" \
            --repo microsoft/nvx \
            --pattern "$NVX_ARCHIVE" \
            --dir "$package_dir"
          printf '%s  %s\n' "$NVX_ARCHIVE_SHA256" "$package_dir/$NVX_ARCHIVE" |
            sha256sum --check --status
          tar -xzf "$package_dir/$NVX_ARCHIVE" -C "$package_dir"
          extracted="$package_dir/nvx-0.1.0-linux-kvm"
          (cd "$extracted" && sha256sum --check SHA256SUMS)
          install -m 0555 "$extracted/bin/openvmm" "$artifact_dir/openvmm"
          install -m 0444 "$extracted/guest/vmlinux" "$artifact_dir/vmlinux"
          install -m 0444 "$extracted/guest/initramfs.cpio.gz" \
            "$artifact_dir/initramfs.cpio.gz"
          jq -n \
            --arg release_tag "$AWF_RELEASE_TAG" \
            --arg source_commit "$GITHUB_SHA" \
            --arg signer_workflow "$SIGNER_WORKFLOW" \
            --arg openvmm_sha "$(sha256sum "$artifact_dir/openvmm" | cut -d' ' -f1)" \
            --arg kernel_sha "$(sha256sum "$artifact_dir/vmlinux" | cut -d' ' -f1)" \
            --arg initramfs_sha "$(sha256sum "$artifact_dir/initramfs.cpio.gz" | cut -d' ' -f1)" \
            --argjson openvmm_size "$(stat -c %s "$artifact_dir/openvmm")" \
            --argjson kernel_size "$(stat -c %s "$artifact_dir/vmlinux")" \
            --argjson initramfs_size "$(stat -c %s "$artifact_dir/initramfs.cpio.gz")" \
            '{
              schemaVersion:2,
              release:{
                repository:"github/gh-aw-firewall",
                workflow:$signer_workflow,
                tag:$release_tag,
                sourceCommit:$source_commit
              },
              upstream:{
                releaseTag:"v0.1.0-dev.be859aa77ffa",
                nvxCommit:"be859aa77ffa7a20f9ef50f68c5386acdfca9955",
                openvmmCommit:"762bc1c7a203b16aee752324d6a4ab0bde1a713a"
              },
              architecture:"x86_64",
              artifacts:{
                openvmm:{file:"openvmm",sizeBytes:$openvmm_size,sha256:$openvmm_sha},
                kernel:{file:"vmlinux",sizeBytes:$kernel_size,sha256:$kernel_sha},
                initramfs:{
                  file:"initramfs.cpio.gz",
                  sizeBytes:$initramfs_size,
                  sha256:$initramfs_sha
                }
              }
            }' > "$artifact_dir/nvx-test-x86_64.manifest.json"
      - name: Attest the pinned NVX artifact manifest
        id: attest_nvx_manifest
        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        with:
          subject-path: ${{ runner.temp }}/nvx-attested-artifacts/nvx-test-x86_64.manifest.json
      - name: Bundle the manifest attestation
        env:
          BUNDLE_PATH: ${{ steps.attest_nvx_manifest.outputs.bundle-path }}
        run: |
          set -euo pipefail
          cp "$BUNDLE_PATH" \
            "$RUNNER_TEMP/nvx-attested-artifacts/nvx-test-x86_64.manifest.sigstore.jsonl"
      - name: Upload attested NVX artifacts
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9  # v7.0.2
        with:
          name: nvx-smoke-attested-artifacts
          path: ${{ runner.temp }}/nvx-attested-artifacts/
          if-no-files-found: error
          retention-days: 1
steps:
  - name: Set up Node.js
    uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1  # v7.1.0
    with:
      node-version: '22'
      cache: npm

  - name: Install host tools and build AWF
    env:
      AWF_RELEASE_TAG: v0.28.54
    run: |
      set -euo pipefail
      sudo apt-get update
      sudo apt-get install --yes --no-install-recommends \
        acl bubblewrap e2fsprogs erofs-utils jq nftables uidmap
      # The local build must identify as the trusted release recorded in the manifest.
      npm version "${AWF_RELEASE_TAG#v}" --no-git-tag-version --allow-same-version
      npm ci
      npm run build

  - name: Download the attested NVX artifacts
    uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
    with:
      name: nvx-smoke-attested-artifacts
      path: ${{ runner.temp }}/nvx-attested-artifacts

  - name: Restore artifact permissions
    run: |
      set -euo pipefail
      artifact_dir="$RUNNER_TEMP/nvx-attested-artifacts"
      # actions/download-artifact restores files owned by the runner user, but
      # NVX's preflight (assertTrustedFile in src/nvx/preflight.ts) requires
      # every trusted artifact to be root-owned, so re-root them here. Once
      # chowned to root, only sudo can chmod them.
      sudo chown root:root "$artifact_dir"/openvmm "$artifact_dir"/vmlinux \
        "$artifact_dir"/initramfs.cpio.gz \
        "$artifact_dir"/nvx-test-x86_64.manifest.json \
        "$artifact_dir"/nvx-test-x86_64.manifest.sigstore.jsonl
      sudo chmod 0555 "$artifact_dir/openvmm"
      sudo chmod 0444 "$artifact_dir/vmlinux" "$artifact_dir/initramfs.cpio.gz" \
        "$artifact_dir/nvx-test-x86_64.manifest.json" \
        "$artifact_dir/nvx-test-x86_64.manifest.sigstore.jsonl"

  - name: Build the guest distro layer for compiler-managed Copilot
    env:
      ALPINE_IMAGE: alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f
    run: |
      set -euo pipefail
      layer_root="$RUNNER_TEMP/nvx-alpine-root"
      mkdir -p "$layer_root"
      sudo docker pull "$ALPINE_IMAGE"
      container=$(sudo docker create "$ALPINE_IMAGE" apk add --no-cache bash)
      sudo docker start --attach "$container"
      sudo docker export "$container" | tar -xf - -C "$layer_root"
      sudo docker rm "$container"
      mkdir -p "$layer_root/etc" "$layer_root/usr/local/bin"
      printf 'runner:x:%s:%s:runner:/home/awf:/bin/sh\n' "$(id -u)" "$(id -g)" \
        > "$layer_root/etc/passwd"
      printf 'runner:x:%s:\n' "$(id -g)" > "$layer_root/etc/group"
      chmod 1777 "$layer_root/tmp"

      # The guest command exercises every capability this smoke test is about:
      # the live workspace export, --container-workdir, per-run environment
      # passthrough, and a real coding agent writing directly through the
      # workspace share.
      cat > "$layer_root/usr/local/bin/awf-nvx-smoke" <<'EOF'
      #!/bin/sh
      set -eu
      test "$(pwd)" = /workspace
      test -r /workspace/package.json
      test -n "${AWF_NVX_SMOKE_MARKER:-}"
      test -n "${HTTPS_PROXY:-}"
      # Reuse the checksum-verified musl CLI staged by the compiler for this run.
      copilot_bin=/workspace/.gh-aw-nvx/gh-aw/bin/copilot
      test -f "$copilot_bin"
      test ! -L "$copilot_bin"
      test -x "$copilot_bin"
      # Inherit the outer agent's offline proxy contract; never fall back to OAuth.
      test "${COPILOT_OFFLINE:-}" = true
      test "${COPILOT_API_URL:-}" = http://172.30.0.30:10002
      test "${COPILOT_PROVIDER_BASE_URL:-}" = "$COPILOT_API_URL"
      test "${COPILOT_TOKEN:-}" = 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      test "${COPILOT_PROVIDER_API_KEY:-}" = 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      test "${COPILOT_API_KEY:-}" = dummy-byok-key-for-offline-mode
      if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='; then
        echo "credential variable reached the NVX guest" >&2
        exit 1
      fi
      # COPILOT_GITHUB_TOKEN is expected to be present here: --enable-api-proxy
      # deliberately replaces the real GitHub token with a fixed, non-secret
      # isolation placeholder before the guest ever sees it (see
      # src/services/credentials/copilot-credential-env.ts and
      # src/constants/placeholders.ts). Assert the value is exactly that
      # placeholder rather than banning the variable name outright, so a real
      # leaked credential still fails this check.
      if [ -n "${COPILOT_GITHUB_TOKEN:-}" ] && \
         [ "$COPILOT_GITHUB_TOKEN" != "ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]; then
        echo "real credential value reached the NVX guest via COPILOT_GITHUB_TOKEN" >&2
        exit 1
      fi
      printf '%s\n' "$AWF_NVX_SMOKE_MARKER" > /workspace/nvx-smoke-workspace-proof.txt
      runtime_home=/tmp/copilot-home
      mkdir -m 0700 "$runtime_home"
      HOME="$runtime_home"; export HOME
      COPILOT_HOME="$runtime_home/.copilot"; export COPILOT_HOME
      XDG_CACHE_HOME="$runtime_home/.cache"; export XDG_CACHE_HOME
      XDG_CONFIG_HOME="$runtime_home/.config"; export XDG_CONFIG_HOME
      XDG_STATE_HOME="$runtime_home/.local/state"; export XDG_STATE_HOME
      "$copilot_bin" \
        --prompt "Respond with exactly NVX-COPILOT-PROOF and nothing else." \
        --silent --no-color --stream on --allow-all-tools \
        --disable-builtin-mcps --no-custom-instructions --no-auto-update \
        --no-ask-user --model claude-sonnet-5 --max-ai-credits 30 \
        > /workspace/nvx-smoke-copilot-proof.txt
      set -- "$COPILOT_HOME"/session-state/*/events.jsonl
      test "$#" -eq 1
      test -f "$1"
      cp "$1" /workspace/nvx-smoke-copilot-events.jsonl
      printf 'complete\n' > /workspace/nvx-smoke-complete.txt
      echo AWF-NVX-SMOKE-COMPLETE
      EOF
      chmod 0755 "$layer_root/usr/local/bin/awf-nvx-smoke"

  - name: Prepare declarative NVX smoke evidence
    run: |
      set -euo pipefail
      data_dir=/tmp/gh-aw/agent/smoke-nvx-copilot
      mkdir -p "$data_dir/logs"
      marker="nvx-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
      echo "AWF_NVX_SMOKE_MARKER=$marker" >> "$GITHUB_ENV"
      rm -f "$GITHUB_WORKSPACE/nvx-smoke-workspace-proof.txt" \
        "$GITHUB_WORKSPACE/nvx-smoke-copilot-proof.txt" \
        "$GITHUB_WORKSPACE/nvx-smoke-copilot-events.jsonl" \
        "$GITHUB_WORKSPACE/nvx-smoke-complete.txt"
post-steps:
  - name: Collect declarative NVX smoke evidence
    if: always()
    env:
      AGENT_OUTCOME: ${{ steps.agentic_execution.outcome }}
    run: |
      set -u
      data_dir=/tmp/gh-aw/agent/smoke-nvx-copilot
      mkdir -p "$data_dir/logs"
      results="$data_dir/scenarios.jsonl"
      : > "$results"

      record() {
        jq -cn --arg check "$1" --arg status "$2" --arg detail "$3" \
          '{check:$check,status:$status,detail:$detail}' >> "$results"
      }

      proof_file="$GITHUB_WORKSPACE/nvx-smoke-workspace-proof.txt"
      copilot_file="$GITHUB_WORKSPACE/nvx-smoke-copilot-proof.txt"
      events_file="$GITHUB_WORKSPACE/nvx-smoke-copilot-events.jsonl"
      complete_file="$GITHUB_WORKSPACE/nvx-smoke-complete.txt"
      if [ -f /tmp/gh-aw/agent-stdio.log ]; then
        cp /tmp/gh-aw/agent-stdio.log "$data_dir/logs/awf.log"
      fi

      if [ "$AGENT_OUTCOME" = "success" ]; then
        record microvm-run PASS "compiler-owned AWF execution exited 0"
      else
        record microvm-run FAIL \
          "agent outcome was ${AGENT_OUTCOME:-missing}; see logs/awf.log"
      fi

      if [ -f "$complete_file" ] && grep -qx 'complete' "$complete_file"; then
        record guest-assertions PASS \
          "guest confirmed /workspace export, --container-workdir, and env passthrough"
      else
        record guest-assertions FAIL \
          "guest did not reach AWF-NVX-SMOKE-COMPLETE"
      fi

      if [ -f "$proof_file" ] && \
         [ "$(cat "$proof_file")" = "$AWF_NVX_SMOKE_MARKER" ]; then
        record workspace-live-share PASS "guest write reached the host workspace immediately"
      else
        record workspace-live-share FAIL \
          "expected $AWF_NVX_SMOKE_MARKER in nvx-smoke-workspace-proof.txt"
      fi

      usage_file="${AWF_TOKEN_USAGE_LOG:-/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl}"
      if grep -q 'NVX-COPILOT-PROOF' "$copilot_file" 2>/dev/null && \
         jq -s -e '
           [.[] | select(.type == "session.shutdown")] | last |
           [.data.modelMetrics[]?.usage] |
           {
             input_tokens: (map(.inputTokens // 0) | add // 0),
             output_tokens: (map(.outputTokens // 0) | add // 0)
           } | select(.input_tokens > 0 and .output_tokens > 0)' \
           "$events_file" > "$data_dir/copilot-token-usage.json" 2>/dev/null && \
         jq -s -e '[.[] | select(.event == "token_usage") |
           ((.input_tokens // 0) + (.output_tokens // 0))] | add > 0' \
           "$usage_file" > /dev/null 2>&1; then
        record copilot-inference PASS \
          "compiler-managed Copilot responded through the API proxy with nonzero nested token usage"
      else
        record copilot-inference FAIL \
          "missing NVX-COPILOT-PROOF, nested token usage, or API proxy token usage"
      fi

      if [ -f "$proof_file" ]; then
        cp "$proof_file" "$data_dir/workspace-proof.txt"
      fi
      if [ -f "$copilot_file" ]; then
        cp "$copilot_file" "$data_dir/copilot-response.txt"
      fi
      rm -f "$proof_file" "$copilot_file" "$events_file" "$complete_file"
      sudo chown -R "$(id -u):$(id -g)" "$data_dir"
      cat "$results"
  - name: Upload NVX smoke evidence
    if: always()
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9  # v7.0.2
    with:
      name: nvx-smoke-evidence
      path: /tmp/gh-aw/agent/smoke-nvx-copilot/
      if-no-files-found: warn
      retention-days: 7
  - name: Validate declarative NVX smoke evidence
    run: |
      results=/tmp/gh-aw/agent/smoke-nvx-copilot/scenarios.jsonl
      if ! jq -s -e 'length == 4 and all(.[]; .status == "PASS")' "$results" > /dev/null; then
        cat "$results"
        exit 1
      fi
  - name: Validate safe outputs were invoked
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked."
        exit 1
      fi
---

> **[ASSIGNED WORKFLOW TASK]** Execute the authorized smoke test below.

# Smoke Test: NVX microVM + Copilot

You are running inside the compiler-owned NVX one-shot microVM.

1. Run `/usr/local/bin/awf-nvx-smoke` exactly once with the bash tool.
2. Verify `/workspace/nvx-smoke-workspace-proof.txt` contains
   `$AWF_NVX_SMOKE_MARKER` and `/workspace/nvx-smoke-copilot-proof.txt`
   contains `NVX-COPILOT-PROOF`.
3. Report a PASS or FAIL line for each of `microvm-run`, `guest-assertions`,
   `workspace-live-share`, and `copilot-inference`.
4. If the guest command fails, add one short line naming the most likely cause.

The host post-step records the final evidence after this agent exits.

Keep the summary under 10 lines.

On a pull request trigger, call `add_comment` with `item_number: ${{ github.event.pull_request.number }}`. If all checks pass, call `add_labels` with the same item number and label `smoke-nvx-copilot`.

On `workflow_dispatch`, call `noop` with the concise summary instead.
