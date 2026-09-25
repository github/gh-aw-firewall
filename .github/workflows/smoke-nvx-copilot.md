---
description: Smoke test the NVX microVM runtime with a real Copilot agent
on:
  workflow_dispatch:
  label_command:
    name: test-nvx-copilot
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
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
          NVX_RELEASE: v0.1.0-dev.d561c4300ebe
          NVX_ARCHIVE: nvx-0.1.0-linux-kvm.tar.gz
          NVX_ARCHIVE_SHA256: 705c863cf7183e89606542b12961644eefd24fed8b2520156dd5cb63a3982699
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
          release_tag="v$(node -p "require('./package.json').version")"
          jq -n \
            --arg release_tag "$release_tag" \
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
                releaseTag:"v0.1.0-dev.d561c4300ebe",
                nvxCommit:"d561c4300ebe854baba5d154056ead6f9d462047",
                openvmmCommit:"0bc357bbcf3a654b63dfb51f1103c5751bf3d31f"
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
            }' > "$artifact_dir/manifest.json"
      - name: Attest the pinned NVX artifact manifest
        id: attest_nvx_manifest
        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        with:
          subject-path: ${{ runner.temp }}/nvx-attested-artifacts/manifest.json
      - name: Bundle the manifest attestation
        env:
          BUNDLE_PATH: ${{ steps.attest_nvx_manifest.outputs.bundle-path }}
        run: |
          set -euo pipefail
          cp "$BUNDLE_PATH" "$RUNNER_TEMP/nvx-attested-artifacts/manifest.sigstore.jsonl"
      - name: Upload attested NVX artifacts
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: nvx-smoke-attested-artifacts
          path: ${{ runner.temp }}/nvx-attested-artifacts/
          if-no-files-found: error
          retention-days: 1
