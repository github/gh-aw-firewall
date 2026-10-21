import * as fs from 'fs';
import * as path from 'path';
import { fastKillAgentContainer } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { stopContainers } from './container-stop';
import { AGENT_CONTAINER_NAME, SQUID_CONTAINER_NAME } from './constants';

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('stopContainers', () => {
  const { getDir } = useTempDir();

  beforeEach(() => jest.clearAllMocks());

  it('should skip stopping when keepContainers is true', async () => {
    await stopContainers(getDir(), true);

    expect(mockExecaFn).not.toHaveBeenCalled();
  });

  it('should run pre-shutdown permission repair and docker compose down when keepContainers is false', async () => {
    // 1. docker exec --user root awf-squid chown/chmod (pre-shutdown)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 2. docker compose down
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await stopContainers(getDir(), false);

    expect(mockExecaFn).toHaveBeenNthCalledWith(
      1,
      'docker',
      [
        'exec',
        '--user',
        'root',
        '-e',
        expect.stringMatching(/^TUID=\d+$/),
        '-e',
        expect.stringMatching(/^TGID=\d+$/),
        SQUID_CONTAINER_NAME,
        'sh',
        '-c',
        'chown "$TUID:$TGID" /var/log/squid 2>/dev/null; chmod a+rX /var/log/squid 2>/dev/null; find /var/log/squid -maxdepth 1 -type f -exec chown "$TUID:$TGID" {} \\; -exec chmod a+rX {} \\; 2>/dev/null',
      ],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExecaFn).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['compose', 'down', '-v', '-t', '1'],
      expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
    );
  });

  it('should still run docker compose down when the permission repair fails', async () => {
    // chmod fails (e.g. container not running)
    mockExecaFn.mockRejectedValueOnce(new Error('container not found'));
    // compose down succeeds
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await stopContainers(getDir(), false);

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '-v', '-t', '1'],
      expect.anything(),
    );
  });

  it('should throw error when docker compose down fails', async () => {
    // chmod succeeds
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // compose down fails
    mockExecaFn.mockRejectedValueOnce(new Error('Docker compose down failed'));

    await expect(stopContainers(getDir(), false)).rejects.toThrow('Docker compose down failed');
  });
});

describe('stopContainers with model routing', () => {
  const { getDir } = useTempDir();
  const linuxIt = process.platform === 'linux' ? it : it.skip;
  const routerId = 'c'.repeat(64);
  const record = '{"level":"INFO","msg":"stopped"}\n';
  const routerLogsDir = () => path.join(getDir(), 'router-logs');

  function scriptDocker({ lookupFails = false, composeDownError }: { lookupFails?: boolean; composeDownError?: Error } = {}) {
    mockExecaFn.mockImplementation(async (_command: string, args: string[], options: { stdout?: unknown }) => {
      const ok = { stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false };
      if (args[0] === 'compose' && args[1] === 'ps') {
        return lookupFails ? { ...ok, exitCode: 1, failed: true } : { ...ok, stdout: `${routerId}\n` };
      }
      if (args[0] === 'logs' && typeof options.stdout === 'number') fs.writeSync(options.stdout, record);
      if (args[0] === 'compose' && args[1] === 'down' && composeDownError) throw composeDownError;
      return ok;
    });
  }
  const dockerCommands = () => mockExecaFn.mock.calls.map(([, args]) => args.slice(0, 2).join(' '));

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => mockExecaFn.mockReset());

  linuxIt('stops the router and saves its logs before compose down', async () => {
    scriptDocker();

    await stopContainers(getDir(), false, { routerLogsDir: routerLogsDir() });

    expect(dockerCommands()).toEqual(['exec --user', 'compose ps', 'stop -t', `logs ${routerId}`, 'compose down']);
    expect(fs.readFileSync(path.join(routerLogsDir(), 'router.jsonl'), 'utf8')).toBe(record);
  });

  it('leaves the router to compose down without a router log directory', async () => {
    scriptDocker();

    await stopContainers(getDir(), false, {});

    expect(dockerCommands()).toEqual(['exec --user', 'compose down']);
  });

  it('runs compose down when the router logs cannot be saved', async () => {
    scriptDocker({ lookupFails: true });

    await stopContainers(getDir(), false, { routerLogsDir: routerLogsDir() });

    expect(dockerCommands()).toEqual(['exec --user', 'compose ps', 'compose down']);
    expect(fs.existsSync(routerLogsDir())).toBe(false);
  });

  it('still reports a compose down failure after a failed capture', async () => {
    scriptDocker({ lookupFails: true, composeDownError: new Error('Docker compose down failed') });

    await expect(stopContainers(getDir(), false, { routerLogsDir: routerLogsDir() }))
      .rejects.toThrow('Docker compose down failed');
  });

  it('touches nothing when containers are kept', async () => {
    await stopContainers(getDir(), true, { routerLogsDir: routerLogsDir() });

    expect(mockExecaFn).not.toHaveBeenCalled();
  });
});

describe('fastKillAgentContainer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  it('should call docker stop with default 3-second timeout', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await fastKillAgentContainer();

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['stop', '-t', '3', AGENT_CONTAINER_NAME],
      expect.objectContaining({ reject: false, timeout: 8000 })
    );
  });

  it('should accept a custom stop timeout', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await fastKillAgentContainer(5);

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['stop', '-t', '5', AGENT_CONTAINER_NAME],
      expect.objectContaining({ reject: false, timeout: 10000 })
    );
  });

  it('should not throw when docker stop fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('docker not found'));

    await expect(fastKillAgentContainer()).resolves.toBeUndefined();
  });

  it('should set the externally-killed flag', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(false);
    await fastKillAgentContainer();
    expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(true);
  });

  it('should set the externally-killed flag even when docker stop fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('docker not found'));

    await fastKillAgentContainer();
    expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(true);
  });
});
