import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import execa from 'execa';
import {
  NVX_ARTIFACT_RELEASE_TAG,
  NvxManager,
  createNvxRunLayout,
} from '../../src/nvx';

interface Inputs {
  artifacts: string;
  layer: string;
  bridge: string;
  signerWorkflow: string;
  evidence: string;
  childRunId?: string;
}

const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

async function main(): Promise<void> {
  if (process.geteuid?.() !== 0) {
    throw new Error('NVX live evidence runner must execute as root');
  }
  const inputs = parseInputs(process.argv.slice(2));
  await fs.mkdir(inputs.evidence, { recursive: true, mode: 0o700 });
  if (inputs.childRunId) {
    await runCase(inputs, {
      name: 'stale-owner-child',
      runId: inputs.childRunId,
      entrypoint: '/bin/sleep',
      args: ['300'],
      timeoutMs: 600_000,
    });
    return;
  }

  const success = await runCase(inputs, {
    name: 'guest-boot',
    entrypoint: '/bin/true',
    timeoutMs: 120_000,
  });
  if (success.result.exitCode !== 0 || success.result.category !== 'success') {
    throw new Error(
      `NVX guest boot returned ${success.result.category}/${success.result.exitCode} ` +
      `signal=${success.result.signal ?? 'none'}`,
    );
  }

  const filesystem = await runCase(inputs, {
    name: 'filesystem-denial',
    entrypoint: '/usr/local/bin/nvx-filesystem-proof',
    timeoutMs: 120_000,
  });
  assertSuccess(filesystem, 'NVX filesystem denial');
  assertOutputContains(filesystem, 'NVX-FILESYSTEM-DENIAL-PROOF');

  const network = await runCase(inputs, {
    name: 'network-denial',
    entrypoint: '/usr/local/bin/nvx-network-proof',
    timeoutMs: 120_000,
    enableApiProxy: true,
  });
  assertSuccess(network, 'NVX network denial');
  assertOutputContains(network, 'NVX-NETWORK-DENIAL-PROOF');

  const copilot = await runCase(inputs, {
    name: 'copilot-api-proxy',
    entrypoint: '/usr/local/bin/run-copilot-proof',
    timeoutMs: 300_000,
    enableApiProxy: true,
    memoryMib: 768,
    memoryMaxBytes: 805_306_368,
    pidsMax: 256,
    scratchBytes: 1024 * 1024 * 1024,
  });
  assertSuccess(copilot, 'NVX Copilot API-proxy inference');
  assertOutputContains(copilot, 'NVX-COPILOT-PROOF');

  const timeout = await runCase(inputs, {
    name: 'timeout-cleanup',
    entrypoint: '/bin/sleep',
    args: ['300'],
    timeoutMs: 60_000,
  });
  if (timeout.result.exitCode !== 124 || timeout.result.category !== 'timeout') {
    throw new Error(
      `NVX timeout returned ${timeout.result.category}/${timeout.result.exitCode} ` +
      `signal=${timeout.result.signal ?? 'none'}`,
    );
  }

  const cancellation = await runCase(inputs, {
    name: 'cancellation-cleanup',
    entrypoint: '/bin/sleep',
    args: ['300'],
    timeoutMs: 120_000,
    abortAfterMs: 5_000,
  });
  if (
    cancellation.result.exitCode !== 130 ||
    cancellation.result.category !== 'cancelled'
  ) {
    throw new Error(
      `NVX cancellation returned ${cancellation.result.category}/` +
      `${cancellation.result.exitCode} signal=${cancellation.result.signal ?? 'none'}`,
    );
  }

  const staleRecovery = await runStaleRecoveryCase(inputs);
  const concurrent = await runConcurrentCase(inputs);

  await fs.writeFile(
    path.join(inputs.evidence, 'summary.json'),
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        { name: 'attested-manager-guest-boot', status: 'PASS', ...success },
        { name: 'filesystem-credential-denial', status: 'PASS', ...filesystem },
        { name: 'network-default-denial', status: 'PASS', ...network },
        { name: 'copilot-api-proxy-inference', status: 'PASS', ...copilot },
        { name: 'timeout-process-tree-cleanup', status: 'PASS', ...timeout },
        {
          name: 'cancellation-process-tree-cleanup',
          status: 'PASS',
          ...cancellation,
        },
        { name: 'durable-stale-recovery', status: 'PASS', ...staleRecovery },
        { name: 'concurrent-run-isolation', status: 'PASS', ...concurrent },
      ],
    }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

interface RunCaseOptions {
  name: string;
  runId?: string;
  entrypoint: string;
  args?: readonly string[];
  timeoutMs: number;
  abortAfterMs?: number;
  enableApiProxy?: boolean;
  memoryMib?: number;
  memoryMaxBytes?: number;
  pidsMax?: number;
  scratchBytes?: number;
}

