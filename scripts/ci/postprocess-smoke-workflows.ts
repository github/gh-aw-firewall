#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPaths = [
  // Existing smoke workflows
  path.join(repoRoot, '.github/workflows/smoke-copilot.lock.yml'),
  path.join(repoRoot, '.github/workflows/smoke-claude.lock.yml'),
  path.join(repoRoot, '.github/workflows/smoke-chroot.lock.yml'),
  path.join(repoRoot, '.github/workflows/smoke-codex.lock.yml'),
  // Build test workflow (combined)
  path.join(repoRoot, '.github/workflows/build-test.lock.yml'),
  // Agentic workflows (use --image-tag/--skip-pull which must be replaced
  // with --build-local since chroot mode is now always-on and requires
  // a container image built from the current source)
  path.join(repoRoot, '.github/workflows/security-guard.lock.yml'),
  path.join(repoRoot, '.github/workflows/security-review.lock.yml'),
  path.join(repoRoot, '.github/workflows/ci-cd-gaps-assessment.lock.yml'),
  path.join(repoRoot, '.github/workflows/ci-doctor.lock.yml'),
  path.join(repoRoot, '.github/workflows/cli-flag-consistency-checker.lock.yml'),
  path.join(repoRoot, '.github/workflows/dependency-security-monitor.lock.yml'),
  path.join(repoRoot, '.github/workflows/doc-maintainer.lock.yml'),
  path.join(repoRoot, '.github/workflows/issue-duplication-detector.lock.yml'),
  path.join(repoRoot, '.github/workflows/issue-monster.lock.yml'),
  path.join(repoRoot, '.github/workflows/pelis-agent-factory-advisor.lock.yml'),
  path.join(repoRoot, '.github/workflows/plan.lock.yml'),
  path.join(repoRoot, '.github/workflows/test-coverage-improver.lock.yml'),
  path.join(repoRoot, '.github/workflows/update-release-notes.lock.yml'),
  // Secret digger workflows (red team security research)
  path.join(repoRoot, '.github/workflows/secret-digger-copilot.lock.yml'),
  path.join(repoRoot, '.github/workflows/secret-digger-codex.lock.yml'),
  path.join(repoRoot, '.github/workflows/secret-digger-claude.lock.yml'),
];

// Matches the install step with captured indentation:
// - "Install awf binary" step at any indent level
// - run command invoking install_awf_binary.sh with a version
const installStepRegex =
  /^(\s*)- name: Install awf binary\n\1\s*run: bash \/opt\/gh-aw\/actions\/install_awf_binary\.sh v[0-9.]+\n/m;
const installStepRegexGlobal = new RegExp(installStepRegex.source, 'gm');

function buildLocalInstallSteps(indent: string): string {
  const stepIndent = indent;
  const runIndent = `${indent}  `;
  const scriptIndent = `${runIndent}  `;

  return [
    `${stepIndent}- name: Install awf dependencies`,
    `${runIndent}run: npm ci`,
    `${stepIndent}- name: Build awf`,
    `${runIndent}run: npm run build`,
    `${stepIndent}- name: Install awf binary (local)`,
    `${runIndent}run: |`,
    `${scriptIndent}WORKSPACE_PATH="${'${GITHUB_WORKSPACE:-$(pwd)}'}"`,
    `${scriptIndent}NODE_BIN="$(command -v node)"`,
    `${scriptIndent}if [ ! -d "$WORKSPACE_PATH" ]; then`,
    `${scriptIndent}  echo "Workspace path not found: $WORKSPACE_PATH"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}if [ ! -x "$NODE_BIN" ]; then`,
    `${scriptIndent}  echo "Node binary not found: $NODE_BIN"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}if [ ! -d "/usr/local/bin" ]; then`,
    `${scriptIndent}  echo "/usr/local/bin is missing"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}sudo tee /usr/local/bin/awf > /dev/null <<EOF`,
    `${scriptIndent}#!/bin/bash`,
    `${scriptIndent}exec "${'${NODE_BIN}'}" "${'${WORKSPACE_PATH}'}/dist/cli.js" "\\$@"`,
    `${scriptIndent}EOF`,
    `${scriptIndent}sudo chmod +x /usr/local/bin/awf`,
  ].join('\n') + '\n';
}

