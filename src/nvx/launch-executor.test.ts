import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { constants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildNvxConstrainedLaunchCommand } from './confinement';
import {
  DirectOpenvmmLaunchExecutor,
  testHelpers,
  type NvxLaunchExecutorDependencies,
} from './launch-executor';
import type { NvxPhase3dLaunchPlan } from './runtime-lifecycle';
import type { NvxOneShotExecutionRequest } from './one-shot-adapter';

const RUN_ID = 'a'.repeat(32);
const CGROUP = `/sys/fs/cgroup/awf-nvx/${RUN_ID}`;

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: [
      PassThrough,
      PassThrough,
      PassThrough,
      PassThrough,
      PassThrough,
      PassThrough,
    ];
  };
  child.pid = 4100;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [
    child.stdin,
    child.stdout,
    child.stderr,
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
  ];
  return child;
}

function plan(): NvxPhase3dLaunchPlan {
  return {
    layout: {
      runId: RUN_ID,
      runDirectory: `/var/lib/awf-nvx/runs/${RUN_ID}`,
      artifactSnapshotDirectory: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      cleanupRecordPath: `/var/lib/awf-nvx/cleanup/${RUN_ID}.json`,
      cgroupPath: CGROUP,
      networkNamespace: `awfnvx-${RUN_ID}`,
    },
    identity: { name: 'awfnvx-test', uid: 2001, gid: 2002 },
    cgroupLimits: { memoryMax: '805306368', cpuMax: '200000 100000', pidsMax: '256' },
    networkPlan: {} as never,
    networkRuleset: '',
    launchCommand: {
      command: '/usr/sbin/ip',
      args: ['netns', 'exec', `awfnvx-${RUN_ID}`, '/usr/bin/bwrap'],
      confinementPolicy: {} as never,
      allowCallerMount: false,
    },
    outcomePath: `/var/lib/awf-nvx/runs/${RUN_ID}/outcome.json`,
  };
}

function request(overrides: Partial<NvxOneShotExecutionRequest> = {}):
NvxOneShotExecutionRequest {
  return {
    nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
    filesystem: {
      layers: [{
        role: 'distro',
        path: '/images/distro.erofs',
        sha256: createHash('sha256').update('distro').digest('hex'),
      }],
      scratch: { path: '/images/scratch.ext4', sizeBytes: 7 },
    } as never,
    entrypoint: '/bin/true',
    network: {
      guestAddress: '100.64.0.2/30',
      proxyAddress: '172.30.0.10:3128',
    },
    ...overrides,
  };
}

