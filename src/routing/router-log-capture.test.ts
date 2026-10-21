import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ROUTER_LOG_FILE, stopRouterAndSaveLogs } from './router-log-capture';
import { mockExecaFn } from '../test-helpers/mock-execa.test-utils';
import { logger } from '../logger';

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

interface Result {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  failed?: boolean;
  timedOut?: boolean;
}
type Step = Result | (() => Result);

/** Answers each Docker command; `logs` writes `output` to the descriptor it is given. */
function scriptDocker({ lookup = { stdout: `${ROUTER_ID}\n` }, stop = {}, logs = {}, output = RECORDS }: {
  lookup?: Step; stop?: Step; logs?: Step; output?: string;
} = {}): void {
  const run = (step: Step) => ({
    stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false,
    ...(typeof step === 'function' ? step() : step),
  });
  mockExecaFn.mockImplementation(async (_command: string, args: string[], options: { stdout?: unknown }) => {
    if (args[0] === 'compose') return run(lookup);
    if (args[0] === 'stop') return run(stop);
    if (args[0] === 'logs') {
      if (typeof options.stdout === 'number') fs.writeSync(options.stdout, output);
      return run(logs);
    }
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
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  linuxIt('stops this run\'s router, then streams its stdout and stderr to router.jsonl', async () => {
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('saved');

    expect(dockerArgs()).toEqual([LOOKUP, STOP, LOGS]);
    expect(mockExecaFn.mock.calls[0][2]).toMatchObject({ cwd: workDir, reject: false });
    const logsOptions = mockExecaFn.mock.calls[2][2];
    expect(logsOptions).toMatchObject({ stdin: 'ignore', stdout: expect.any(Number) });
    expect(logsOptions.stderr).toBe(logsOptions.stdout);
    for (const [, , options] of mockExecaFn.mock.calls) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(5000);
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
    fs.mkdirSync(routerLogsDir, { mode: 0o755 });
    fs.writeFileSync(logFile, 'stale record\n'.repeat(100), { mode: 0o644 });
    scriptDocker();

    await expect(stopRouterAndSaveLogs(workDir, routerLogsDir)).resolves.toBe('saved');

    expect(fs.readFileSync(logFile, 'utf8')).toBe(RECORDS);
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(routerLogsDir).mode & 0o777).toBe(0o700);
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
