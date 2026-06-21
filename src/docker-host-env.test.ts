import { startContainers } from './container-lifecycle';
import { setAwfDockerHost, getLocalDockerEnv } from './docker-host';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('setAwfDockerHost / getLocalDockerEnv (DOCKER_HOST isolation)', () => {
  const originalDockerHost = process.env.DOCKER_HOST;

  afterEach(() => {
    // Restore env and reset override after each test
    if (originalDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = originalDockerHost;
    }
    setAwfDockerHost(undefined);
    jest.clearAllMocks();
  });

  it('docker compose up should forward a loopback TCP DOCKER_HOST to the docker CLI', async () => {
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
    try {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

      await startContainers(testDir, ['github.com']);

      const composeCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[1]?.[0] === 'compose'
      );
      expect(composeCalls.length).toBeGreaterThan(0);
      const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
      // tcp://localhost DOCKER_HOST must be passed through to docker compose (ARC/DinD support)
      expect(composeEnv).toBeDefined();
      expect(composeEnv!.DOCKER_HOST).toBe('tcp://localhost:2375');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('docker compose up should keep a unix:// DOCKER_HOST in the env', async () => {
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
    try {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

      await startContainers(testDir, ['github.com']);

      const composeCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[1]?.[0] === 'compose'
      );
      expect(composeCalls.length).toBeGreaterThan(0);
      const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
      expect(composeEnv).toBeDefined();
      expect(composeEnv!.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('setAwfDockerHost should override DOCKER_HOST for AWF operations', async () => {
    process.env.DOCKER_HOST = 'tcp://localhost:2375'; // CLI override wins over env var
    setAwfDockerHost('unix:///run/user/1000/docker.sock');
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
    try {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

      await startContainers(testDir, ['github.com']);

      const composeCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[1]?.[0] === 'compose'
      );
      expect(composeCalls.length).toBeGreaterThan(0);
      const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
      expect(composeEnv).toBeDefined();
      expect(composeEnv!.DOCKER_HOST).toBe('unix:///run/user/1000/docker.sock');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('getLocalDockerEnv returns a ProcessEnv-shaped object', () => {
    const env = getLocalDockerEnv();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  it('getLocalDockerEnv clears a non-loopback TCP DOCKER_HOST', () => {
    process.env.DOCKER_HOST = 'tcp://192.168.1.100:2375';
    const env = getLocalDockerEnv();
    // Non-loopback TCP must be removed so docker CLI falls back to the local socket
    expect(env.DOCKER_HOST).toBeUndefined();
  });
});
