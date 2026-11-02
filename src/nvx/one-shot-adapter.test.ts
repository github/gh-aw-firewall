import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { NvxFilesystemBundle } from './filesystem-builder';
import {
  buildNvxOneShotArguments,
  appendMountArguments,
  buildNvxKernelCommandLine,
  nvxShareName,
  validateNvxExecutionRequest,
  NvxOneShotAdapter,
  testHelpers,
  type NvxOneShotAdapterDependencies,
  type NvxOneShotExecutionRequest,
} from './one-shot-adapter';
import { NVX_TEARDOWN_STAGES } from './outcome';
import type { NvxLiveMount } from './live-mount-policy';

const linuxIt = process.platform === 'linux' ? it : it.skip;

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function fixture(): Promise<{
  root: string;
  bundle: NvxFilesystemBundle;
  request: NvxOneShotExecutionRequest;
}> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.awf-nvx-run-'));
  const nvxRoot = path.join(root, 'nvx');
  const runDirectory = path.join(root, 'run');
  await fs.mkdir(path.join(nvxRoot, 'bin'), { recursive: true });
  await fs.mkdir(runDirectory);
  await fs.chmod(runDirectory, 0o700);
  await fs.writeFile(path.join(nvxRoot, 'bin', 'nvx-rs'), 'launcher');
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
      uid: 65534,
      gid: 65534,
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
      uid: bundle.scratch.uid,
      gid: bundle.scratch.gid,
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
  const mount = (guestTarget: string, overrides: Partial<NvxLiveMount> = {}): NvxLiveMount => ({
    tag: 'workspace',
    guestTarget,
    hostPath: `/host${guestTarget}`,
    mode: 'ro',
    deniedPaths: [],
    allowedPaths: [],
    writablePaths: [],
    ...overrides,
  });

  it('lowers multiple direct shares with the upstream target-hashed child names', () => {
    const args: string[] = [];
    appendMountArguments(args, [
      mount('/workspace', {
        mode: 'rw',
        deniedPaths: ['/host/workspace/private'],
        allowedPaths: ['/host/workspace/private/payload'],
        writablePaths: ['/host/workspace/dist'],
      }),
      mount('/toolcache'),
    ]);
    expect(nvxShareName(0, '/workspace')).toBe(
      `0-${createHash('sha256').update('/workspace').digest('hex').slice(0, 32)}`,
    );
    expect(args).toEqual([
      '--mount-aggregate', '/run/nvx/shares',
      '--mount-child', `${nvxShareName(0, '/workspace')},/host/workspace,rw`,
      '--mount-deny', '/host/workspace/private',
      '--mount-allow', '/host/workspace/private/payload',
      '--mount-write', '/host/workspace/dist',
      '--mount-child', `${nvxShareName(1, '/toolcache')},/host/toolcache,ro`,
      '--mount-owner', 'caller',
    ]);
  });

  it('uses an aggregate for a single file but preserves one direct directory', () => {
    const fileArgs: string[] = [];
    appendMountArguments(fileArgs, [mount('/config', { file: true })]);
    expect(fileArgs).toEqual([
      '--mount-aggregate', '/run/nvx/shares',
      '--mount-child', `${nvxShareName(0, '/config')},/host/config,ro,file`,
      '--mount-owner', 'caller',
    ]);
    const directoryArgs: string[] = [];
    appendMountArguments(directoryArgs, [mount('/workspace')]);
    expect(directoryArgs).toEqual([
      '--mount', '/workspace,/host/workspace,ro', '--mount-owner', 'caller',
    ]);
  });

  it('budgets share mappings and OpenVMM bootstrap tokens including the terminating NUL', async () => {
    const { root, request } = await fixture();
    try {
      const mounts = [mount('/config', { file: true })];
      const base = { ...request, mounts, args: [] };
      const commandLine = buildNvxKernelCommandLine(base);
      expect(commandLine).toContain(
        `nvx_share=${nvxShareName(0, '/config')},/config,ro,file`,
      );
      const fragment = ' virtfs_dir=/run/nvx/shares virtfs_tag=microvm virtfs_mode=ro virtfs_aggregate=1';
      const available = 1024 - Buffer.byteLength(commandLine + fragment) - 1 - ' nvx_arg='.length;
      expect(() => buildNvxKernelCommandLine({ ...base, args: ['x'.repeat(available)] })).not.toThrow();
      expect(() => buildNvxKernelCommandLine({ ...base, args: ['x'.repeat(available + 1)] }))
        .toThrow(/1024-byte/);
      const single = { ...request, mounts: [mount('/workspace')], args: [] };
      const singleBase = buildNvxKernelCommandLine(single);
      const singleFragment = ' virtfs_dir=/workspace virtfs_tag=microvm virtfs_mode=ro';
      const singleAvailable = 1024 - Buffer.byteLength(singleBase + singleFragment) - 1 - ' nvx_arg='.length;
      expect(() => buildNvxKernelCommandLine({ ...single, args: ['x'.repeat(singleAvailable + 1)] }))
        .toThrow(/1024-byte/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects kernel token separators, unsafe identities, and overflowing resource limits on the host', async () => {
    const { root, request } = await fixture();
    try {
      for (const token of ['', 'a b', 'a\tb', 'a\nb', 'a"b', 'a\u007fb', 'à']) {
        expect(() => validateNvxExecutionRequest({ ...request, args: [token] }))
          .toThrow(/argument/);
      }
      for (const entrypoint of ['/bin/a b', '/bin/a"b', '/bin/à']) {
        expect(() => validateNvxExecutionRequest({ ...request, entrypoint })).toThrow(/entrypoint/);
      }
      for (const id of [0xffffffff, 0x100000000]) {
        expect(() => validateNvxExecutionRequest({ ...request, workloadUid: id })).toThrow(/UID/);
        expect(() => validateNvxExecutionRequest({ ...request, workloadGid: id })).toThrow(/GID/);
      }
      expect(() => validateNvxExecutionRequest({ ...request, pidsMax: 4194304 })).toThrow(/process limit/);
      expect(() => validateNvxExecutionRequest({ ...request, memoryMib: 17592186044416 }))
        .toThrow(/guest memory/);
      expect(() => validateNvxExecutionRequest({ ...request, memoryMaxBytes: Number.MAX_SAFE_INTEGER + 1 }))
        .toThrow(/memory limit/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for read-only mappings inside writable shares and invalid policy paths', async () => {
    const { root, request } = await fixture();
    try {
      expect(() => validateNvxExecutionRequest({
        ...request,
        mounts: [
          mount('/workspace', { mode: 'rw' }),
          mount('/readonly', { hostPath: '/host/workspace/private' }),
        ],
      })).toThrow(/overlap/);
      expect(() => validateNvxExecutionRequest({
        ...request,
        mounts: [mount('/workspace', { deniedPaths: ['relative'] })],
      })).toThrow(/absolute path/);
      expect(() => validateNvxExecutionRequest({
        ...request,
        mounts: [mount('/workspace', { deniedPaths: ['/other/path'] })],
      })).toThrow(/inside its share/);
      expect(() => validateNvxExecutionRequest({
        ...request,
        mounts: [mount('/config', { file: true, deniedPaths: ['/host/config'] })],
      })).toThrow(/file mount/);
      for (const target of ['/proc/self', '/run/nvx/time', '/workspace/../root', '/workspace=x', '/workspace//x']) {
        expect(() => validateNvxExecutionRequest({
          ...request,
          mounts: [mount(target)],
        })).toThrow();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('builds only a one-shot sandbox run command with fixed-deny network defaults', async () => {
    const { root, request } = await fixture();
    try {
      const args = buildNvxOneShotArguments(
        request,
        path.join(request.filesystem.runDirectory, 'outcome.json'),
      );
      expect(args.slice(0, 2)).toEqual(['sandbox', 'run']);
      expect(args).not.toContain('--cpu-profile');
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

  it('does not pass the obsolete CPU profile option to NVX', async () => {
    const { root, request } = await fixture();
    try {
      const args = buildNvxOneShotArguments(
        request,
        path.join(request.filesystem.runDirectory, 'outcome.json'),
      );
      expect(args).not.toContain('--cpu-profile');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects filesystem bundles with more than one distro image', async () => {
    const { root, request } = await fixture();
    const customPath = path.join(request.filesystem.runDirectory, 'custom.erofs');
    await fs.writeFile(customPath, 'custom');
    await fs.chmod(customPath, 0o400);
    try {
      const custom = {
        ...request.filesystem.layers[0],
        role: 'custom' as const,
        path: customPath,
        uuid: '22222222-3333-5444-8555-666666666666',
        sha256: await sha256(customPath),
      };
      expect(() => buildNvxOneShotArguments({
        ...request,
        filesystem: {
          ...request.filesystem,
          layers: [custom, request.filesystem.layers[0]],
        },
      }, path.join(request.filesystem.runDirectory, 'outcome.json'))).toThrow(/exactly one distro/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('attributes each live-share policy immediately after its mount', async () => {
    const { root, request } = await fixture();
    try {
      const args = buildNvxOneShotArguments({
        ...request,
        mounts: [
          {
            tag: 'workspace',
            guestTarget: '/workspace',
            hostPath: '/home/runner/work/repo',
            mode: 'rw',
            deniedPaths: ['/home/runner/work/repo/private'],
            allowedPaths: ['/home/runner/work/repo/private/payloads'],
            writablePaths: ['/home/runner/work/repo/dist'],
          },
          {
            tag: 'runner-tool-cache',
            guestTarget: '/opt/hostedtoolcache',
            hostPath: '/opt/hostedtoolcache',
            mode: 'ro',
            deniedPaths: [],
            allowedPaths: [],
            writablePaths: [],
          },
        ],
      }, path.join(request.filesystem.runDirectory, 'outcome.json'));
      const first = args.indexOf('--mount');
      expect(args.slice(first, first + 8)).toEqual([
        '--mount', '/workspace,/home/runner/work/repo,rw',
        '--mount-deny', '/home/runner/work/repo/private',
        '--mount-allow', '/home/runner/work/repo/private/payloads',
        '--mount-write', '/home/runner/work/repo/dist',
      ]);
      expect(args.slice(first + 8, first + 12)).toEqual([
        '--mount', '/opt/hostedtoolcache,/opt/hostedtoolcache,ro',
        '--mount-owner', 'caller',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves guest exit 125, filters streamed output, and keeps bounded raw tails', async () => {
    const { root, request } = await fixture();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const presented: Buffer[] = [];
    const presentedErrors: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => presented.push(chunk));
    stderr.on('data', (chunk: Buffer) => presentedErrors.push(chunk));
    let hostEnvironment: NodeJS.ProcessEnv | undefined;
    const dependencies: NvxOneShotAdapterDependencies = {
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
        stderr,
        rawTailBytes: 8,
      });

      expect(dependencies.runProcess).toHaveBeenCalledWith(expect.objectContaining({
        command: path.join(request.nvxRoot, 'bin', 'nvx-rs'),
        args: expect.arrayContaining(['sandbox', 'run']),
      }));
      expect(result).toMatchObject({
        exitCode: 125,
        category: 'guest-exit',
        signal: null,
        timedOut: false,
      });
      expect(Buffer.concat(presented).toString()).toContain(
        '[awf blocked workflow command] : :notice::unsafe',
      );
      expect(Buffer.concat(presentedErrors).toString()).toBe('stderr-tail');
      expect(result.rawStdoutTail.length).toBe(8);
      expect(result.rawStderrTail.toString()).toBe('err-tail');
      expect(hostEnvironment?.GITHUB_TOKEN).toBeUndefined();
      expect(hostEnvironment).toMatchObject({
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

  it('reports an unexpected process signal without trusting a partial outcome', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
      runProcess: jest.fn(async () => ({
        exitCode: null,
        signal: 'SIGABRT' as NodeJS.Signals,
        timedOut: false,
        cancelled: false,
      })),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .resolves.toMatchObject({
          exitCode: 134,
          category: 'signal',
          signal: 'SIGABRT',
          timedOut: false,
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('requires the workload identity to own the scratch filesystem', async () => {
    const { root, request } = await fixture();
    const runProcess = jest.fn();
    try {
      await expect(new NvxOneShotAdapter({
        runProcess,
      }).execute({
        ...request,
        workloadUid: 1000,
        workloadGid: 1000,
      })).rejects.toThrow(/scratch owner 65534:65534 must match workload identity 1000:1000/);
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects guest root before launching NVX', async () => {
    const { root, request } = await fixture();
    const runProcess = jest.fn();
    try {
      await expect(new NvxOneShotAdapter({
        runProcess,
      }).execute({
        ...request,
        workloadUid: 0,
        workloadGid: 0,
      })).rejects.toThrow(/workload UID must be a positive integer/);
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects the unchanged-identity sentinel before launching NVX', async () => {
    const { root, request } = await fixture();
    const runProcess = jest.fn();
    try {
      await expect(new NvxOneShotAdapter({
        runProcess,
      }).execute({
        ...request,
        workloadUid: 0xffffffff,
      })).rejects.toThrow(/at most 4294967294/);
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing outcomes, wrapper mismatches, and modified images', async () => {
    const missing = await fixture();
    const noOutcomeDependencies: NvxOneShotAdapterDependencies = {
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

  it('rejects a symbolic-link outcome report', async () => {
    const { root, request } = await fixture();
    const externalOutcome = path.join(root, 'external-outcome.json');
    await fs.writeFile(
      externalOutcome,
      `${JSON.stringify(outcome('success', 0))}\n`,
      { mode: 0o600 },
    );
    const dependencies: NvxOneShotAdapterDependencies = {
      runProcess: jest.fn(async (processRequest) => {
        const outcomePath = processRequest.args[processRequest.args.length - 1];
        await fs.symlink(externalOutcome, outcomePath);
        return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
      }),
    };
    try {
      await expect(new NvxOneShotAdapter(dependencies).execute(request))
        .rejects.toMatchObject({
          category: 'invalid-outcome',
          message: expect.stringMatching(/must be a regular file/),
        });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns a distinct cancellation result', async () => {
    const { root, request } = await fixture();
    const dependencies: NvxOneShotAdapterDependencies = {
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

  it('streams a successful child process through the default process runner', async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const result = await testHelpers.runNvxProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
      cwd: process.cwd(),
      env: process.env,
      onStdout: async (chunk) => {
        stdout.push(chunk);
      },
      onStderr: async (chunk) => {
        stderr.push(chunk);
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    expect(Buffer.concat(stdout).toString()).toBe('out');
    expect(Buffer.concat(stderr).toString()).toBe('err');
  });

  linuxIt('escalates process-group termination after the launcher exits', async () => {
    const childPidPath = path.join(
      await fs.mkdtemp(path.join(process.cwd(), '.awf-nvx-process-')),
      'child.pid',
    );
    const childScript = [
      "const fs = require('fs');",
      "process.on('SIGTERM', () => {});",
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
      'setInterval(() => {}, 1_000);',
    ].join('');
    const launcherScript = [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1_000);',
    ].join('');
    try {
      const started = Date.now();
      const controller = new AbortController();
      const run = testHelpers.runNvxProcess({
        command: process.execPath,
        args: ['-e', launcherScript],
        cwd: process.cwd(),
        env: process.env,
        abortSignal: controller.signal,
        onStdout: async () => {},
        onStderr: async () => {},
      });
      const childPid = Number(await waitForFile(childPidPath));
      controller.abort();
      const result = await run;
      expect(result.cancelled).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      expect(await processHasExited(childPid)).toBe(true);
    } finally {
      await fs.rm(path.dirname(childPidPath), { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function processHasExited(pid: number): Promise<boolean> {
  if (process.platform !== 'linux') {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
