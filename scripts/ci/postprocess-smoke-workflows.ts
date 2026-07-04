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
const releaseModeLockFiles = new Set<string>([
  'network-isolation-test.lock.yml',
  'build-test-network-isolation.lock.yml',
]);

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
