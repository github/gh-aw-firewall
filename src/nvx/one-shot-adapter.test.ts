import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { NvxFilesystemBundle } from './filesystem-builder';
import {
  buildNvxOneShotArguments,
  NvxOneShotAdapter,
  type NvxOneShotAdapterDependencies,
  type NvxOneShotExecutionRequest,
} from './one-shot-adapter';
import { NVX_TEARDOWN_STAGES } from './outcome';

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function fixture(): Promise<{
  root: string;
  bundle: NvxFilesystemBundle;
  request: NvxOneShotExecutionRequest;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-run-'));
  const nvxRoot = path.join(root, 'nvx');
  const runDirectory = path.join(root, 'run');
  await fs.mkdir(path.join(nvxRoot, 'scripts'), { recursive: true });
  await fs.mkdir(runDirectory);
  await fs.chmod(runDirectory, 0o700);
  await fs.writeFile(path.join(nvxRoot, 'scripts', 'nvx.py'), '#!/usr/bin/env python3\n');
  const layerPath = path.join(runDirectory, 'distro.erofs');
  const scratchPath = path.join(runDirectory, 'scratch.ext4');
  await fs.writeFile(layerPath, 'layer');
  await fs.writeFile(scratchPath, 'scratch', { mode: 0o600 });
  await fs.chmod(layerPath, 0o400);
  await fs.chmod(scratchPath, 0o600);
  const bundle: NvxFilesystemBundle = {
    runDirectory,
    manifestPath: path.join(runDirectory, 'manifest.json'),
    sourceDateEpoch: 0,
    layers: [{
      role: 'distro',
      path: layerPath,
      uuid: '11111111-2222-5333-8444-555555555555',
      sha256: await sha256(layerPath),
      sourceManifestSha256: 'a'.repeat(64),
      sourceEntries: 1,
      excludedPaths: [],
    }],
    scratch: {
      path: scratchPath,
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sizeBytes: (await fs.stat(scratchPath)).size,
    },
  };
  await fs.writeFile(bundle.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    sourceDateEpoch: bundle.sourceDateEpoch,
    layers: bundle.layers.map((layer) => ({
      role: layer.role,
      file: path.basename(layer.path),
      uuid: layer.uuid,
      sha256: layer.sha256,
      sourceManifestSha256: layer.sourceManifestSha256,
      sourceEntries: layer.sourceEntries,
      excludedPaths: layer.excludedPaths,
    })),
    scratch: {
      file: path.basename(bundle.scratch.path),
      uuid: bundle.scratch.uuid,
      sizeBytes: bundle.scratch.sizeBytes,
    },
  })}\n`, { mode: 0o400 });
  await fs.chmod(bundle.manifestPath, 0o400);
  return {
    root,
    bundle,
    request: {
      nvxRoot,
      filesystem: bundle,
      entrypoint: '/usr/local/bin/awf-agent',
      args: ['--run'],
      memoryMaxBytes: 512 * 1024 * 1024,
      pidsMax: 256,
      memoryMib: 768,
      timeoutMs: 30_000,
      network: {
        guestAddress: '192.168.127.2/30',
        proxyAddress: '192.168.127.1:3128',
        egressAllow: ['tcp:192.168.127.1:3128'],
        hostLoopbackForwards: ['172.30.0.30:10002'],
      },
    },
  };
}

function outcome(category: 'success' | 'guest-exit' | 'vmm-failure', statusCode: number) {
  return {
    schema_version: 1,
    instance_id: 'a'.repeat(32),
    backend: 'kvm',
    outcome: {
      operation: 'run',
      category,
      status_code: statusCode,
    },
    network_policy: {
      status: 'applied',
      status_code: 0,
      mode: 'rules',
      allow_rule_count: 1,
      deny_rule_count: 0,
      host_loopback: 'allow',
    },
    teardown: Object.fromEntries(NVX_TEARDOWN_STAGES.map((stage) => [stage, true])),
  };
}

describe('NVX one-shot execution adapter', () => {
  it('builds only a one-shot sandbox run command with fixed-deny network defaults', async () => {
    const { root, request } = await fixture();
    try {
      const args = buildNvxOneShotArguments(
        request,
        path.join(request.filesystem.runDirectory, 'outcome.json'),
      );
      expect(args.slice(0, 3)).toEqual(['scripts/nvx.py', 'sandbox', 'run']);
      expect(args).toEqual(expect.arrayContaining([
        '--layer',
        `distro,${request.filesystem.layers[0].path},11111111-2222-5333-8444-555555555555`,
        '--scratch',
        request.filesystem.scratch.path,
        '--network-profile',
        'portable',
        '--network-egress',
        'deny',
        '--network-ingress',
        'deny',
        '--host-loopback',
        'allow',
        '--outcome-report',
        path.join(request.filesystem.runDirectory, 'outcome.json'),
      ]));
      expect(args).not.toEqual(expect.arrayContaining([
        'provision',
        'start',
        'exec',
        'stop',
        'deprovision',
        '--state-dir',
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves guest exit 125, filters streamed output, and keeps bounded raw tails', async () => {
    const { root, request } = await fixture();
    const stdout = new PassThrough();
    const presented: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => presented.push(chunk));
    let hostEnvironment: NodeJS.ProcessEnv | undefined;
    const dependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async (processRequest) => {
        hostEnvironment = processRequest.env;
        await processRequest.onStdout(Buffer.from(':'));
        await processRequest.onStdout(Buffer.from(':notice::unsafe\nsafe\n'));
        await processRequest.onStderr(Buffer.from('stderr-tail'));
        const outcomePath = processRequest.args[processRequest.args.length - 1];
        await fs.writeFile(
          outcomePath,
          `${JSON.stringify(outcome('guest-exit', 125))}\n`,
          { mode: 0o600 },
        );
        await fs.chmod(outcomePath, 0o600);
        return { exitCode: 125, signal: null, timedOut: false, cancelled: false };
      }),
    };
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'must-not-leak';
    try {
      const result = await new NvxOneShotAdapter(dependencies).execute({
        ...request,
        stdout,
        rawTailBytes: 8,
      });

      expect(result).toMatchObject({
        exitCode: 125,
        category: 'guest-exit',
        signal: null,
        timedOut: false,
      });
      expect(Buffer.concat(presented).toString()).toContain(
        '[awf blocked workflow command] : :notice::unsafe',
      );
      expect(result.rawStdoutTail.length).toBe(8);
      expect(result.rawStderrTail.toString()).toBe('err-tail');
      expect(hostEnvironment?.GITHUB_TOKEN).toBeUndefined();
      expect(hostEnvironment).toMatchObject({
        PYTHONUNBUFFERED: '1',
        TMPDIR: request.filesystem.runDirectory,
      });
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns 124 on a host timeout without requiring a completed outcome', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async () => ({
        exitCode: null,
        signal: 'SIGKILL' as NodeJS.Signals,
        timedOut: true,
        cancelled: false,
      })),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .resolves.toMatchObject({
          exitCode: 124,
          category: 'timeout',
          signal: 'SIGKILL',
          timedOut: true,
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing outcomes, wrapper mismatches, and modified images', async () => {
    const missing = await fixture();
    const noOutcomeDependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
      })),
    };
    try {
      await expect(new NvxOneShotAdapter(noOutcomeDependencies).execute(missing.request))
        .rejects.toThrow(/did not produce a structured outcome/);
    } finally {
      await fs.rm(missing.root, { recursive: true, force: true });
    }

    const mismatch = await fixture();
    const mismatchDependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async (processRequest) => {
        const outcomePath = processRequest.args[processRequest.args.length - 1];
        await fs.writeFile(
          outcomePath,
          `${JSON.stringify(outcome('vmm-failure', 1))}\n`,
          { mode: 0o600 },
        );
        await fs.chmod(outcomePath, 0o600);
        return { exitCode: 125, signal: null, timedOut: false, cancelled: false };
      }),
    };
    try {
      await expect(new NvxOneShotAdapter(mismatchDependencies).execute(mismatch.request))
        .rejects.toThrow(/wrapper exit 125 does not match.*vmm-failure:1/);
    } finally {
      await fs.rm(mismatch.root, { recursive: true, force: true });
    }

    const modified = await fixture();
    const runProcess = jest.fn();
    await fs.chmod(modified.bundle.layers[0].path, 0o600);
    await fs.appendFile(modified.bundle.layers[0].path, 'tampered');
    await fs.chmod(modified.bundle.layers[0].path, 0o400);
    try {
      await expect(new NvxOneShotAdapter({
        pythonBinary: '/usr/bin/python3',
        runProcess,
      }).execute(modified.request)).rejects.toThrow(/digest changed/);
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      await fs.rm(modified.root, { recursive: true, force: true });
    }
  });

  it('rejects a successful workload when the structured network policy differs', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async (processRequest) => {
        const report = outcome('success', 0);
        report.network_policy.allow_rule_count = 0;
        const outcomePath = processRequest.args[processRequest.args.length - 1];
        await fs.writeFile(outcomePath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
        await fs.chmod(outcomePath, 0o600);
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      }),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .rejects.toMatchObject({
          category: 'outcome-mismatch',
          message: expect.stringMatching(/network policy does not match/),
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves bounded output evidence when the outcome is missing', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async (processRequest) => {
        await processRequest.onStderr(Buffer.from('diagnostic'));
        return { exitCode: 1, signal: null, timedOut: false, cancelled: false };
      }),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .rejects.toMatchObject({
          category: 'missing-outcome',
          rawStderrTail: Buffer.from('diagnostic'),
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns a distinct cancellation result', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
      pythonBinary: '/usr/bin/python3',
      runProcess: jest.fn(async () => ({
        exitCode: null,
        signal: 'SIGTERM' as NodeJS.Signals,
        timedOut: false,
        cancelled: true,
      })),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .resolves.toMatchObject({
          exitCode: 130,
          category: 'cancelled',
          signal: 'SIGTERM',
          timedOut: false,
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
