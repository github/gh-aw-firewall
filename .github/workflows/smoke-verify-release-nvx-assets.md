---
description: Verify a published gh-aw-firewall release stages its NVX preview test assets correctly — tarball contents, manifest checksums, and Sigstore provenance — guarding against regressions like the one fixed in PR #8965
on:
  release:
    types: [published]
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
name: Smoke Verify Release NVX Assets
engine:
  id: copilot
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "cat *"
    - "ls *"
steps:
  - name: Download and verify NVX release assets
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      RELEASE_TAG_INPUT: ${{ github.event.release.tag_name }}
    run: |
      # This step runs as a plain GitHub Actions step (full runner network,
      # not routed through the AWF agent sandbox's CLI proxy) because
      # `gh release download` needs to fetch binary asset content from
      # GitHub's release CDN. The agent-sandboxed `gh-proxy` tool mode only
      # relays structured JSON API calls and cannot transfer binary blobs —
      # `gh release download` there silently exits 0 with zero bytes written.
      set +e
      set -u

      DATA_DIR=/tmp/gh-aw/agent/nvx-verify
      mkdir -p "$DATA_DIR"
      RESULTS_FILE="$DATA_DIR/results.json"
      DL_DIR="$RUNNER_TEMP/nvx-verify"
      mkdir -p "$DL_DIR/extracted"

      # Resolve the release to verify. On `release: published`, the tag is
      # fixed by the triggering event — do not query for "latest", since a
      # newer release may have been published by the time this run executes,
      # and a prerelease's event tag is not necessarily returned by "latest"
      # queries. On `workflow_dispatch` (no release event), fall back to
      # querying the latest published release tag.
      if [ -n "${RELEASE_TAG_INPUT:-}" ]; then
        TAG="$RELEASE_TAG_INPUT"
      else
        TAG=$(gh release view --repo github/gh-aw-firewall --json tagName -q .tagName)
      fi

      record() {
        jq -cn --arg tag "$TAG" --arg pass "$1" --arg reason "$2" \
          '{tag:$tag, pass:($pass == "true"), reason:$reason}' > "$RESULTS_FILE"
      }

      if [ -z "$TAG" ]; then
        record false "Could not resolve a release tag to verify (empty release list?)"
        exit 0
      fi

      gh release download "$TAG" --repo github/gh-aw-firewall \
        --pattern 'nvx-test-x86_64.tar.gz' \
        --pattern 'nvx-test-x86_64.manifest.json' \
        --pattern 'nvx-test-x86_64.manifest.sigstore.jsonl' \
        --dir "$DL_DIR" --clobber
      if [ $? -ne 0 ] || [ ! -s "$DL_DIR/nvx-test-x86_64.tar.gz" ] \
        || [ ! -s "$DL_DIR/nvx-test-x86_64.manifest.json" ] \
        || [ ! -s "$DL_DIR/nvx-test-x86_64.manifest.sigstore.jsonl" ]; then
        record false "One or more NVX release assets are missing or failed to download for $TAG"
        exit 0
      fi

      tar -xzf "$DL_DIR/nvx-test-x86_64.tar.gz" -C "$DL_DIR/extracted"
      if [ $? -ne 0 ]; then
        record false "Failed to extract nvx-test-x86_64.tar.gz for $TAG"
        exit 0
      fi

      for f in openvmm vmlinux initramfs.cpio.gz; do
        if [ ! -s "$DL_DIR/extracted/$f" ]; then
          record false "Tarball for $TAG is missing expected non-empty file: $f"
          exit 0
        fi
      done

      if ! jq -e '.artifacts.openvmm.sha256 and .artifacts.kernel.sha256 and .artifacts.initramfs.sha256' \
        "$DL_DIR/nvx-test-x86_64.manifest.json" > /dev/null 2>&1; then
        record false "manifest.json for $TAG is not valid JSON or is missing required artifacts entries"
        exit 0
      fi

      declare -A manifest_key=( [openvmm]=openvmm [vmlinux]=kernel [initramfs.cpio.gz]=initramfs )
      for f in "${!manifest_key[@]}"; do
        expected=$(jq -r ".artifacts.${manifest_key[$f]}.sha256" "$DL_DIR/nvx-test-x86_64.manifest.json")
        actual=$(sha256sum "$DL_DIR/extracted/$f" | awk '{print $1}')
        if [ "$expected" != "$actual" ]; then
          record false "sha256 mismatch for $f in $TAG: manifest=$expected actual=$actual"
          exit 0
        fi
      done

      gh attestation verify "$DL_DIR/nvx-test-x86_64.manifest.json" \
        --repo github/gh-aw-firewall \
        --signer-workflow github/gh-aw-firewall/.github/workflows/release.yml \
        --deny-self-hosted-runners \
        --bundle "$DL_DIR/nvx-test-x86_64.manifest.sigstore.jsonl" \
        > "$DATA_DIR/attestation.log" 2>&1
      if [ $? -ne 0 ]; then
        record false "Sigstore attestation verification failed for $TAG (see attestation.log)"
        cp "$DATA_DIR/attestation.log" "$DATA_DIR/results.log" 2>/dev/null || true
        exit 0
      fi

      record true "All checks passed: assets present, tarball contents and checksums verified, Sigstore attestation verified"
safe-outputs:
  threat-detection:
    enabled: true
  create-issue:
    title-prefix: "[release-verify] "
    labels: [smoke-test, automation]
  messages:
    footer: "> 🚀🔍 *Release NVX asset verification by [{workflow_name}]({run_url})*"
    run-started: "🚀🔍 [{workflow_name}]({run_url}) is verifying the latest release's NVX preview test assets..."
    run-success: "🚀🔍 [{workflow_name}]({run_url}) completed. NVX release asset verification passed. ✅"
    run-failure: "🚀🔍 [{workflow_name}]({run_url}) reports {status}. NVX release asset verification found a problem."
strict: true
timeout-minutes: 15
concurrency:
  group: smoke-verify-release-nvx-assets
  cancel-in-progress: false
  queue: max
---

# Smoke Test: Verify Release NVX Assets

PR #8965 fixed a bug where the release workflow's "Stage NVX preview test
assets" step looked for `manifest.json` and `manifest.sigstore.jsonl` directly
under the downloaded artifact root, when `actions/upload-artifact` actually
preserves the `nvx-test-x86_64/` subdirectory those files were uploaded from.
This workflow verifies the fix is holding by checking a real published release.

A prior workflow step already downloaded the release's NVX preview test
assets and verified: asset presence, tarball contents, manifest checksums,
and Sigstore provenance. It wrote the outcome to
`/tmp/gh-aw/agent/nvx-verify/results.json` as a single JSON object:
`{"tag": "<release tag>", "pass": true|false, "reason": "<explanation>"}`.

If verification failed and `/tmp/gh-aw/agent/nvx-verify/attestation.log`
exists, its contents are relevant additional detail for the failure report.

## 1. Read the verification result

```bash
cat /tmp/gh-aw/agent/nvx-verify/results.json
ls /tmp/gh-aw/agent/nvx-verify/
```

## 2. Report the result

If `pass` is `true`, call `noop` with exactly this prefix followed by the
verified release tag:

```text
NVX_RELEASE_ASSET_VERIFICATION_PASS <tag>
```

If `pass` is `false`, call `create-issue` with a title of
`NVX release asset verification failed for <tag>` and a body containing the
`reason` field (and the contents of `attestation.log` if present). Never call
`noop` when `pass` is `false`.