async function runCase(
  inputs: Inputs,
  options: RunCaseOptions,
) {
  const runId = options.runId ?? randomBytes(16).toString('hex');
  const layout = createNvxRunLayout(runId);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  stdout.on('data', (chunk: Buffer) => {
    stdoutBytes = appendBoundedOutput(stdoutChunks, stdoutBytes, chunk);
    process.stdout.write(chunk);
  });
  stderr.on('data', (chunk: Buffer) => {
    stderrBytes = appendBoundedOutput(stderrChunks, stderrBytes, chunk);
    process.stderr.write(chunk);
  });
  const abortController = options.abortAfterMs === undefined
    ? undefined
    : new AbortController();
  const abortTimer = options.abortAfterMs === undefined
    ? undefined
    : setTimeout(() => abortController!.abort(), options.abortAfterMs);
  const manager = new NvxManager({
    runId,
    preflight: {
      runId,
      expectedReleaseTag: NVX_ARTIFACT_RELEASE_TAG,
      expectedSignerWorkflow: inputs.signerWorkflow,
      manifestPath: path.join(inputs.artifacts, 'manifest.json'),
      artifactManifestBundlePath: path.join(
        inputs.artifacts,
        'manifest.sigstore.jsonl',
      ),
      artifacts: {
        openvmm: path.join(inputs.artifacts, 'openvmm'),
        kernel: path.join(inputs.artifacts, 'vmlinux'),
        initramfs: path.join(inputs.artifacts, 'initramfs.cpio.gz'),
      },
    },
    filesystem: {
      workDir: '/run/awf-nvx',
      layers: [{ role: 'distro', sourcePath: inputs.layer }],
      scratchBytes: options.scratchBytes ?? 128 * 1024 * 1024,
      maxScratchBytes: options.scratchBytes ?? 128 * 1024 * 1024,
    },
    execution: {
      entrypoint: options.entrypoint,
      args: options.args,
      workloadUid: 65534,
      workloadGid: 65534,
      memoryMaxBytes: options.memoryMaxBytes ?? 128 * 1024 * 1024,
      pidsMax: options.pidsMax ?? 64,
      memoryMib: options.memoryMib ?? 256,
      timeoutMs: options.timeoutMs,
      abortSignal: abortController?.signal,
      stdout,
      stderr,
    },
    network: {
      infrastructureBridge: inputs.bridge,
      enableApiProxy: options.enableApiProxy ?? false,
    },
  });

  let result;
  try {
    result = await manager.execute();
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    stdout.end();
    stderr.end();
  }
  const confinement = manager.getConfinementEvidence();
  if (!confinement) throw new Error(`${options.name} produced no confinement evidence`);
  const residue = await inspectResidue(layout);
  if (residue.length > 0) {
    throw new Error(`${options.name} left NVX residue: ${residue.join(', ')}`);
  }
  return {
    runId,
    result: {
      exitCode: result.exitCode,
      category: result.category,
      signal: result.signal,
      timedOut: result.timedOut,
      outcome: result.outcome,
    },
    output: {
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    },
    confinement,
    residue,
  };
}