function harness(options: {
  status?: string;
  readyError?: Error;
  timeoutMs?: number;
  exitAfterStatus?: boolean;
} = {}) {
  const order: string[] = [];
  const child = createChild();
  const finish = jest.fn(async (result) => ({
    exitCode: result.timedOut ? 124 : result.cancelled ? 130 : 0,
    category: result.timedOut
      ? 'timeout' as const
      : result.cancelled
        ? 'cancelled' as const
        : 'success' as const,
    signal: result.signal,
    timedOut: result.timedOut,
    rawStdoutTail: Buffer.alloc(0),
    rawStderrTail: Buffer.alloc(0),
  }));
  const kill = jest.fn((pid: number, signal: NodeJS.Signals) => {
    order.push(`kill:${pid}:${signal}`);
    if (signal === 'SIGKILL') {
      child.stdio[4].end();
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', null, 'SIGKILL');
    }
  });
  const dependencies: NvxLaunchExecutorDependencies = {
    spawn: jest.fn(() => child as never),
    open: jest.fn(async (filePath) => ({
      fd: filePath.endsWith('distro.erofs') ? 60 : 70,
      stat: jest.fn(async () => ({
        isFile: () => true,
        mode: filePath.endsWith('distro.erofs') ? 0o400 : 0o600,
        size: filePath.endsWith('distro.erofs') ? 6 : 7,
        mtimeMs: 1,
        ctimeMs: 1,
      })),
      read: jest.fn(async (buffer: Buffer) => {
        buffer.write('distro');
        return { bytesRead: 6, buffer };
      }),
      close: jest.fn(async () => undefined),
    }) as unknown as FileHandle),
    readFile: jest.fn(async (filePath) => {
      if (filePath === `${CGROUP}/cgroup.procs`) return '4100\n4200\n';
      throw new Error(`unexpected read: ${filePath}`);
    }),
    writeFile: jest.fn(async () => undefined),
    readlink: jest.fn(async (filePath) => {
      if (filePath === '/proc/4200/exe') {
        order.push(`gate-closed:${child.stdio[3].writableEnded}`);
        return `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}/openvmm`;
      }
      if (filePath === '/proc/4200/ns/mnt') return 'mnt:[4026533001]';
      throw Object.assign(new Error(`missing: ${filePath}`), { code: 'ENOENT' });
    }),
    stat: jest.fn(async (filePath) => {
      if (filePath === '/proc/4200/exe') {
        order.push(`gate-closed:${child.stdio[3].writableEnded}`);
        return { dev: 10n, ino: 20n };
      }
      if (
        filePath === `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}/openvmm`
      ) {
        return { dev: 10n, ino: 20n };
      }
      return { dev: 30n, ino: BigInt(filePath.length) };
    }),
    kill,
    sleep: jest.fn(async () => undefined),
    prepareExecution: jest.fn(async () => ({
      receiver: 'prepared',
      onStdout: jest.fn(async function(
        this: { receiver: string },
      ) {
        if (this.receiver !== 'prepared') {
          throw new Error('stdout callback lost its prepared execution receiver');
        }
      }),
      onStderr: jest.fn(async () => undefined),
      finish,
    } as never)),
  };
  const hooks = {
    launcherStarted: jest.fn(async (pid: number) => { order.push(`launcher:${pid}`); }),
    sandboxStarted: jest.fn(async (pid: number) => {
      order.push(`sandbox:${pid}`);
      order.push(`status-open:${!child.stdio[4].destroyed}`);
    }),
    openvmmReady: jest.fn(async (pid: number) => {
      order.push(`ready:${pid}`);
      if (options.readyError) throw options.readyError;
    }),
  };
  child.stdin.on('data', (chunk) => {
    if (chunk.equals(Buffer.from([0x11]))) {
      order.push('stdin:ctrl-q');
      child.stdout.write('open');
      child.stdout.write('vmm> ');
      return;
    }
    order.push(`stdin:${chunk.toString()}`);
    if (chunk.toString() === 'resume\n') {
      child.stdio[4].end('{"exit-code":0}\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', 0, null);
    }
  });
  process.nextTick(() => {
    if (options.status !== undefined) {
      if (options.status === '{"child-pid":4200}\n') {
        child.stdio[4].write(options.status);
        if (options.exitAfterStatus) {
          setImmediate(() => {
            child.stdout.end();
            child.stderr.end();
            child.stdio[4].end();
            child.emit('exit', 1, null);
          });
        }
      } else {
        child.stdio[4].end(options.status);
      }
    }
  });
  return {
    child,
    dependencies,
    hooks,
    finish,
    order,
    executor: new DirectOpenvmmLaunchExecutor(dependencies),
    executionRequest: request(
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ),
  };
}

