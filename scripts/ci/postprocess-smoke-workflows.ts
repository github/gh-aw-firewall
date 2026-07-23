#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';
import { applyCodexWorkflowPatches } from './apply-codex-workflow-patches';


const repoRoot = path.resolve(__dirname, '../..');

// Codex-only workflow files that use OpenAI models.
// xpia.md sanitization is applied only to these files because gh-aw v0.64.2
// introduced an xpia.md security policy that uses specific cybersecurity
// terminology (e.g. "container escape", "DNS/ICMP tunneling", "port scanning",
// "exploit tools") which triggers OpenAI's cyber_policy_violation content
// filter, causing every Codex model request to fail with:
//   "This user's access to this model has been temporarily limited for
//    potentially suspicious activity related to cybersecurity."
// The safe inline replacement achieves the same XPIA-prevention intent without
// using trigger terms.
const codexWorkflowPaths = [
  path.join(repoRoot, '.github/workflows/smoke-codex.lock.yml'),
  path.join(repoRoot, '.github/workflows/secret-digger-codex.lock.yml'),
];

// Release-mode workflows that intentionally test PUBLISHED awf binaries and
// PRE-BUILT GHCR container images (pinned to a concrete release) instead of the
// repo's own source. These must NOT be post-processed: the local-build install
// and --skip-pull -> --build-local rewrites would replace the released bundle
// with a source build, which is incompatible (e.g. the standalone awf bundle
// rejects --build-local: "requires a full repository checkout").
//
// Currently empty: all workflows (including the network-isolation variants)
// build awf/firewall from the repo's own source and use the compiler-default
// mcp gateway version. The full-repo checkout injected by the post-processor
// makes --build-local valid everywhere.
const releaseModeLockFiles = new Set<string>([]);

// Auto-discover all lock files so new workflows are automatically included.
// This avoids the recurring bug where adding a new workflow .md file and
// compiling it produces a lock file with --image-tag/--skip-pull that isn't
// post-processed, causing CI failures ("No such image").
const workflowsDir = path.join(repoRoot, '.github/workflows');
const workflowPaths = fs.readdirSync(workflowsDir)
  .filter(f => f.endsWith('.lock.yml'))
  .filter(f => !releaseModeLockFiles.has(f))
  .sort()
  .map(f => path.join(workflowsDir, f));

for (const workflowPath of workflowPaths) {
  const original = fs.readFileSync(workflowPath, 'utf-8');
  const { content, log } = applyGeneralWorkflowPatches(original, workflowPath);
  log.forEach(msg => console.log(msg));
  if (content !== original) {
    fs.writeFileSync(workflowPath, content);
    console.log(`Updated ${workflowPath}`);
  } else {
    console.log(`Skipping ${workflowPath}: no changes needed.`);
  }
}

for (const workflowPath of codexWorkflowPaths) {
  let original: string;
  try {
    original = fs.readFileSync(workflowPath, 'utf-8');
  } catch {
    console.log(`Skipping ${workflowPath}: file not found.`);
    continue;
  }
  const { content, log } = applyCodexWorkflowPatches(original);
  log.forEach(msg => console.log(msg));
  if (content !== original) {
    fs.writeFileSync(workflowPath, content);
    console.log(`Updated ${workflowPath}`);
  } else {
    console.log(`Skipping ${workflowPath}: no xpia.md changes needed.`);
  }
}

// ── Runtime workflow patching: inject --container-runtime into AWF commands ───
// The compiler doesn't support sandbox.agent.containerRuntime yet, so we inject it here.
const runtimeCmdPattern = /awf --config /g;

