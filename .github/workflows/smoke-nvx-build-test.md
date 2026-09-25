---
description: Smoke test the NVX microVM runtime with multi-ecosystem build and test workloads
on:
  workflow_dispatch:
  label_command:
    name: test-nvx-build
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
name: Smoke NVX Build Test
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
    allowed: [smoke-nvx-build]
  noop:
  messages:
    footer: "> 🧊🏗️ *NVX build test by [{workflow_name}]({run_url})*"
    run-started: "🧊🏗️ [{workflow_name}]({run_url}) is testing the NVX microVM runtime with build workloads..."
    run-success: "🧊🏗️ [{workflow_name}]({run_url}) completed. NVX build test passed. ✅"
    run-failure: "🧊🏗️ [{workflow_name}]({run_url}) reports {status}. NVX compatibility issue detected."
timeout-minutes: 75
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
          SIGNER_WORKFLOW: github/gh-aw-firewall/.github/workflows/smoke-nvx-build-test.lock.yml
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
          name: nvx-build-test-attested-artifacts
          path: ${{ runner.temp }}/nvx-attested-artifacts/
          if-no-files-found: error
          retention-days: 1
  verify_build:
    needs: agent
    if: always() && needs.agent.result != 'skipped' && needs.agent.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
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
      name: nvx-build-test-attested-artifacts
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
        "$artifact_dir"/initramfs.cpio.gz "$artifact_dir"/manifest.json \
        "$artifact_dir"/manifest.sigstore.jsonl
      sudo chmod 0555 "$artifact_dir/openvmm"
      sudo chmod 0444 "$artifact_dir/vmlinux" "$artifact_dir/initramfs.cpio.gz" \
        "$artifact_dir/manifest.json" "$artifact_dir/manifest.sigstore.jsonl"

  - name: Build the guest distro layer with the Node.js and Go toolchains
    env:
      # Alpine 3.22.1 ships Node.js 22 and Go 1.24, satisfying this repo's
      # engines.node (>=20.19.0) and the Go fixture's `go 1.22` directive.
      ALPINE_IMAGE: alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f
    run: |
      set -euo pipefail
      layer_root="$RUNNER_TEMP/nvx-alpine-root"
      mkdir -p "$layer_root"
      sudo docker pull "$ALPINE_IMAGE"
      # Toolchains are installed on the host, before the microVM exists, so the
      # guest never needs package-manager egress.
      container=$(sudo docker create "$ALPINE_IMAGE" \
        apk add --no-cache bash ca-certificates curl git go nodejs npm tar)
      sudo docker start --attach "$container"
      sudo docker export "$container" | tar -xf - -C "$layer_root"
      sudo docker rm "$container"
      mkdir -p "$layer_root/etc" "$layer_root/usr/local/bin"
      printf 'runner:x:%s:%s:runner:/home/awf:/bin/sh\n' "$(id -u)" "$(id -g)" \
        > "$layer_root/etc/passwd"
      printf 'runner:x:%s:\n' "$(id -g)" > "$layer_root/etc/group"
      chmod 1777 "$layer_root/tmp"

      # Mirrors the smoke-cloud-hypervisor-build-test workload. It builds from a
      # scratch copy of the workspace so the host checkout (and its glibc
      # node_modules) is never modified, and only the results directory is
      # copied back through the workspace export.
      cat > "$layer_root/usr/local/bin/awf-nvx-build-test" <<'EOF'
      #!/bin/bash
      set -u
      out=/workspace/.nvx-build-test
      mkdir -p "$out"

      export HOME=/tmp/nvx-build-home
      export XDG_CACHE_HOME="$HOME/.cache"
      export https_proxy="${HTTPS_PROXY:-}"
      export CI=true HUSKY=0
      export npm_config_cache=/tmp/nvx-npm-cache
      export npm_config_audit=false npm_config_fund=false
      export npm_config_update_notifier=false
      # .npmrc points at an Azure npm mirror that the guest allowlist does not
      # permit; the lockfile's resolved URLs are rewritten below.
      export npm_config_registry=https://registry.npmjs.org/
      # NVX strips credential-named files such as .npmrc from every layer,
      # including the workspace, so the repo's legacy-peer-deps setting is
      # restated here.
      export npm_config_legacy_peer_deps=true
      export GOPATH=/tmp/nvx-go GOCACHE=/tmp/nvx-go-cache GOTOOLCHAIN=local
      mkdir -p "$HOME"

      {
        echo "Node: $(node --version 2>&1)"
        echo "npm: $(npm --version 2>&1)"
        echo "Go: $(go version 2>&1)"
      } > "$out/versions.txt"
      cat "$out/versions.txt"

      http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://github.com || true)
      http_code=${http_code:-000}

      build=/tmp/nvx-build/repo
      mkdir -p "$build"
      tar -C /workspace \
        --exclude=./node_modules --exclude=./.git --exclude=./dist \
        --exclude=./.nvx-build-test \
        -cf - . | tar -C "$build" -xf -
      cd "$build"
      # Only the scratch copy is rewritten. npm's replace-registry-host swaps
      # just the host and keeps the mirror's path prefix, so it cannot be used.
      sed -E -i 's#https://[a-z0-9-]+\.pkgs\.visualstudio\.com/[^"]*/npm/registry/#https://registry.npmjs.org/#g' \
        package-lock.json

      timeout 15m npm ci > "$out/npm-ci.log" 2>&1
      npm_ci_exit=$?
      timeout 10m npm run build > "$out/npm-build.log" 2>&1
      npm_build_exit=$?
      if [ "$npm_ci_exit" -eq 0 ] && [ "$npm_build_exit" -eq 0 ]; then
        node_build=PASS
      else
        node_build=FAIL
      fi

      # The guest has a single vCPU, so Jest runs in-band.
      timeout 15m npx jest --ci --forceExit --runInBand \
        --testPathPatterns='squid-config|docker-manager|logger' \
        > "$out/jest.log" 2>&1
      if [ $? -eq 0 ]; then node_test=PASS; else node_test=FAIL; fi

      go_dir=/tmp/nvx-build/go-fixture
      git init -q "$go_dir"
      git -C "$go_dir" remote add origin https://github.com/Mossaka/gh-aw-firewall-test-go.git
      if timeout 5m git -C "$go_dir" fetch --depth 1 origin \
        c3e84fc697814119dba3b0ad82566dc2b2bbb880 > "$out/go-fetch.log" 2>&1; then
        git -C "$go_dir" checkout -q --detach FETCH_HEAD
        go_build=PASS
        go_test=PASS
        for module in color uuid; do
          (cd "$go_dir/$module" && go build ./...) >> "$out/go-build.log" 2>&1 || go_build=FAIL
          (cd "$go_dir/$module" && go test ./...) >> "$out/go-test.log" 2>&1 || go_test=FAIL
        done
      else
        go_build=CLONE_FAILED
        go_test=SKIPPED
      fi

      blocked_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com 2>/dev/null || true)
      blocked_code=${blocked_code:-000}
      if [ "$blocked_code" = "000" ] || [ "$blocked_code" = "403" ]; then
        network_isolation=PASS
      else
        network_isolation=FAIL
      fi

      cat > "$out/results.json" <<RESULTS_EOF
      {
        "marker": "${AWF_NVX_BUILD_MARKER:-}",
        "http_code": "$http_code",
        "node_build": "$node_build",
        "node_test": "$node_test",
        "go_build": "$go_build",
        "go_test": "$go_test",
        "network_isolation": "$network_isolation"
      }
      RESULTS_EOF
      cat "$out/results.json"
      echo AWF-NVX-BUILD-TEST-COMPLETE
      EOF
      chmod 0755 "$layer_root/usr/local/bin/awf-nvx-build-test"

  - name: Size /run for the NVX run directory
    run: |
      set -euo pipefail
      # NVX stages its EROFS layer images and the guest scratch image under
      # /run/awf-nvx/runs (src/nvx/paths.ts). /run is a RAM-backed tmpfs that
      # Ubuntu sizes at ~10% of RAM, which fits a single CLI invocation but not
      # a Node.js + Go distro layer, the workspace layer, and a multi-GiB
      # scratch overlay. tmpfs only allocates pages that are actually written,
      # so raising the ceiling does not reserve memory up front.
      df -h /run
      sudo mount -o remount,size=8G /run
      df -h /run

  - name: Run the build and test workloads inside an NVX microVM
    timeout-minutes: 55
    run: |
      # Evidence-producing: a failed workload must be recorded for the agent
      # to analyze rather than aborting the step before results are written.
      set +e
      set -u
      data_dir=/tmp/gh-aw/agent/smoke-nvx-build-test
      mkdir -p "$data_dir/logs"

      artifact_dir="$RUNNER_TEMP/nvx-attested-artifacts"
      layer_root="$RUNNER_TEMP/nvx-alpine-root"
      marker="nvx-build-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
      guest_out="$GITHUB_WORKSPACE/.nvx-build-test"
      sudo rm -rf "$guest_out"

      # A real build workload needs far more headroom than NVX's defaults
      # (512 MiB, 128 pids). The scratch overlay holds node_modules, dist, and
      # the npm and Go caches (estimated ~1 GiB) with headroom to spare.
      sudo timeout 50m \
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
        'github/gh-aw-firewall/.github/workflows/smoke-nvx-build-test.lock.yml' \
        --nvx-mount-policy workspace-only \
        --nvx-memory-mib 4096 \
        --nvx-memory-max-bytes 3758096384 \
        --nvx-pids-max 1024 \
        --nvx-scratch-bytes 3221225472 \
        --container-workdir /workspace \
        --network-isolation \
        --proxy-logs-dir "$data_dir/logs/inner-proxy-logs" \
        --allow-domains github.com,registry.npmjs.org \
        --env "AWF_NVX_BUILD_MARKER=$marker" \
        --log-level info \
        -- /usr/local/bin/awf-nvx-build-test \
        > "$data_dir/logs/awf.log" 2>&1
      awf_status=$?

      if [ -d "$guest_out" ]; then
        sudo mkdir -p "$data_dir/guest"
        sudo cp -R "$guest_out/." "$data_dir/guest/"
      fi
      sudo rm -rf "$guest_out"
      sudo chown -R "$(id -u):$(id -g)" "$data_dir"

      if [ "$awf_status" -eq 0 ]; then microvm_run=PASS; else microvm_run=FAIL; fi
      if grep -q 'AWF-NVX-BUILD-TEST-COMPLETE' "$data_dir/logs/awf.log"; then
        guest_completed=PASS
      else
        guest_completed=FAIL
      fi

      guest_results="$data_dir/guest/results.json"
      if [ -f "$guest_results" ] && jq -e . "$guest_results" > /dev/null 2>&1; then
        guest_json=$(cat "$guest_results")
      else
        guest_json='{}'
      fi
      # workspace_copy_back proves both --env passthrough and the post-run
      # copy-back of guest writes to the exported workspace.
      jq -n \
        --argjson guest "$guest_json" \
        --arg marker "$marker" \
        --arg awf_status "$awf_status" \
        --arg microvm_run "$microvm_run" \
        --arg guest_completed "$guest_completed" \
        '{
          microvm_run: $microvm_run,
          awf_exit_code: $awf_status,
          guest_completed: $guest_completed,
          workspace_copy_back: (if $guest.marker == $marker then "PASS" else "FAIL" end),
          http_code: ($guest.http_code // "missing"),
          node_build: ($guest.node_build // "missing"),
          node_test: ($guest.node_test // "missing"),
          go_build: ($guest.go_build // "missing"),
          go_test: ($guest.go_test // "missing"),
          network_isolation: ($guest.network_isolation // "missing")
        }' > "$data_dir/build-test-results.json"
      cat "$data_dir/build-test-results.json"

      exit 0
post-steps:
  - name: Upload NVX build test evidence
    if: always()
    uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
    with:
      name: nvx-build-test-evidence
      path: /tmp/gh-aw/agent/smoke-nvx-build-test/
      if-no-files-found: warn
      retention-days: 7
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        echo "Checked path: $OUTPUTS_FILE"
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          echo "::error::Agent did not call add_comment on a pull_request trigger."
          exit 1
        fi
        echo "add_comment verified for PR trigger"
      fi
      echo "Safe output validation passed"
  - name: Validate build test results
    run: |
      node <<'NODE'
      const fs = require("fs");
      const resultsPath = "/tmp/gh-aw/agent/smoke-nvx-build-test/build-test-results.json";
      if (!fs.existsSync(resultsPath)) {
        throw new Error(`Build test results not found: ${resultsPath}`);
      }
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      const expected = {
        microvm_run: "PASS",
        guest_completed: "PASS",
        workspace_copy_back: "PASS",
        node_build: "PASS",
        node_test: "PASS",
        go_build: "PASS",
        go_test: "PASS",
        network_isolation: "PASS",
      };
      const failures = Object.entries(expected)
        .filter(([key, value]) => results[key] !== value)
        .map(([key, value]) => `${key}: expected ${value}, received ${results[key] ?? "missing"}`);
      if (results.http_code !== "200") {
        failures.push(`http_code: expected 200, received ${results.http_code ?? "missing"}`);
      }
      if (failures.length > 0) {
        throw new Error(`NVX build test failed:\n${failures.join("\n")}`);
      }
      console.log("NVX build test results passed");
      NODE
---

> **[ASSIGNED WORKFLOW TASK]** Execute the authorized smoke test below.

# Smoke Test: NVX microVM + Build/Test Workloads

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Context

A pre-agent step already ran a deterministic Node.js and Go build/test workload inside an NVX one-shot microVM, through AWF's `nvx` runtime, and recorded the results. Do not re-run the microVM yourself; only analyze the recorded evidence.

## Step 1: Read Results

1. Read `/tmp/gh-aw/agent/smoke-nvx-build-test/build-test-results.json`. It contains:
   - `microvm_run`: whether `awf` exited 0 (PASS/FAIL)
   - `guest_completed`: whether the guest workload ran to completion (PASS/FAIL)
   - `workspace_copy_back`: whether the guest's workspace write, carrying the per-run `--env` marker, reached the host (PASS/FAIL)
   - `http_code`: GitHub.com HTTP response code from inside the guest
   - `node_build`: `npm ci && npm run build` status (PASS/FAIL)
   - `node_test`: Jest subset status (PASS/FAIL)
   - `go_build`: Go build status (PASS/FAIL/CLONE_FAILED)
   - `go_test`: Go test status (PASS/FAIL/SKIPPED)
   - `network_isolation`: whether a non-allowlisted domain was blocked (PASS/FAIL)
2. If anything failed, read the relevant log and add one short line naming the most likely cause:
   - `microvm_run` or `guest_completed`: `/tmp/gh-aw/agent/smoke-nvx-build-test/logs/awf.log`
   - Workload failures: `npm-ci.log`, `npm-build.log`, `jest.log`, `go-fetch.log`, `go-build.log`, or `go-test.log` under `/tmp/gh-aw/agent/smoke-nvx-build-test/guest/`

## Step 2: Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` with `item_number: ${{ github.event.pull_request.number }}` to post a **brief** comment:

### 🧊🏗️ NVX Build Test Results

| Test | Status |
|------|--------|
| microVM run | ✅/❌ |
| Workspace copy-back | ✅/❌ |
| GitHub.com connectivity | ✅/❌ |
| Node.js build (`npm ci && npm run build`) | ✅/❌ |
| Node.js tests (Jest subset) | ✅/❌ |
| Go build (color, uuid) | ✅/❌ |
| Go tests (color, uuid) | ✅/❌ |
| Network isolation | ✅/❌ |

**Overall: PASS/FAIL**

If all tests pass on a pull request trigger, call `add_labels` with the same item number and label `smoke-nvx-build`.

**If triggered by workflow_dispatch** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.
