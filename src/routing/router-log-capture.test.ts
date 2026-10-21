import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { spawnSync } from 'child_process';
import {
  MAX_ROUTER_LOG_BYTES, ROUTER_LOG_FILE, resolveRouterLogsDir, stopRouterAndSaveLogs,
} from './router-log-capture';
import { mockExecaFn } from '../test-helpers/mock-execa.test-utils';
import { logger } from '../logger';
import type { WrapperConfig } from '../types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);
// The capture opens its files through /proc, as AWF's other artifact writers do.
const linuxIt = process.platform === 'linux' ? it : it.skip;
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

const ROUTER_ID = 'a'.repeat(64);
const RECORDS = [
  '{"time":"2026-10-21T18:00:00.000Z","level":"INFO","msg":"starting","service":"gh-aw-router"}',
  '{"time":"2026-10-21T18:00:01.000Z","level":"INFO","msg":"stopped","service":"gh-aw-router","drained":true}',
  '',
].join('\n');
const LOOKUP = ['compose', 'ps', '--all', '--quiet', 'router'];
const STOP = ['stop', '-t', '1', ROUTER_ID];
const LOGS = ['logs', ROUTER_ID];
const OK = { stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false };

interface Result {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  failed?: boolean;
  timedOut?: boolean;
}
type Step = Result | (() => Result);

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

/**
 * A `docker logs` child process: writes `chunks` to its stderr pipe, one per turn
 * of the event loop, until it is killed, then resolves with `result`.
 */
function logsChild(chunks: Array<string | Buffer>, result: Result, afterChunk?: () => void) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const kill = jest.fn(() => { killed = true; return true; });
  const promise = (async () => {
    await nextTurn();
    for (const chunk of chunks) {
      if (killed) break;
      stderr.write(chunk);
      await nextTurn();
      afterChunk?.();
    }
    stdout.end();
    stderr.end();
    return { ...OK, ...(killed ? { exitCode: undefined, failed: true } : result) };
  })();
  return Object.assign(promise, { stdout, stderr, kill });
}

/** Answers each Docker command; `logs` writes `output` to its stderr pipe. */
function scriptDocker({ lookup = { stdout: `${ROUTER_ID}\n` }, stop = {}, logs = {}, output = RECORDS }: {
  lookup?: Step; stop?: Step; logs?: Step; output?: string;
} = {}): void {
  const run = (step: Step) => ({ ...OK, ...(typeof step === 'function' ? step() : step) });
  mockExecaFn.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'compose') return Promise.resolve(run(lookup));
    if (args[0] === 'stop') return Promise.resolve(run(stop));
    if (args[0] === 'logs') return logsChild([output], run(logs));
    throw new Error(`unexpected docker ${args.join(' ')}`);
  });
}

const dockerArgs = () => mockExecaFn.mock.calls.map(([, args]) => args);