// Remove sparse-checkout from the agent job's checkout step so the full repo
// is available for npm ci / npm run build. The compiler generates sparse-checkout
// for .github and .agents only, but we need src/, package.json, tsconfig.json etc.
// Match the sparse-checkout block (key + indented content lines) and the depth line.
const sparseCheckoutRegex = /^(\s+)sparse-checkout: \|\n(?:\1  .+\n)+/gm;
const shallowDepthRegex = /^(\s+)depth: 1\n/gm;

// Replace --image-tag <version> --skip-pull with --build-local so smoke tests
// use locally-built container images (with the latest entrypoint.sh, setup-iptables.sh, etc.)
// instead of pre-built GHCR images that may be stale.
const imageTagRegex = /--image-tag\s+[0-9.]+\s+--skip-pull/g;

// Remove the "Setup Scripts" step from update_cache_memory jobs.
// This step downloads the private github/gh-aw action but is never used in
// update_cache_memory (no subsequent steps reference /opt/gh-aw/actions/).
// With permissions: {} on these jobs, downloading the private action fails
// with 401 Unauthorized.
const updateCacheSetupScriptRegex =
  /^(\s+)- name: Setup Scripts\n\1  uses: github\/gh-aw\/actions\/setup@v[\d.]+\n\1  with:\n\1    destination: \/opt\/gh-aw\/actions\n(\1- name: Download cache-memory artifact)/gm;

for (const workflowPath of workflowPaths) {
  let content = fs.readFileSync(workflowPath, 'utf-8');
  let modified = false;

  // Replace "Install awf binary" step with local build steps
  const matches = content.match(installStepRegexGlobal);
  if (matches) {
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one awf install step in ${workflowPath}, found ${matches.length}. ` +
          'Ensure the workflow has a single "Install awf binary" step in the agent job.'
      );
    }
    content = content.replace(
      installStepRegexGlobal,
      (_match, indent: string) => buildLocalInstallSteps(indent)
    );
    modified = true;
    console.log(`  Replaced awf install step with local build`);
  }

  // Remove sparse-checkout from agent job checkout (need full repo for npm build)
  const sparseMatches = content.match(sparseCheckoutRegex);
  if (sparseMatches) {
    content = content.replace(sparseCheckoutRegex, '');
    modified = true;
    console.log(`  Removed ${sparseMatches.length} sparse-checkout block(s)`);
  }

  // Remove shallow depth (depth: 1) since full checkout is needed
  const depthMatches = content.match(shallowDepthRegex);
  if (depthMatches) {
    content = content.replace(shallowDepthRegex, '');
    modified = true;
    console.log(`  Removed ${depthMatches.length} shallow depth setting(s)`);
  }

  // Replace GHCR image tags with local builds
  const imageTagMatches = content.match(imageTagRegex);
  if (imageTagMatches) {
    content = content.replace(imageTagRegex, '--build-local');
    modified = true;
    console.log(`  Replaced ${imageTagMatches.length} --image-tag/--skip-pull with --build-local`);
  }

  // Remove unused "Setup Scripts" step from update_cache_memory jobs.
  // The step downloads a private action but is never used in these jobs,
  // causing 401 Unauthorized failures when permissions: {} is set.
  const updateCacheSetupMatches = content.match(updateCacheSetupScriptRegex);
  if (updateCacheSetupMatches) {
    content = content.replace(updateCacheSetupScriptRegex, '$2');
    modified = true;
    console.log(
      `  Removed ${updateCacheSetupMatches.length} unused Setup Scripts step(s) from update_cache_memory`
    );
  }

  // Inject --skip-cleanup after 'sudo -E awf' to skip cleanup in CI (saves ~10s)
  const skipCleanupRegex = /sudo -E awf(?! .*--skip-cleanup)/g;
  const skipCleanupMatches = content.match(skipCleanupRegex);
  if (skipCleanupMatches) {
    content = content.replace(skipCleanupRegex, 'sudo -E awf --skip-cleanup');
    modified = true;
    console.log(`  Injected --skip-cleanup into ${skipCleanupMatches.length} awf invocation(s)`);
  }

  if (modified) {
    fs.writeFileSync(workflowPath, content);
    console.log(`Updated ${workflowPath}`);
  } else {
    console.log(`Skipping ${workflowPath}: no changes needed.`);
  }
}