const gvisorLockPath = path.join(workflowsDir, 'smoke-gvisor.lock.yml');
try {
  const gvisorContent = fs.readFileSync(gvisorLockPath, 'utf-8');
  const replacedContent = gvisorContent.replace(runtimeCmdPattern, 'awf --container-runtime gvisor --config ');
  if (replacedContent !== gvisorContent) {
    fs.writeFileSync(gvisorLockPath, replacedContent);
    console.log(`  Injected --container-runtime gvisor into AWF command`);
    console.log(`Updated ${gvisorLockPath}`);
  } else {
    console.log(`Skipping ${gvisorLockPath}: no AWF command found to patch.`);
  }
} catch {
  console.log(`Skipping ${gvisorLockPath}: file not found.`);
}

// sbx CLI install + daemon auth steps that gh-aw v0.82.8 dropped from compilation.
// Injected after "Install awf binary (local)", before "Determine automatic lockdown mode".
const SBX_INSTALL_AND_AUTH_STEPS =
  '      - name: Install Docker sbx CLI\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          echo "::group::Install Docker sbx"\n' +
  '          # Add Docker apt repo (REPO_ONLY=1 skips installing Docker Engine)\n' +
  '          curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh\n' +
  '          sudo apt-get install -y docker-sbx\n' +
  '          sbx version\n' +
  '          echo "::endgroup::"\n' +
  '\n' +
  '          echo "::group::Verify KVM availability"\n' +
  '          if lsmod | grep -q kvm; then\n' +
  '            echo "✅ KVM is available"\n' +
  '            # Ensure runner user can access /dev/kvm (may not be in kvm group)\n' +
  '            if [ -w /dev/kvm ]; then\n' +
  '              echo "✅ /dev/kvm is writable"\n' +
  '            else\n' +
  '              echo "Fixing /dev/kvm permissions..."\n' +
  '              sudo chmod 666 /dev/kvm\n' +
  '            fi\n' +
  '          else\n' +
  '            echo "⚠️ KVM not available — sbx will not start"\n' +
  '            kvm-ok 2>&1 || true\n' +
  '          fi\n' +
  '          echo "::endgroup::"\n' +
  '      - name: Authenticate Docker sbx\n' +
  '        env:\n' +
  '          DOCKER_PAT_VAL: ${{ secrets.DOCKER_PAT }}\n' +
  '          DOCKER_USERNAME_VAL: ${{ secrets.DOCKER_USERNAME }}\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '\n' +
  '          # Start daemon in background\n' +
  '          nohup sbx daemon start > /tmp/sbx-daemon.log 2>&1 &\n' +
  '          disown\n' +
  '          for i in $(seq 1 10); do\n' +
  '            if sbx daemon status 2>/dev/null | grep -q "running"; then break; fi\n' +
  '            sleep 1\n' +
  '          done\n' +
  '\n' +
  '          # Authenticate with Docker Hub\n' +
  '          printf \'%s\' "$DOCKER_PAT_VAL" | docker login --username "$DOCKER_USERNAME_VAL" --password-stdin\n' +
  '          printf \'%s\' "$DOCKER_PAT_VAL" | sbx login --username "$DOCKER_USERNAME_VAL" --password-stdin\n' +
  '\n' +
  '          # Reset policy store and re-initialize (required for mount policy)\n' +
  '          sbx daemon stop || true\n' +
  '          sbx policy reset --force || true\n' +
  '          sbx policy init allow-all\n' +
  '          nohup sbx daemon start > /tmp/sbx-daemon.log 2>&1 &\n' +
  '          disown\n' +
  '          for i in $(seq 1 10); do\n' +
  '            if sbx daemon status 2>/dev/null | grep -q "running"; then break; fi\n' +
  '            sleep 1\n' +
  '          done\n' +
  '          # Re-authenticate after daemon restart\n' +
  '          printf \'%s\' "$DOCKER_PAT_VAL" | sbx login --username "$DOCKER_USERNAME_VAL" --password-stdin\n' +
  '\n' +
  '          # Pre-pull template image into sbx\'s containerd cache\n' +
  '          docker pull docker/sandbox-templates:shell-docker\n' +
  '\n' +
  '          # Smoke test: create → exec → cleanup\n' +
  '          bash -c \'yes | sbx create shell --name test-sandbox-direct "$GITHUB_WORKSPACE" 2>&1\' || true\n' +
  '          sbx exec test-sandbox-direct uname -a\n' +
  '          sbx stop test-sandbox-direct 2>/dev/null || true\n' +
  '          sbx rm --force test-sandbox-direct 2>/dev/null || true\n' +
  '          echo "✅ sbx ready"\n';

