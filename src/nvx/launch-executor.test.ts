import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  DirectOpenvmmLaunchExecutor,
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
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
      artifactSnapshotDirectory: `/run/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      cleanupRecordPath: `/run/awf-nvx/cleanup/${RUN_ID}.json`,
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
    },
    outcomePath: `/run/awf-nvx/runs/${RUN_ID}/outcome.json`,
  };
}

function request(overrides: Partial<NvxOneShotExecutionRequest> = {}):
NvxOneShotExecutionRequest {
  return {
    nvxRoot: `/run/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
    filesystem: {} as never,
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
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', null, 'SIGKILL');
    }
  });
  const dependencies: NvxLaunchExecutorDependencies = {
    spawn: jest.fn(() => child as never),
    readFile: jest.fn(async (filePath) => {
      if (filePath === `${CGROUP}/cgroup.procs`) return '4100\n4200\n';
      throw new Error(`unexpected read: ${filePath}`);
    }),
    writeFile: jest.fn(async () => undefined),
    readlink: jest.fn(async (filePath) => {
      if (filePath === '/proc/4200/exe') {
        order.push(`gate-closed:${child.stdio[3].writableEnded}`);
        return `/run/awf-nvx/trusted-artifacts/run-${RUN_ID}/openvmm`;
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
        filePath === `/run/awf-nvx/trusted-artifacts/run-${RUN_ID}/openvmm`
      ) {
        return { dev: 10n, ino: 20n };
      }
      return { dev: 30n, ino: BigInt(filePath.length) };
    }),
    kill,
    sleep: jest.fn(async () => undefined),
    prepareExecution: jest.fn(async () => ({
      onStdout: jest.fn(async () => undefined),
      onStderr: jest.fn(async () => undefined),
      finish,
    })),
  };
  const hooks = {
    launcherStarted: jest.fn(async (pid: number) => { order.push(`launcher:${pid}`); }),
    sandboxStarted: jest.fn(async (pid: number) => { order.push(`sandbox:${pid}`); }),
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
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', 0, null);
    }
  });
  process.nextTick(() => {
    if (options.status !== undefined) {
      child.stdio[4].end(options.status);
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
      'gate-closed:true',
      'ready:4200',
      'stdin:ctrl-q',
      'stdin:resume\n',
    ]);
    expect(value.hooks.openvmmReady).toHaveBeenCalledWith(4200, '4026533001');
    expect(value.child.stdio[5].writableEnded).toBe(true);
    expect(value.child.stdio[5].readableLength).toBeGreaterThan(0);
    expect(value.dependencies.stat).toHaveBeenCalledWith('/proc/4100/exe');
    expect(value.dependencies.stat).toHaveBeenCalledWith('/proc/4200/exe');
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
