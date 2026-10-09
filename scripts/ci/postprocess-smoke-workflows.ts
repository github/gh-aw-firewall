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
  path.join(repoRoot, '.github/workflows/smoke-cloud-hypervisor-codex.lock.yml'),
  path.join(repoRoot, '.github/workflows/secret-digger-codex.lock.yml'),
];

// Release-mode workflows that intentionally test published binaries can be
// excluded here if we add any in the future.
const releaseModeLockFiles = new Set<string>();

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

const enclaveGvisorLockPath = path.join(
  workflowsDir,
  'smoke-enclave-cloud-hypervisor.lock.yml',
);
if (fs.existsSync(enclaveGvisorLockPath)) {
  const original = fs.readFileSync(enclaveGvisorLockPath, 'utf-8');
  const runtimeFlag = 'awf --container-runtime gvisor --config ';
  const serializedDockerRuntime = String.raw`\"containerRuntime\":\"docker\"`;
  const serializedGvisorRuntime = String.raw`\"containerRuntime\":\"gvisor\"`;
  let content = original;
  if (!content.includes(runtimeFlag)) {
    content = content.replace(
      runtimeCmdPattern,
      runtimeFlag,
    );
    if (!content.includes(runtimeFlag)) {
      throw new Error(`Could not select gVisor runtime in ${enclaveGvisorLockPath}`);
    }
  }
  if (!content.includes(serializedGvisorRuntime)) {
    const dockerRuntimeCount = content.split(serializedDockerRuntime).length - 1;
    if (dockerRuntimeCount !== 1) {
      throw new Error(
        `Expected exactly one Docker runtime in generated AWF config for ${enclaveGvisorLockPath}; found ${dockerRuntimeCount}`,
      );
    }
    content = content.replace(serializedDockerRuntime, serializedGvisorRuntime);
  }
  if (content !== original) {
    fs.writeFileSync(enclaveGvisorLockPath, content);
    console.log(`  Selected gVisor for the Cloud Hypervisor enclave smoke agent`);
    console.log(`Updated ${enclaveGvisorLockPath}`);
  } else {
    console.log(`Skipping ${enclaveGvisorLockPath}: gVisor runtime already selected.`);
  }
}

const playwrightRuntimeLockPaths = new Map([
  ['smoke-playwright-runc.lock.yml', 'docker-runc'],
  ['smoke-playwright-cloud-hypervisor.lock.yml', 'cloud-hypervisor'],
]);
for (const [lockFile, runtime] of playwrightRuntimeLockPaths) {
  const lockPath = path.join(workflowsDir, lockFile);
  try {
    const original = fs.readFileSync(lockPath, 'utf-8');
    const fixtureCommand = `bash scripts/ci/run-playwright-loopback-smoke.sh ${runtime} && `;
    if (original.includes(fixtureCommand)) {
      console.log(`Skipping ${lockPath}: Playwright fixture already injected.`);
      continue;
    }
    const harnessCommand =
      '"$GH_AW_NODE_EXEC" "${RUNNER_TEMP}/gh-aw/actions/copilot_harness.cjs"';
    const content = original.replace(
      harnessCommand,
      `${fixtureCommand}${harnessCommand}`,
    );
    if (content === original) {
      console.log(`  WARNING: Could not inject Playwright fixture into ${lockPath}`);
      continue;
    }
    fs.writeFileSync(lockPath, content);
    console.log(`  Injected Playwright ${runtime} fixture into AWF command`);
    console.log(`Updated ${lockPath}`);
  } catch {
    console.log(`Skipping ${lockPath}: file not found.`);
  }
}