describe('stopRouterAndSaveLogs', () => {
  let root: string;
  let workDir: string;
  let routerLogsDir: string;
  let logFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-router-logs-'));
    workDir = path.join(root, 'awf-1234');
    fs.mkdirSync(workDir);
    fs.mkdirSync(path.join(root, 'logs'));
    routerLogsDir = path.join(root, 'logs', 'router-logs');
    logFile = path.join(routerLogsDir, ROUTER_LOG_FILE);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  linuxIt('stops this run\'s router, then streams its stdout and stderr to router.jsonl', async () => {
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('saved');

    expect(dockerArgs()).toEqual([LOOKUP, STOP, LOGS]);
    expect(mockExecaFn.mock.calls[0][2]).toMatchObject({ cwd: workDir, reject: false });
    // Output arrives through pipes, so docker logs never holds the file.
    expect(mockExecaFn.mock.calls[2][2]).toMatchObject({
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', buffer: false,
    });
    for (const [, , options] of mockExecaFn.mock.calls) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(5000);
      expect(options.killSignal).toBe('SIGKILL');
    }
    expect(fs.readFileSync(logFile, 'utf8')).toBe(RECORDS);
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(routerLogsDir).mode & 0o777).toBe(0o700);
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });

  it('only acts on the container that Compose reports for this project', async () => {
    scriptDocker({ output: '' });

    await stopRouterAndSaveLogs(workDir, routerLogsDir);

    expect(JSON.stringify(dockerArgs())).not.toContain('awf-router');
  });

  it('does nothing visible when this run has no router container', async () => {
    scriptDocker({ lookup: { stdout: '' } });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('absent');

    expect(dockerArgs()).toEqual([LOOKUP]);
    expect(fs.existsSync(routerLogsDir)).toBe(false);
    expect(mockedLogger.warn).not.toHaveBeenCalled();
    expect(mockedLogger.info).not.toHaveBeenCalled();
  });

  it.each<[string, Result]>([
    ['Compose cannot read the project', { exitCode: 1, failed: true, stderr: 'no configuration file provided' }],
    ['the lookup times out', { exitCode: undefined, failed: true, timedOut: true }],
    ['Compose reports two containers', { stdout: `${ROUTER_ID}\n${'b'.repeat(64)}\n` }],
    ['Compose prints something other than a container id', { stdout: 'awf-router\n' }],
  ])('leaves the router alone when %s', async (_name, lookup) => {
    scriptDocker({ lookup });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('failed');

    expect(dockerArgs()).toEqual([LOOKUP]);
    expect(fs.existsSync(routerLogsDir)).toBe(false);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
  });

  linuxIt('still saves the logs when the router cannot be stopped', async () => {
    scriptDocker({ stop: { exitCode: 1, failed: true, stderr: 'Error response from daemon' } });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(dockerArgs()).toEqual([LOOKUP, STOP, LOGS]);
    expect(fs.readFileSync(logFile, 'utf8')).toBe(RECORDS);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not stop the router'));
  });

  linuxIt('keeps what it read when reading the logs fails', async () => {
    const partial = RECORDS.split('\n')[0];
    scriptDocker({ output: partial, logs: { exitCode: undefined, failed: true, timedOut: true } });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(fs.readFileSync(logFile, 'utf8')).toBe(partial);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`${logFile} may be incomplete`));
  });

  linuxIt('reports incomplete output when Docker exits but its streams never finish', async () => {
    jest.useFakeTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.write(RECORDS);
    mockExecaFn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'compose') return Promise.resolve({ ...OK, stdout: `${ROUTER_ID}\n` });
      if (args[0] === 'stop') return Promise.resolve(OK);
      return Object.assign(Promise.resolve(OK), { stdout, stderr, kill: jest.fn() });
    });

    const capture = stopRouterAndSaveLogs(workDir, routerLogsDir);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(capture).resolves.toBe('incomplete');

    expect(fs.readFileSync(logFile, 'utf8')).toBe(RECORDS);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`${logFile} may be incomplete`));
    expect(mockedLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Saved the router'));
  });

  it('shares one deadline between the Docker calls and stops once it has passed', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    scriptDocker({
      lookup: () => { now += 1500; return { stdout: `${ROUTER_ID}\n` }; },
      stop: () => { now += 6000; return { exitCode: undefined, failed: true, timedOut: true }; },
    });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('failed');

    expect(dockerArgs()).toEqual([LOOKUP, STOP]);
    expect(mockExecaFn.mock.calls.map(([, , options]) => options.timeout)).toEqual([5000, 3500]);
    expect(fs.existsSync(routerLogsDir)).toBe(false);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('ran out of time'));
  });

  linuxIt('replaces the file an earlier run left in the same directory and narrows its modes', async () => {
    const stale = 'stale record\n'.repeat(100);
    fs.mkdirSync(routerLogsDir, { mode: 0o755 });
    fs.writeFileSync(logFile, stale, { mode: 0o644 });
    const reader = fs.openSync(logFile, 'r');
    const previous = fs.fstatSync(reader);
    scriptDocker();

    try {
      await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('saved');

      const replacement = fs.openSync(logFile, 'r');
      try {
        const current = fs.fstatSync(replacement);
        expect(fs.readFileSync(replacement, 'utf8')).toBe(RECORDS);
        expect(fs.readFileSync(reader, 'utf8')).toBe(stale);
        expect(current.ino).not.toBe(previous.ino);
        expect(current.mode & 0o777).toBe(0o600);
      } finally {
        fs.closeSync(replacement);
      }
      expect(fs.statSync(routerLogsDir).mode & 0o777).toBe(0o700);
    } finally {
      fs.closeSync(reader);
    }
  });

  linuxIt('refuses a router log directory that is a symlink', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, routerLogsDir);
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('failed');

    expect(dockerArgs()).toEqual([LOOKUP, STOP]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  linuxIt('creates nothing when a parent of the router log directory is a symlink', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(root, 'linked-logs'));
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, path.join(root, 'linked-logs', 'router-logs')))
      .resolves.toBe('failed');

    expect(dockerArgs()).toEqual([LOOKUP, STOP]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  linuxIt('stops writing at 16 MiB and kills docker logs', async () => {
    scriptDocker({ output: 'x'.repeat(MAX_ROUTER_LOG_BYTES + 4096) });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(fs.statSync(logFile).size).toBe(MAX_ROUTER_LOG_BYTES);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${MAX_ROUTER_LOG_BYTES} bytes`));
  });

  linuxIt('never lets a burst of output past the limit onto the disk', async () => {
    let peak = 0;
    let child: ReturnType<typeof logsChild> | undefined;
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    mockExecaFn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'compose') return Promise.resolve({ ...OK, stdout: `${ROUTER_ID}\n` });
      if (args[0] === 'stop') return Promise.resolve(OK);
      child = logsChild(Array(40).fill(chunk), OK, () => {
        peak = Math.max(peak, fs.statSync(logFile).size);
      });
      return child;
    });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(child!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(peak).toBeLessThanOrEqual(MAX_ROUTER_LOG_BYTES);
    expect(fs.statSync(logFile).size).toBe(MAX_ROUTER_LOG_BYTES);
  });

  linuxIt('finishes a short write instead of dropping the rest of the chunk', async () => {
    const realWriteSync = fs.writeSync as (...args: unknown[]) => number;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.spyOn(require('fs') as typeof fs, 'writeSync').mockImplementationOnce(((
      fd: number, buffer: NodeJS.ArrayBufferView, offset?: number,
    ) => realWriteSync(fd, buffer, offset, 10)) as unknown as typeof fs.writeSync);
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('saved');

    expect(fs.readFileSync(logFile, 'utf8')).toBe(RECORDS);
  });

  linuxIt('reports a write that makes no progress', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.spyOn(require('fs') as typeof fs, 'writeSync').mockImplementationOnce(() => 0);
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not write'), expect.any(Error));
  });

  linuxIt('reports a failed write and stops docker logs', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.spyOn(require('fs') as typeof fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    let child: ReturnType<typeof logsChild> | undefined;
    mockExecaFn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'compose') return Promise.resolve({ ...OK, stdout: `${ROUTER_ID}\n` });
      if (args[0] === 'stop') return Promise.resolve(OK);
      child = logsChild([RECORDS, RECORDS], OK);
      return child;
    });

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('incomplete');

    expect(child!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.readFileSync(logFile, 'utf8')).toBe('');
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not write'), expect.any(Error));
  });

  linuxIt.each(['symlink', 'hard link'])('refuses to write through a %s at router.jsonl', async kind => {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'keep me');
    fs.mkdirSync(routerLogsDir);
    if (kind === 'symlink') fs.symlinkSync(target, logFile);
    else fs.linkSync(target, logFile);
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('failed');

    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(dockerArgs()).toEqual([LOOKUP, STOP]);
  });

  it('never throws when Docker cannot be run', async () => {
    mockExecaFn.mockRejectedValue(new Error('spawn docker ENOENT'));

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('failed');

    expect(mockedLogger.warn).toHaveBeenCalledWith('Could not save the router\'s logs:', expect.any(Error));
  });
});

describe('resolveRouterLogsDir', () => {
  let root: string;
  const routed = (overrides: Partial<WrapperConfig>): WrapperConfig => ({
    workDir: path.join(root, 'awf-1234'),
    experimentalModelRouting: true,
    modelRouting: { objective: { goal: 'cost', mode: 'balanced' }, task: { conversationFile: '/c.json' } },
    modelRoutingBootstrap: { root: path.join(root, 'routing') },
    ...overrides,
  } as unknown as WrapperConfig);

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-router-logs-dir-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('saves nothing for a run without a router service', () => {
    expect(resolveRouterLogsDir(routed({ modelRoutingBootstrap: undefined }))).toBeUndefined();
    expect(resolveRouterLogsDir(routed({ experimentalModelRouting: false }))).toBeUndefined();
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });

  it('uses router-logs next to the other logs when the audit directory is elsewhere', () => {
    expect(resolveRouterLogsDir(routed({}))).toBe(path.join(root, 'awf-1234', 'router-logs'));
    expect(resolveRouterLogsDir(routed({
      proxyLogsDir: path.join(root, 'firewall', 'logs'),
      auditDir: path.join(root, 'firewall', 'audit'),
      sessionStateDir: path.join(root, 'session'),
    }))).toBe(path.join(root, 'firewall', 'logs', 'router-logs'));
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });

  it.each<[string, (root: string) => Partial<WrapperConfig>]>([
    ['the audit directory is the logs directory', r => ({ proxyLogsDir: path.join(r, 'out'), auditDir: path.join(r, 'out') })],
    ['the logs directory is inside the audit directory', r => ({ proxyLogsDir: path.join(r, 'out', 'logs'), auditDir: path.join(r, 'out') })],
    ['the audit directory is router-logs itself', r => ({ proxyLogsDir: path.join(r, 'out'), auditDir: path.join(r, 'out', 'router-logs') })],
    ['the logs directory is inside the session-state directory', r => ({ proxyLogsDir: path.join(r, 'state', 'logs'), sessionStateDir: path.join(r, 'state') })],
    ['the logs directory is the diagnostics staging directory', r => ({ proxyLogsDir: path.join(r, 'awf-1234', 'diagnostics') })],
    ['the logs directory is a `..`-prefixed name inside the audit directory', r => ({ proxyLogsDir: path.join(r, 'out', '..logs'), auditDir: path.join(r, 'out') })],
  ])('saves nothing when %s, because cleanup widens its permissions', (_name, overrides) => {
    expect(resolveRouterLogsDir(routed(overrides(root)))).toBeUndefined();
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Not saving the router\'s logs'));
  });

  linuxIt('sees through a symlinked alias of the audit directory', () => {
    fs.mkdirSync(path.join(root, 'out'));
    fs.symlinkSync(path.join(root, 'out'), path.join(root, 'alias'));

    expect(resolveRouterLogsDir(routed({
      proxyLogsDir: path.join(root, 'out', 'logs'),
      auditDir: path.join(root, 'alias'),
    }))).toBeUndefined();
  });

  it.each(['auditDir', 'sessionStateDir'] as const)('checks the preservation destination against %s', field => {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.spyOn(require('os') as typeof os, 'tmpdir').mockReturnValue(artifacts);

    expect(resolveRouterLogsDir(routed({ [field]: artifacts }))).toBeUndefined();
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Not saving the router\'s logs'));
  });

  linuxIt('refuses a protected root with a symlink followed by a parent component', () => {
    fs.mkdirSync(path.join(root, 'out', 'subdir'), { recursive: true });
    fs.mkdirSync(path.join(root, 'alias'));
    fs.symlinkSync(path.join(root, 'out', 'subdir'), path.join(root, 'alias', 'link'));

    expect(resolveRouterLogsDir(routed({
      proxyLogsDir: path.join(root, 'out'),
      auditDir: `${root}/alias/link/..`,
    }))).toBeUndefined();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not check'), expect.any(Error),
    );
  });
});

(linuxRoot ? describe : describe.skip)('stopRouterAndSaveLogs under sudo', () => {
  const runner = 12345;
  const previous = { uid: process.env.SUDO_UID, gid: process.env.SUDO_GID };
  let root: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-router-logs-owner-'));
    fs.chmodSync(root, 0o755);
    process.env.SUDO_UID = String(runner);
    process.env.SUDO_GID = String(runner);
  });

  afterEach(() => {
    if (previous.uid === undefined) delete process.env.SUDO_UID;
    else process.env.SUDO_UID = previous.uid;
    if (previous.gid === undefined) delete process.env.SUDO_GID;
    else process.env.SUDO_GID = previous.gid;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives the logs to the invoking user and nobody else', async () => {
    const routerLogsDir = path.join(root, 'router-logs');
    const logFile = path.join(routerLogsDir, ROUTER_LOG_FILE);
    scriptDocker();

    await expect(stopRouterAndSaveLogs(root, routerLogsDir)).resolves.toBe('saved');

    expect(fs.statSync(routerLogsDir)).toMatchObject({ uid: runner, gid: runner });
    expect(fs.statSync(logFile)).toMatchObject({ uid: runner, gid: runner });
    const read = (uid: number) => spawnSync(process.execPath, ['-e', `
      try { require('fs').readFileSync(process.argv[1]); }
      catch (error) { process.stderr.write(error.code); process.exit(1); }
    `, logFile], { uid, gid: uid, encoding: 'utf8' });
    expect(read(runner)).toMatchObject({ status: 0 });
    expect(read(runner + 1)).toMatchObject({ status: 1, stderr: 'EACCES' });
  });
});