describe('direct OpenVMM launch executor', () => {
  it('closes parent image handles immediately after spawn and on synchronous spawn failure', async () => {
    for (const fail of [false, true]) {
      const value = harness({ status: fail ? undefined : '{"child-pid":4200}\n' });
      const handles: FileHandle[] = [];
      const originalOpen = value.dependencies.open;
      value.dependencies.open = jest.fn(async (...args) => {
        const handle = await originalOpen(...args);
        handles.push(handle);
        return handle;
      });
      const spawn = value.dependencies.spawn;
      value.dependencies.spawn = jest.fn((...args) => {
        expect(handles).toHaveLength(2);
        handles.forEach((handle) => expect(handle.close).not.toHaveBeenCalled());
        if (fail) throw new Error('spawn failed');
        return spawn(...args);
      });
      value.hooks.launcherStarted.mockImplementation(async () => {
        handles.forEach((handle) => expect(handle.close).toHaveBeenCalledTimes(1));
      });
      const execution = value.executor.execute({
        plan: plan(), request: value.executionRequest, hooks: value.hooks,
      });
      if (fail) await expect(execution).rejects.toThrow('spawn failed');
      else await expect(execution).resolves.toMatchObject({ category: 'success' });
      handles.forEach((handle) => expect(handle.close).toHaveBeenCalledTimes(1));
    }
  });

  it('closes both images and terminates if the launcher omits a required gate', async () => {
    const value = harness();
    value.child.stdio[3] = null as never;
    await expect(value.executor.execute({
      plan: plan(), request: value.executionRequest, hooks: value.hooks,
    })).rejects.toThrow(/required process file descriptors/);
    const results = (value.dependencies.open as jest.Mock).mock.results;
    for (const result of results) {
      expect((await result.value).close).toHaveBeenCalledTimes(1);
    }
    expect(value.dependencies.kill).toHaveBeenCalledWith(-4100, 'SIGKILL');
  });

  it('rejects the x32 syscall ABI before applying the native denylist', () => {
    const filter = testHelpers.buildOpenvmmSeccompFilter();
    const instructions = Array.from(
      { length: filter.length / 8 },
      (_, index) => {
        const offset = index * 8;
        return [
          filter.readUInt16LE(offset),
          filter.readUInt8(offset + 2),
          filter.readUInt8(offset + 3),
          filter.readUInt32LE(offset + 4),
        ];
      },
    );
    expect(instructions).toContainEqual([0x45, 0, 1, testHelpers.x32SyscallBit]);
    const x32Guard = instructions.findIndex(
      (instruction) => instruction[0] === 0x45 &&
        instruction[3] === testHelpers.x32SyscallBit,
    );
    expect(instructions[x32Guard + 1]).toEqual([0x06, 0, 0, 0x00050001]);
  });

  describe('checked image descriptor handoff', () => {
    let directory: string;
    let executionRequest: NvxOneShotExecutionRequest;
    const handles: FileHandle[] = [];
    const dependencies = {
      open: jest.fn(async (filePath: string, flags: number) => {
        const handle = await fs.open(filePath, flags);
        handles.push(handle);
        return handle;
      }),
    };

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(process.cwd(), '.nvx-checked-images-'));
      const distro = path.join(directory, 'distro.erofs');
      const scratch = path.join(directory, 'scratch.ext4');
      await fs.writeFile(distro, 'distro', { mode: 0o400 });
      await fs.writeFile(scratch, 'scratch', { mode: 0o600 });
      executionRequest = request({
        filesystem: {
          ...request().filesystem,
          layers: [{ ...request().filesystem.layers[0], path: distro }],
          scratch: { ...request().filesystem.scratch, path: scratch },
        },
      });
      handles.length = 0;
      dependencies.open.mockClear();
    });

    afterEach(async () => {
      await Promise.all(handles.map((handle) => handle.close()));
      await fs.rm(directory, { recursive: true, force: true });
    });

    it.each(['distro', 'scratch'])('rejects a replaced %s symlink and closes earlier handles', async (image) => {
      const imagePath = image === 'distro'
        ? executionRequest.filesystem.layers[0].path
        : executionRequest.filesystem.scratch.path;
      await fs.rename(imagePath, `${imagePath}.original`);
      await fs.symlink(`${imagePath}.original`, imagePath);
      await expect(testHelpers.openCheckedImages(executionRequest, dependencies))
        .rejects.toMatchObject({ code: 'ELOOP' });
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    });

    it('rejects a replaced distro digest and closes its descriptor', async () => {
      const distro = executionRequest.filesystem.layers[0].path;
      await fs.unlink(distro);
      await fs.writeFile(distro, 'altered', { mode: 0o400 });
      await expect(testHelpers.openCheckedImages(executionRequest, dependencies))
        .rejects.toThrow(/digest changed/);
      expect(handles[0].fd).toBe(-1);
    });

    it('closes the distro if opening scratch fails', async () => {
      await fs.unlink(executionRequest.filesystem.scratch.path);
      await expect(testHelpers.openCheckedImages(executionRequest, dependencies))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(handles).toHaveLength(1);
      expect(handles[0].fd).toBe(-1);
    });

    it.each(['distro-mode', 'scratch-mode', 'scratch-size', 'distro-directory'])(
      'rejects invalid descriptor metadata: %s', async (variation) => {
        const distro = executionRequest.filesystem.layers[0].path;
        const scratch = executionRequest.filesystem.scratch.path;
        if (variation === 'distro-mode') await fs.chmod(distro, 0o600);
        if (variation === 'scratch-mode') await fs.chmod(scratch, 0o644);
        if (variation === 'scratch-size') await fs.truncate(scratch, 1);
        if (variation === 'distro-directory') {
          await fs.unlink(distro);
          await fs.mkdir(distro, { mode: 0o400 });
        }
        await expect(testHelpers.openCheckedImages(executionRequest, dependencies))
          .rejects.toThrow(/checked .*image must/);
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      },
    );

    it('hashes and inherits the same inode despite path replacement, with read-only distro and read-write scratch', async () => {
      const distroPath = executionRequest.filesystem.layers[0].path;
      const open = dependencies.open;
      const images = await testHelpers.openCheckedImages(executionRequest, {
        open: async (...args) => {
          const handle = await open(...args);
          if (args[0] === distroPath) {
            await fs.rename(distroPath, `${distroPath}.checked`);
            await fs.writeFile(distroPath, 'attacker', { mode: 0o400 });
          }
          return handle;
        },
      });
      const child = spawnSync(process.execPath, ['-e', `
        const fs = require('fs');
        const distro = fs.readFileSync('/proc/self/fd/6', 'utf8');
        let readOnly = false;
        try { fs.writeSync(6, 'x'); } catch (error) { readOnly = error.code === 'EBADF'; }
        fs.writeSync(7, 'updated');
        process.stdout.write(JSON.stringify({ distro, readOnly }));
      `], {
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', images[0].fd, images[1].fd],
      });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ distro: 'distro', readOnly: true });
      expect(await fs.readFile(executionRequest.filesystem.scratch.path, 'utf8')).toBe('updated');
      expect(dependencies.open).toHaveBeenNthCalledWith(
        1, distroPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      expect(dependencies.open).toHaveBeenNthCalledWith(
        2, executionRequest.filesystem.scratch.path,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    });

    it('preserves checked images through the actual Python seccomp exec trampoline', async () => {
      const images = await testHelpers.openCheckedImages(executionRequest, dependencies);
      const command = buildNvxConstrainedLaunchCommand({
        tools: { ip: '/usr/sbin/ip', bwrap: '/usr/bin/bwrap', setpriv: '/usr/bin/setpriv' },
        namespaceName: 'awfnvx-test',
        identity: { uid: 2001, gid: 2002 },
        nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
        runDirectory: `/var/lib/awf-nvx/runs/${RUN_ID}`,
        systemReadOnlyPaths: ['/usr'],
        openvmmArguments: [],
      });
      const trampoline = command.args.find((argument) => argument.startsWith('import ctypes'));
      expect(trampoline).toBeDefined();
      const filterPath = path.join(directory, 'seccomp.bpf');
      await fs.writeFile(filterPath, testHelpers.buildOpenvmmSeccompFilter());
      const child = spawnSync('/usr/bin/python3', [
        '-c',
        `import ctypes; ctypes.CDLL(None).prctl(38,1,0,0,0); ${trampoline}`,
        filterPath,
        '/usr/bin/python3',
        '-c',
        'import os; assert open("/proc/self/fd/6", "rb").read() == b"distro"; ' +
        'os.write(7, b"updated"); print("checked images inherited")',
      ], {
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', images[0].fd, images[1].fd],
      });
      expect(child.stderr.toString()).toBe('');
      expect(child.status).toBe(0);
      expect(child.stdout.toString()).toBe('checked images inherited\n');
      expect(await fs.readFile(executionRequest.filesystem.scratch.path, 'utf8')).toBe('updated');
    });
  });

  it('denies filesystem credential switching unless a caller-owned share is mounted', () => {
    expect(testHelpers.deniedX86_64Syscalls).toEqual(expect.arrayContaining([
      105, 106, 113, 114, 116, 117, 119,
    ]));
    expect(testHelpers.deniedX86_64Syscalls).not.toContain(122);
    expect(testHelpers.deniedX86_64Syscalls).not.toContain(123);
    expect(testHelpers.deniedWithoutCallerMount).toEqual(
      expect.arrayContaining([122, 123]),
    );
    expect(testHelpers.buildOpenvmmSeccompFilter()).not.toEqual(
      testHelpers.buildOpenvmmSeccompFilter(true),
    );
  });

  it('gates Bubblewrap, verifies OpenVMM, and resumes only after readiness', async () => {
    const value = harness({ status: '{"child-pid":4200}\n' });
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).resolves.toMatchObject({ category: 'success' });

    expect(value.order).toEqual([
      'launcher:4100',
      'sandbox:4200',
      'status-open:true',
      'gate-closed:true',
      'ready:4200',
      'stdin:ctrl-q',
      'stdin:resume\n',
    ]);
    expect(value.hooks.openvmmReady).toHaveBeenCalledWith(4200, '4026533001');
    expect(value.child.stdio[4].destroyed).toBe(true);
    expect(value.child.stdio[5].writableEnded).toBe(true);
    expect(value.child.stdio[5].readableLength).toBeGreaterThan(0);
    expect(value.dependencies.stat).toHaveBeenCalledWith('/proc/4100/exe');
    expect(value.dependencies.stat).toHaveBeenCalledWith('/proc/4200/exe');
    expect(value.dependencies.spawn).toHaveBeenCalledWith(
      '/usr/sbin/ip',
      expect.any(Array),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 60, 70],
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          OPENVMM_LOG: 'off',
          TERM: 'dumb',
        },
      }),
    );
    expect(value.finish).toHaveBeenCalledWith({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
  });

  it('never resumes when confinement verification fails', async () => {
    const value = harness({
      status: '{"child-pid":4200}\n',
      readyError: new Error('confinement mismatch'),
    });
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).rejects.toThrow('confinement mismatch');
    expect(value.order).not.toContain('stdin:resume\n');
    expect(value.order).not.toContain('stdin:ctrl-q');
    expect(value.dependencies.kill).toHaveBeenCalledWith(-4100, 'SIGKILL');
  });

  it.each([
    ['missing', ''],
    ['malformed', '{not-json}\n'],
  ])('fails closed for %s Bubblewrap status', async (_label, status) => {
    const value = harness({ status });
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).rejects.toThrow(/Bubblewrap/);
    expect(value.hooks.sandboxStarted).not.toHaveBeenCalled();
    expect(value.order).not.toContain('stdin:resume\n');
  });

  it('reports an early launcher exit instead of timing out OpenVMM discovery', async () => {
    const value = harness({
      status: '{"child-pid":4200}\n',
      exitAfterStatus: true,
    });
    value.dependencies.stat = jest.fn(async (filePath) => {
      if (filePath.endsWith('/openvmm')) return { dev: 10n, ino: 20n };
      throw Object.assign(new Error(`missing: ${filePath}`), { code: 'ENOENT' });
    });
    value.dependencies.sleep = jest.fn(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).rejects.toThrow(
      'NVX launcher exited before AWF discovered the OpenVMM process: code=1 signal=null',
    );
  });

  it('terminates the process group and cgroup on timeout before readiness', async () => {
    const value = harness({ timeoutMs: 1 });
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).resolves.toMatchObject({
      exitCode: 124,
      category: 'timeout',
      timedOut: true,
    });
    expect(value.dependencies.kill).toHaveBeenCalledWith(4200, 'SIGTERM');
    expect(value.dependencies.kill).toHaveBeenCalledWith(-4100, 'SIGKILL');
    expect(value.dependencies.writeFile).toHaveBeenCalledWith(`${CGROUP}/cgroup.kill`, '1');
    expect(value.order).not.toContain('stdin:resume\n');
  });

  it('terminates the process group and cgroup on cancellation before readiness', async () => {
    const controller = new AbortController();
    const value = harness();
    const execution = value.executor.execute({
      plan: plan(),
      request: { ...value.executionRequest, abortSignal: controller.signal },
      hooks: value.hooks,
    });
    controller.abort();
    await expect(execution).resolves.toMatchObject({
      exitCode: 130,
      category: 'cancelled',
      timedOut: false,
    });
    expect(value.dependencies.kill).toHaveBeenCalledWith(4200, 'SIGTERM');
    expect(value.dependencies.kill).toHaveBeenCalledWith(-4100, 'SIGKILL');
    expect(value.dependencies.writeFile).toHaveBeenCalledWith(`${CGROUP}/cgroup.kill`, '1');
    expect(value.order).not.toContain('stdin:resume\n');
  });

  it('fails closed when OpenVMM never acknowledges the REPL transition', async () => {
    const value = harness({ status: '{"child-pid":4200}\n' });
    value.child.stdin.removeAllListeners('data');
    value.child.stdin.on('data', (chunk) => {
      if (chunk.equals(Buffer.from([0x11]))) {
        value.order.push('stdin:ctrl-q');
        value.child.stdout.end();
      }
    });
    await expect(value.executor.execute({
      plan: plan(),
      request: value.executionRequest,
      hooks: value.hooks,
    })).rejects.toThrow(/REPL prompt/);
    expect(value.order).not.toContain('stdin:resume\n');
    expect(value.dependencies.kill).toHaveBeenCalledWith(-4100, 'SIGKILL');
  });
});
