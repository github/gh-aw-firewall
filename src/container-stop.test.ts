import { fastKillAgentContainer } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { stopContainers } from './container-stop';
import { AGENT_CONTAINER_NAME } from './constants';

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('stopContainers', () => {
  const { getDir } = useTempDir();

  it('should skip stopping when keepContainers is true', async () => {
    await stopContainers(getDir(), true);

    expect(mockExecaFn).not.toHaveBeenCalled();
  });

  it('should run docker compose down when keepContainers is false', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await stopContainers(getDir(), false);

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '-v', '-t', '1'],
      expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
    );
  });

  it('should throw error when docker compose down fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('Docker compose down failed'));

    await expect(stopContainers(getDir(), false)).rejects.toThrow('Docker compose down failed');
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
