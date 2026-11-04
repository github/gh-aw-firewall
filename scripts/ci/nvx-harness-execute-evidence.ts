import { createHash } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseInputs, runCase, type Inputs } from './nvx-manager-live-evidence';

export const NVX_HARNESS_FIXTURE_ROOT = '/usr/local/awf-harness-fixtures';

const cases = [
  { name: 'copilot-version', mode: 'valid', harness: 'copilot', output: '1.2.3' },
  { name: 'claude-version', mode: 'valid', harness: 'claude', output: '1.2.3 (Claude Code)' },
  { name: 'codex-version', mode: 'valid', harness: 'codex', output: 'codex-cli 1.2.3' },
  { name: 'malformed-version', mode: 'malformed', harness: 'copilot', output: 'not-a-version' },
  { name: 'failed-version', mode: 'failed', harness: 'copilot', exitCode: 7 },
  { name: 'oversized-version', mode: 'overflow', harness: 'copilot', output: 'x'.repeat(5000) },
  { name: 'command-exit', mode: 'valid', harness: 'copilot', command: true, exitCode: 23 },
  { name: 'execution-timeout', mode: 'timeout', harness: 'copilot', timeout: true },
  { name: 'execution-cancel', mode: 'timeout', harness: 'copilot', cancelled: true },
] as const;

type Execute = (
  inputs: Inputs,
  options: Parameters<typeof runCase>[1],
) => Promise<Pick<Awaited<ReturnType<typeof runCase>>, 'runId' | 'result' | 'output' | 'residue'>>;

/**
 * Exercise the existing one-shot invocation and recovered console/result data.
 * This deliberately does not extract or publish a canonical observation.
 */
export async function collectNvxHarnessExecuteEvidence(
  inputs: Inputs,
  execute: Execute = runCase,
) {
  const executions: Array<{ name: string; execution: Awaited<ReturnType<Execute>> }> = [];
  for (const test of cases) {
    const execution = await execute(inputs, {
      name: test.name,
      entrypoint: `${NVX_HARNESS_FIXTURE_ROOT}/${test.mode}/${test.harness}`,
      args: ['command' in test ? '--fixture-command' : '--version'],
      timeoutMs: 'timeout' in test ? 10_000 : 120_000,
      ...('cancelled' in test ? {
        cancelOnOutput: {
          marker: 'NVX-FIXTURE-ENV:',
          delayMs: 10_000,
          startupTimeoutMs: 90_000,
        },
      } : {}),
    });
    const expectedCode = 'timeout' in test ? 124 : 'cancelled' in test ? 130 :
      'exitCode' in test ? test.exitCode : 0;
    const expectedCategory = 'timeout' in test ? 'timeout' : 'cancelled' in test ? 'cancelled' :
      expectedCode === 0 ? 'success' : 'guest-exit';
    if (execution.result.exitCode !== expectedCode || execution.result.category !== expectedCategory ||
        execution.result.timedOut !== ('timeout' in test) || execution.residue.length > 0) {
      throw new Error(`NVX fixture ${test.name} returned an unexpected outcome or cleanup residue`);
    }
    // Serial output is data, not proof of success. Require the validated result
    // above as well, and do not call this stream isolated command stdout.
    const consoleOutput = `${execution.output.stdout}\n${execution.output.stderr}`;
    if (!/^NVX-FIXTURE-CONTEXT: uid=65534 gid=65534 cwd=\/\r?$/m.test(consoleOutput)) {
      throw new Error(`NVX fixture ${test.name} did not expose its guest context`);
    }
    if (!consoleOutput.split(/\r?\n/).includes(
      'NVX-FIXTURE-ENV: path=/usr/sbin:/usr/bin:/sbin:/bin home=/home/nobody user=nobody logname=nobody',
    )) {
      throw new Error(`NVX fixture ${test.name} did not expose its direct-entrypoint environment`);
    }
    if ('output' in test && !consoleOutput.split(/\r?\n/).includes(test.output)) {
      throw new Error(`NVX fixture ${test.name} did not recover its expected console output`);
    }
    if (test.name === 'failed-version' && !consoleOutput.includes('NVX-FIXTURE-VERSION-FAILED')) {
      throw new Error('NVX failed-version fixture did not recover its error output');
    }
    if ('command' in test && (!consoleOutput.split(/\r?\n/).includes('NVX-FIXTURE-COMMAND') ||
        !consoleOutput.includes('NVX-FIXTURE-COMMAND-STDERR'))) {
      throw new Error('NVX command fixture did not recover both output writes');
    }
    executions.push({ name: test.name, execution });
  }
  if (new Set(executions.map(({ execution }) => execution.runId)).size !== cases.length) {
    throw new Error('NVX fixtures must use distinct disposable executions');
  }
  return {
    schemaVersion: 1,
    evidenceKind: 'nvx-existing-execute-fixtures',
    outputSurface: 'OpenVMM/guest console; not isolated harness stdout/stderr',
    canonicalObservation: 'not-produced',
    productionAdmission: 'not-tested; runtime_probe_unsupported is unchanged',
    environmentEquivalence: 'not-established between disposable guests',
    probeBounds: 'execution timeout and 64 KiB console tails; not the canonical 10s/4096-byte probe',
    executions,
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.geteuid?.() !== 0) {
    throw new Error('Live NVX fixture evidence requires root on Linux x86_64 with KVM; no fallback');
  }
  await fs.access('/dev/kvm', constants.R_OK | constants.W_OK);
  const revision = process.env.AWF_NVX_EVIDENCE_REVISION;
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('AWF_NVX_EVIDENCE_REVISION must identify the exact tested checkout');
  }
  const inputs = parseInputs(process.argv.slice(2));
  const manifestSha256 = createHash('sha256')
    .update(await fs.readFile(path.join(inputs.artifacts, 'manifest.json'))).digest('hex');
  const fixtureSha256 = createHash('sha256').update(await fs.readFile(path.join(
    inputs.layer, NVX_HARNESS_FIXTURE_ROOT.slice(1), 'valid/copilot',
  ))).digest('hex');
  const evidence = await collectNvxHarnessExecuteEvidence(inputs);
  await fs.mkdir(inputs.evidence, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(inputs.evidence, 'harness-execute.json'), `${JSON.stringify({
    ...evidence,
    revision,
    environment: { platform: process.platform, architecture: process.arch, kernel: os.release() },
    artifactManifestSha256: manifestSha256,
    fixtureSha256,
  }, null, 2)}\n`, { mode: 0o600 });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