async function runStaleRecoveryCase(inputs: Inputs) {
  const staleRunId = randomBytes(16).toString('hex');
  const staleLayout = createNvxRunLayout(staleRunId);
  const child = spawn(process.execPath, [
    __filename,
    '--artifacts', inputs.artifacts,
    '--layer', inputs.layer,
    '--bridge', inputs.bridge,
    '--signerWorkflow', inputs.signerWorkflow,
    '--evidence', inputs.evidence,
    '--childRunId', staleRunId,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExitPromise = waitForExit(child);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  if (!child.pid) throw new Error('NVX stale recovery child did not start');

  let staleRecord: { vmmIdentity?: { name?: string }; stages?: { processStarted?: boolean } };
  try {
    staleRecord = await waitForCleanupRecord(staleLayout.cleanupRecordPath);
  } catch (error) {
    child.kill('SIGKILL');
    await childExitPromise;
    throw error;
  }
  child.kill('SIGKILL');
  const childExit = await childExitPromise;
  if (childExit.signal !== 'SIGKILL') {
    throw new Error(
      `NVX stale recovery child exited unexpectedly: ` +
      `${childExit.code ?? 'null'}/${childExit.signal ?? 'none'}`,
    );
  }

  const recovery = await runCase(inputs, {
    name: 'stale-recovery-trigger',
    entrypoint: '/bin/true',
    timeoutMs: 120_000,
  });
  assertSuccess(recovery, 'NVX stale recovery trigger');
  const residue = await inspectResidue(staleLayout);
  const accountName = staleRecord.vmmIdentity?.name;
  if (accountName && await accountExists(accountName)) residue.push(`account:${accountName}`);
  if (residue.length > 0) {
    throw new Error(`NVX stale recovery left residue: ${residue.join(', ')}`);
  }
  return {
    staleRunId,
    ownerExit: childExit,
    recoveryRunId: recovery.runId,
    residue,
  };
}

async function runConcurrentCase(inputs: Inputs) {
  const runIds = [
    randomBytes(16).toString('hex'),
    randomBytes(16).toString('hex'),
  ];
  const layouts = runIds.map(createNvxRunLayout);
  if (
    new Set(layouts.map(({ networkNamespace }) => networkNamespace)).size !== 2 ||
    new Set(layouts.map(({ runDirectory }) => runDirectory)).size !== 2 ||
    new Set(layouts.map(({ cgroupPath }) => cgroupPath)).size !== 2
  ) {
    throw new Error('NVX concurrent runs did not receive distinct resource identities');
  }
  const results = await Promise.all(runIds.map((runId, index) =>
    runCase(inputs, {
      name: `concurrent-${index + 1}`,
      runId,
      entrypoint: '/bin/sleep',
      args: ['2'],
      timeoutMs: 120_000,
    })));
  for (const result of results) assertSuccess(result, `NVX concurrent run ${result.runId}`);
  return {
    runIds,
    resourceIdentities: layouts.map((layout) => ({
      networkNamespace: layout.networkNamespace,
      runDirectory: layout.runDirectory,
      cgroupPath: layout.cgroupPath,
    })),
    results,
  };
}

async function waitForCleanupRecord(
  recordPath: string,
): Promise<{ vmmIdentity?: { name?: string }; stages?: { processStarted?: boolean } }> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        vmmIdentity?: { name?: string };
        stages?: { processStarted?: boolean };
      };
      if (record.stages?.processStarted) return record;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for live NVX cleanup record ${recordPath}: ${String(lastError)}`,
  );
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function accountExists(name: string): Promise<boolean> {
  const result = await execa('/usr/bin/getent', ['passwd', name], { reject: false });
  return result.exitCode === 0;
}

function assertSuccess(
  value: Awaited<ReturnType<typeof runCase>>,
  label: string,
): void {
  if (value.result.exitCode !== 0 || value.result.category !== 'success') {
    throw new Error(
      `${label} returned ${value.result.category}/${value.result.exitCode} ` +
      `signal=${value.result.signal ?? 'none'}`,
    );
  }
}

function assertOutputContains(
  value: Awaited<ReturnType<typeof runCase>>,
  marker: string,
): void {
  if (!value.output.stdout.split(/\r?\n/).some((line) => line.includes(marker))) {
    throw new Error(`${value.runId} did not emit required marker ${marker}`);
  }
}

function appendBoundedOutput(
  chunks: Buffer[],
  totalBytes: number,
  chunk: Buffer,
): number {
  const value = Buffer.from(chunk);
  chunks.push(value);
  totalBytes += value.length;
  while (totalBytes > MAX_CAPTURED_OUTPUT_BYTES && chunks.length > 0) {
    const excess = totalBytes - MAX_CAPTURED_OUTPUT_BYTES;
    const first = chunks[0];
    if (first.length <= excess) {
      chunks.shift();
      totalBytes -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      totalBytes -= excess;
    }
  }
  return totalBytes;
}

async function inspectResidue(layout: ReturnType<typeof createNvxRunLayout>): Promise<string[]> {
  const residue: string[] = [];
  for (const candidate of [
    layout.artifactSnapshotDirectory,
    layout.runDirectory,
    layout.cleanupRecordPath,
    layout.cgroupPath,
  ]) {
    try {
      await fs.access(candidate, constants.F_OK);
      residue.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const namespaces = await execa('/usr/sbin/ip', ['netns', 'list']);
  if (namespaces.stdout.split(/\r?\n/).some((line) =>
    line.split(/\s+/, 1)[0] === layout.networkNamespace
  )) {
    residue.push(layout.networkNamespace);
  }
  return residue;
}

function parseInputs(args: readonly string[]): Inputs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new Error(`Malformed NVX evidence argument near ${name ?? '<end>'}`);
    }
    values.set(name.slice(2), value);
  }
  const required = (name: keyof Inputs): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return path.resolve(value);
  };
  const signerWorkflow = values.get('signerWorkflow');
  if (!signerWorkflow) throw new Error('Missing --signerWorkflow');
  return {
    artifacts: required('artifacts'),
    layer: required('layer'),
    bridge: values.get('bridge') ?? 'awfnvxbr0',
    signerWorkflow,
    evidence: required('evidence'),
    ...(values.get('childRunId') ? { childRunId: values.get('childRunId') } : {}),
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
