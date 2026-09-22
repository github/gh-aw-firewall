import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
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
}

async function main(): Promise<void> {
  if (process.geteuid?.() !== 0) {
    throw new Error('NVX live evidence runner must execute as root');
  }
  const inputs = parseInputs(process.argv.slice(2));
  await fs.mkdir(inputs.evidence, { recursive: true, mode: 0o700 });

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

  await fs.writeFile(
    path.join(inputs.evidence, 'summary.json'),
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        { name: 'attested-manager-guest-boot', status: 'PASS', ...success },
        { name: 'timeout-process-tree-cleanup', status: 'PASS', ...timeout },
      ],
    }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

async function runCase(
  inputs: Inputs,
  options: {
    name: string;
    entrypoint: string;
    args?: readonly string[];
    timeoutMs: number;
  },
) {
  const runId = randomBytes(16).toString('hex');
  const layout = createNvxRunLayout(runId);
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
      scratchBytes: 128 * 1024 * 1024,
      maxScratchBytes: 128 * 1024 * 1024,
    },
    execution: {
      entrypoint: options.entrypoint,
      args: options.args,
      workloadUid: 65534,
      workloadGid: 65534,
      memoryMaxBytes: 128 * 1024 * 1024,
      pidsMax: 64,
      memoryMib: 256,
      timeoutMs: options.timeoutMs,
      stdout: process.stdout,
      stderr: process.stderr,
    },
    network: {
      infrastructureBridge: inputs.bridge,
      enableApiProxy: false,
    },
  });

  const result = await manager.execute();
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
    confinement,
    residue,
  };
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
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