// sbx credential refresh step injected immediately before the agent execution step.
const SBX_REFRESH_CREDENTIALS_STEP =
  '      - name: Refresh sbx credentials\n' +
  '        env:\n' +
  '          DOCKER_PAT_VAL: ${{ secrets.DOCKER_PAT }}\n' +
  '          DOCKER_USERNAME_VAL: ${{ secrets.DOCKER_USERNAME }}\n' +
  '        run: |\n' +
  '          # Re-authenticate sbx immediately before AWF runs.\n' +
  '          # Docker Hub OAuth tokens from sbx login can expire between steps.\n' +
  '          printf \'%s\' "$DOCKER_PAT_VAL" | sbx login --username "$DOCKER_USERNAME_VAL" --password-stdin\n' +
  '          echo "✅ sbx credentials refreshed"\n';

const SBX_LOCKDOWN_ANCHOR = '      - name: Determine automatic lockdown mode for GitHub MCP Server';
const SBX_EXECUTE_ANCHOR = '      - name: Execute GitHub Copilot CLI';

const sbxLockPath = path.join(workflowsDir, 'smoke-docker-sbx.lock.yml');
try {
  const sbxOriginal = fs.readFileSync(sbxLockPath, 'utf-8');
  let sbxContent = sbxOriginal;

  // (1) Inject --container-runtime sbx into AWF command
  runtimeCmdPattern.lastIndex = 0;
  const sbxWithRuntime = sbxContent.replace(runtimeCmdPattern, 'awf --container-runtime sbx --config ');
  if (sbxWithRuntime !== sbxContent) {
    sbxContent = sbxWithRuntime;
    console.log(`  Injected --container-runtime sbx into AWF command`);
  }

  // (2) Inject sbx CLI install + daemon auth steps (dropped by gh-aw v0.82.8 compiler)
  if (!sbxContent.includes('- name: Install Docker sbx CLI')) {
    if (sbxContent.includes(SBX_LOCKDOWN_ANCHOR)) {
      sbxContent = sbxContent.replace(SBX_LOCKDOWN_ANCHOR, SBX_INSTALL_AND_AUTH_STEPS + SBX_LOCKDOWN_ANCHOR);
      console.log(`  Injected sbx CLI install and daemon auth steps`);
    } else {
      console.log(`  WARNING: Could not find lockdown anchor; sbx install/auth steps not injected`);
    }
  } else {
    console.log(`  sbx CLI install and auth steps already present`);
  }

  // (3) Inject sbx credential refresh step immediately before agent execution
  if (!sbxContent.includes('- name: Refresh sbx credentials')) {
    if (sbxContent.includes(SBX_EXECUTE_ANCHOR)) {
      sbxContent = sbxContent.replace(SBX_EXECUTE_ANCHOR, SBX_REFRESH_CREDENTIALS_STEP + SBX_EXECUTE_ANCHOR);
      console.log(`  Injected sbx credential refresh step`);
    } else {
      console.log(`  WARNING: Could not find execute anchor; sbx credential refresh step not injected`);
    }
  } else {
    console.log(`  sbx credential refresh step already present`);
  }

  if (sbxContent !== sbxOriginal) {
    fs.writeFileSync(sbxLockPath, sbxContent);
    console.log(`Updated ${sbxLockPath}`);
  } else {
    console.log(`Skipping ${sbxLockPath}: no changes needed.`);
  }
} catch {
  console.log(`Skipping ${sbxLockPath}: file not found.`);
}
