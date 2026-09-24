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
    - "mkdir *"
    - "gh release download *"
    - "gh release view *"
    - "gh attestation verify *"
    - "tar -xzf *"
    - "ls *"
    - "cat *"
    - "sha256sum *"
  github:
    mode: gh-proxy
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

Use only `gh` (via bash) for all steps below. Do not use any other network
tool or MCP server.

## 1. Resolve the release to verify

This workflow can run two ways:

- **On `release: published`**: the tag to verify is fixed by the triggering
  event: `${{ github.event.release.tag_name }}`. Use that value exactly —
  do not query for the latest release, since a newer release may have been
  published by the time this run executes, and a prerelease's event tag is
  not necessarily returned by "latest" queries.
- **On `workflow_dispatch`** (manual run, no release event): resolve the
  latest published release tag with:

  ```bash
  gh release view --repo github/gh-aw-firewall --json tagName -q .tagName
  ```

Use whichever tag applies for every command below. If this repository's
release list is empty on a manual run (should not happen in practice), call
`noop` explaining that and stop.

## 2. Download the NVX preview test assets

```bash
mkdir -p /tmp/gh-aw/agent/nvx-verify
gh release download <tag> --repo github/gh-aw-firewall \
  --pattern 'nvx-test-x86_64.tar.gz' \
  --pattern 'nvx-test-x86_64.manifest.json' \
  --pattern 'nvx-test-x86_64.manifest.sigstore.jsonl' \
  --dir /tmp/gh-aw/agent/nvx-verify --clobber
```

If any of the three assets is missing from the release, that is a failure —
report it via `create-issue` (see step 5) and stop.

## 3. Verify tarball contents and checksums

```bash
mkdir -p /tmp/gh-aw/agent/nvx-verify/extracted
tar -xzf /tmp/gh-aw/agent/nvx-verify/nvx-test-x86_64.tar.gz -C /tmp/gh-aw/agent/nvx-verify/extracted
ls -la /tmp/gh-aw/agent/nvx-verify/extracted
cat /tmp/gh-aw/agent/nvx-verify/nvx-test-x86_64.manifest.json
```

Check that:

- The tarball extracted exactly three non-empty files: `openvmm`, `vmlinux`,
  and `initramfs.cpio.gz`.
- `nvx-test-x86_64.manifest.json` is valid JSON with an `artifacts` object
  containing `openvmm`, `kernel`, and `initramfs` entries, each with a
  `sha256` field.
- The `sha256sum` of each extracted file matches the corresponding manifest
  entry's `sha256` (`openvmm` → `artifacts.openvmm.sha256`, `vmlinux` →
  `artifacts.kernel.sha256`, `initramfs.cpio.gz` →
  `artifacts.initramfs.sha256`).

## 4. Verify Sigstore provenance

```bash
gh attestation verify /tmp/gh-aw/agent/nvx-verify/nvx-test-x86_64.manifest.json \
  --repo github/gh-aw-firewall \
  --bundle /tmp/gh-aw/agent/nvx-verify/nvx-test-x86_64.manifest.sigstore.jsonl
```

This must succeed (exit code 0) and confirm the manifest was attested by a
build in `github/gh-aw-firewall`.

## 5. Report the result

If every check in steps 2–4 passed, call `noop` with exactly this prefix
followed by the verified release tag:

```text
NVX_RELEASE_ASSET_VERIFICATION_PASS <tag>
```

If any check failed, call `create-issue` with a title of
`NVX release asset verification failed for <tag>` and a body listing exactly
which check(s) failed (missing asset, tarball entry, checksum mismatch, or
attestation failure) with the relevant command output. Never call `noop` when
any check failed.