steps:
  - name: Set up Node.js
    uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
    with:
      node-version: '22'
      cache: npm

  - name: Install host tools and build AWF
    run: |
      set -euo pipefail
      sudo apt-get update
      sudo apt-get install --yes --no-install-recommends \
        acl bubblewrap e2fsprogs erofs-utils jq nftables uidmap
      npm ci
      npm run build

  - name: Download the attested NVX artifacts
    uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
    with:
      name: nvx-smoke-attested-artifacts
      path: ${{ runner.temp }}/nvx-attested-artifacts

  - name: Restore artifact permissions
    run: |
      set -euo pipefail
      artifact_dir="$RUNNER_TEMP/nvx-attested-artifacts"
      # actions/download-artifact restores files owned by the runner user, but
      # NVX's preflight (assertTrustedFile in src/nvx/preflight.ts) requires
      # every trusted artifact to be root-owned, so re-root them here.
      sudo chown root:root "$artifact_dir"/openvmm "$artifact_dir"/vmlinux \
        "$artifact_dir"/initramfs.cpio.gz "$artifact_dir"/manifest.json \
        "$artifact_dir"/manifest.sigstore.jsonl
      chmod 0555 "$artifact_dir/openvmm"
      chmod 0444 "$artifact_dir/vmlinux" "$artifact_dir/initramfs.cpio.gz" \
        "$artifact_dir/manifest.json" "$artifact_dir/manifest.sigstore.jsonl"

  - name: Build the guest distro layer with the pinned Copilot CLI
    env:
      ALPINE_IMAGE: alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f
      COPILOT_PACKAGE: '@github/copilot-linuxmusl-x64'
      COPILOT_VERSION: 1.0.86
      COPILOT_ARCHIVE: github-copilot-linuxmusl-x64-1.0.86.tgz
      COPILOT_ARCHIVE_SHA256: 34cf74e32c5227efd1957ff69f9ad957205968621c1ce4a84384ece6c19a2f6c
    run: |
      set -euo pipefail
      layer_root="$RUNNER_TEMP/nvx-alpine-root"
      package_dir="$RUNNER_TEMP/nvx-copilot-package"
      mkdir -p "$layer_root" "$package_dir"
      sudo docker pull "$ALPINE_IMAGE"
      container=$(sudo docker create "$ALPINE_IMAGE")
      sudo docker export "$container" | tar -xf - -C "$layer_root"
      sudo docker rm "$container"
      mkdir -p "$layer_root/etc" "$layer_root/usr/local/bin"
      printf 'runner:x:%s:%s:runner:/home/awf:/bin/sh\n' "$(id -u)" "$(id -g)" \
        > "$layer_root/etc/passwd"
      printf 'runner:x:%s:\n' "$(id -g)" > "$layer_root/etc/group"
      chmod 1777 "$layer_root/tmp"

      npm pack "${COPILOT_PACKAGE}@${COPILOT_VERSION}" \
        --pack-destination "$RUNNER_TEMP" --silent
      printf '%s  %s\n' "$COPILOT_ARCHIVE_SHA256" "$RUNNER_TEMP/$COPILOT_ARCHIVE" |
        sha256sum --check --status
      tar -xzf "$RUNNER_TEMP/$COPILOT_ARCHIVE" --strip-components=1 -C "$package_dir"
      install -m 0755 "$package_dir/copilot" "$layer_root/usr/local/bin/copilot"

      # The guest command exercises every capability this smoke test is about:
      # the live workspace export, --container-workdir, per-run environment
      # passthrough, and a real coding agent writing a workspace file that must
      # be copied back to the host.
      cat > "$layer_root/usr/local/bin/awf-nvx-smoke" <<'EOF'
      #!/bin/sh
      set -eu
      test "$(pwd)" = /workspace
      test -r /workspace/package.json
      test -n "${AWF_NVX_SMOKE_MARKER:-}"
      test -n "${HTTPS_PROXY:-}"
      if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='; then
        echo "credential variable reached the NVX guest" >&2
        exit 1
      fi
      printf '%s\n' "$AWF_NVX_SMOKE_MARKER" > /workspace/nvx-smoke-workspace-proof.txt
      runtime_home=/tmp/copilot-home
      mkdir -m 0700 "$runtime_home"
      HOME="$runtime_home"; export HOME
      XDG_CACHE_HOME="$runtime_home/.cache"; export XDG_CACHE_HOME
      XDG_CONFIG_HOME="$runtime_home/.config"; export XDG_CONFIG_HOME
      XDG_STATE_HOME="$runtime_home/.local/state"; export XDG_STATE_HOME
      /usr/local/bin/copilot \
        --prompt "Respond with exactly NVX-COPILOT-PROOF and nothing else." \
        --silent --no-color --stream on --allow-all-tools \
        --disable-builtin-mcps --no-custom-instructions --no-auto-update \
        --no-ask-user --model claude-sonnet-5 --max-ai-credits 30 \
        > /workspace/nvx-smoke-copilot-proof.txt
      echo AWF-NVX-SMOKE-COMPLETE
      EOF
      chmod 0755 "$layer_root/usr/local/bin/awf-nvx-smoke"

  - name: Run the Copilot agent inside an NVX microVM
    env:
      COPILOT_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      # Evidence-producing: a failed scenario must be recorded for the agent to
      # analyze rather than aborting the step before the summary is written.
      set +e
      set -u
      data_dir=/tmp/gh-aw/agent/smoke-nvx-copilot
      mkdir -p "$data_dir/logs"
      results="$data_dir/scenarios.jsonl"
      : > "$results"

      record() {
        jq -cn --arg check "$1" --arg status "$2" --arg detail "$3" \
          '{check:$check,status:$status,detail:$detail}' >> "$results"
      }

      artifact_dir="$RUNNER_TEMP/nvx-attested-artifacts"
      layer_root="$RUNNER_TEMP/nvx-alpine-root"
      marker="nvx-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
      proof_file="$GITHUB_WORKSPACE/nvx-smoke-workspace-proof.txt"
      copilot_file="$GITHUB_WORKSPACE/nvx-smoke-copilot-proof.txt"
      rm -f "$proof_file" "$copilot_file"

      sudo --preserve-env=COPILOT_GITHUB_TOKEN \
        node "$GITHUB_WORKSPACE/dist/cli.js" \
        --container-runtime nvx \
        --nvx-preview \
        --nvx-layer "$layer_root" \
        --nvx-openvmm "$artifact_dir/openvmm" \
        --nvx-kernel "$artifact_dir/vmlinux" \
        --nvx-initramfs "$artifact_dir/initramfs.cpio.gz" \
        --nvx-artifact-manifest "$artifact_dir/manifest.json" \
        --nvx-artifact-manifest-bundle "$artifact_dir/manifest.sigstore.jsonl" \
        --nvx-signer-workflow \
        'github/gh-aw-firewall/.github/workflows/smoke-nvx-copilot.lock.yml' \
        --nvx-mount-policy workspace-only \
        --container-workdir /workspace \
        --network-isolation \
        --enable-api-proxy \
        --allow-domains github.com,api.github.com,api.githubcopilot.com \
        --env "AWF_NVX_SMOKE_MARKER=$marker" \
        --log-level info \
        -- /usr/local/bin/awf-nvx-smoke \
        > "$data_dir/logs/awf.log" 2>&1
      awf_status=$?

      if [ "$awf_status" -eq 0 ]; then
        record microvm-run PASS "awf exited 0"
      else
        record microvm-run FAIL "awf exited $awf_status; see logs/awf.log"
      fi

      if grep -q 'AWF-NVX-SMOKE-COMPLETE' "$data_dir/logs/awf.log"; then
        record guest-assertions PASS \
          "guest confirmed /workspace export, --container-workdir, and env passthrough"
      else
        record guest-assertions FAIL \
          "guest did not reach AWF-NVX-SMOKE-COMPLETE"
      fi

      if [ -f "$proof_file" ] && [ "$(cat "$proof_file")" = "$marker" ]; then
        record workspace-copy-back PASS "guest write reached the host workspace"
      else
        record workspace-copy-back FAIL \
          "expected $marker in nvx-smoke-workspace-proof.txt"
      fi

      if grep -q 'NVX-COPILOT-PROOF' "$copilot_file" 2>/dev/null; then
        record copilot-inference PASS "Copilot responded through the API proxy"
      else
        record copilot-inference FAIL \
          "no NVX-COPILOT-PROOF in nvx-smoke-copilot-proof.txt"
      fi

      rm -f "$proof_file" "$copilot_file"
      sudo chown -R "$(id -u):$(id -g)" "$data_dir"
      cat "$results"
      exit 0
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked."
        exit 1
      fi
---

> **[ASSIGNED WORKFLOW TASK]** Execute the authorized smoke test below.

# Smoke Test: NVX microVM + Copilot

A pre-agent step already ran the pinned Copilot CLI as a real coding agent
inside an NVX one-shot microVM, through AWF's `nvx` runtime, and recorded one
JSON object per check.

1. Read `/tmp/gh-aw/agent/smoke-nvx-copilot/scenarios.jsonl`.
2. Report a PASS or FAIL line for each of `microvm-run`, `guest-assertions`,
   `workspace-copy-back`, and `copilot-inference`.
3. If anything failed, read `/tmp/gh-aw/agent/smoke-nvx-copilot/logs/awf.log`
   and add one short line naming the most likely cause.

Do not re-run the microVM yourself; only analyze the recorded evidence.

Keep the summary under 10 lines.

On a pull request trigger, call `add_comment` with `item_number: ${{ github.event.pull_request.number }}`. If all checks pass, call `add_labels` with the same item number and label `smoke-nvx-copilot`.

On `workflow_dispatch`, call `noop` with the concise summary instead.
