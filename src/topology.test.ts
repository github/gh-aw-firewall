import execa from 'execa';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  TOPOLOGY_NETWORK_NAME,
  assertTopologySupported,
  connectTopologyContainers,
  getTopologyContainerIps,
  patchComposeWithTopologyHosts,
} from './topology';

jest.mock('execa');
jest.mock('./docker-host', () => ({
  getLocalDockerEnv: () => ({ ...process.env }),
}));
jest.mock('./logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedExeca = execa as jest.MockedFunction<typeof execa>;

describe('topology', () => {
  const savedArcHooks = process.env.ACTIONS_RUNNER_CONTAINER_HOOKS;
  const savedArcPod = process.env.ACTIONS_RUNNER_POD_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ACTIONS_RUNNER_CONTAINER_HOOKS;
    delete process.env.ACTIONS_RUNNER_POD_NAME;
  });

  afterAll(() => {
    if (savedArcHooks === undefined) delete process.env.ACTIONS_RUNNER_CONTAINER_HOOKS;
    else process.env.ACTIONS_RUNNER_CONTAINER_HOOKS = savedArcHooks;
    if (savedArcPod === undefined) delete process.env.ACTIONS_RUNNER_POD_NAME;
    else process.env.ACTIONS_RUNNER_POD_NAME = savedArcPod;
  });

  describe('assertTopologySupported', () => {
    it('returns without exiting when the Docker daemon is reachable', async () => {
      mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await assertTopologySupported();

      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('returns without exiting when daemon becomes reachable on retry', async () => {
      mockedExeca
        .mockResolvedValueOnce({ exitCode: 1 } as any) // attempt 1 fails
        .mockResolvedValueOnce({ exitCode: 0 } as any); // attempt 2 succeeds
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await assertTopologySupported();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(mockedExeca).toHaveBeenCalledTimes(2);
      exitSpy.mockRestore();
    });

    it('exits when the Docker daemon is unreachable after all retries', async () => {
      mockedExeca.mockResolvedValue({ exitCode: 1 } as any);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await assertTopologySupported();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockedExeca).toHaveBeenCalledTimes(3); // all retries exhausted
      exitSpy.mockRestore();
    });

    it('exits when the Docker daemon probe throws on all retries', async () => {
      mockedExeca.mockRejectedValue(new Error('spawn docker ENOENT'));
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await assertTopologySupported();

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('exits when an ARC kubernetes-native runner is detected', async () => {
      process.env.ACTIONS_RUNNER_CONTAINER_HOOKS = '/hooks/index.js';
      mockedExeca.mockResolvedValue({ exitCode: 1 } as any);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await assertTopologySupported();

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe('connectTopologyContainers', () => {
    it('connects each container to the network', async () => {
      mockedExeca.mockResolvedValue({ exitCode: 0, stderr: '' } as any);
      const log = { info: jest.fn(), warn: jest.fn() };

      await connectTopologyContainers(TOPOLOGY_NETWORK_NAME, ['mcp-gateway', 'difc-proxy'], log);

      expect(log.info).toHaveBeenCalled();
      expect(mockedExeca).toHaveBeenCalledTimes(2);
      expect(mockedExeca).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['network', 'connect', 'awf-net', 'mcp-gateway'],
        expect.any(Object),
      );
      expect(mockedExeca).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['network', 'connect', 'awf-net', 'difc-proxy'],
        expect.any(Object),
      );
    });

    it('treats already-attached as success (idempotent)', async () => {
      mockedExeca.mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'Error response from daemon: endpoint with name mcp-gateway already exists in network awf-net',
      } as any);

      await expect(
        connectTopologyContainers(TOPOLOGY_NETWORK_NAME, ['mcp-gateway']),
      ).resolves.toBeUndefined();
    });

    it('throws when a container cannot be connected', async () => {
      mockedExeca.mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'Error response from daemon: No such container: ghost',
      } as any);

      await expect(
        connectTopologyContainers(TOPOLOGY_NETWORK_NAME, ['ghost']),
      ).rejects.toThrow(/No such container: ghost/);
    });

    it('throws with the exit code when stderr is empty', async () => {
      mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);

      await expect(
        connectTopologyContainers(TOPOLOGY_NETWORK_NAME, ['ghost']),
      ).rejects.toThrow(/exited with code 1/);
    });
  });

  describe('getTopologyContainerIps', () => {
    it('returns IP addresses for connected containers', async () => {
      mockedExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '172.30.0.40' } as any);
      mockedExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '172.30.0.41' } as any);
      const log = { info: jest.fn(), warn: jest.fn() };

      const ips = await getTopologyContainerIps('awf-net', ['mcp-gateway', 'difc-proxy'], log);

      expect(ips.size).toBe(2);
      expect(ips.get('mcp-gateway')).toBe('172.30.0.40');
      expect(ips.get('difc-proxy')).toBe('172.30.0.41');
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('172.30.0.40'));
    });

    it('warns and skips containers with no IP', async () => {
      mockedExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '' } as any);
      const log = { info: jest.fn(), warn: jest.fn() };

      const ips = await getTopologyContainerIps('awf-net', ['missing'], log);

      expect(ips.size).toBe(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not determine IP'));
    });

    it('warns and skips containers when docker inspect fails', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('docker not found'));
      const log = { info: jest.fn(), warn: jest.fn() };

      const ips = await getTopologyContainerIps('awf-net', ['broken'], log);

      expect(ips.size).toBe(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to inspect'));
    });
  });

  describe('patchComposeWithTopologyHosts', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('adds extra_hosts entries and patches chroot hosts file', () => {
      // Create a hosts file that the compose volume references
      const hostsDir = path.join(tmpDir, 'chroot-abc');
      fs.mkdirSync(hostsDir);
      const hostsFile = path.join(hostsDir, 'hosts');
      fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');

      const compose = {
        services: {
          agent: {
            container_name: 'awf-agent',
            networks: { 'awf-net': { ipv4_address: '172.30.0.20' } },
            volumes: [`${hostsFile}:/host/etc/hosts:ro`],
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), yaml.dump(compose));
      const log = { info: jest.fn(), warn: jest.fn() };

      const peerIps = new Map([['mcp-gateway', '172.30.0.40']]);
      patchComposeWithTopologyHosts(tmpDir, peerIps, log);

      const patched = yaml.load(fs.readFileSync(path.join(tmpDir, 'docker-compose.yml'), 'utf8')) as any;
      expect(patched.services.agent.extra_hosts).toEqual({ 'mcp-gateway': '172.30.0.40' });
      // Verify hosts file was also patched
      const hostsContent = fs.readFileSync(hostsFile, 'utf8');
      expect(hostsContent).toContain('172.30.0.40\tmcp-gateway');
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Appended'));
    });

    it('appends to existing extra_hosts without overwriting', () => {
      const compose = {
        services: {
          agent: {
            container_name: 'awf-agent',
            extra_hosts: { 'host.docker.internal': 'host-gateway' },
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), yaml.dump(compose));
      const log = { info: jest.fn(), warn: jest.fn() };

      const peerIps = new Map([['mcp-gateway', '172.30.0.40']]);
      patchComposeWithTopologyHosts(tmpDir, peerIps, log);

      const patched = yaml.load(fs.readFileSync(path.join(tmpDir, 'docker-compose.yml'), 'utf8')) as any;
      expect(patched.services.agent.extra_hosts).toEqual({
        'host.docker.internal': 'host-gateway',
        'mcp-gateway': '172.30.0.40',
      });
    });

    it('also patches the squid-proxy service extra_hosts so Squid can resolve peers', () => {
      const compose = {
        services: {
          agent: { container_name: 'awf-agent' },
          'squid-proxy': { container_name: 'awf-squid' },
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), yaml.dump(compose));
      const log = { info: jest.fn(), warn: jest.fn() };

      const peerIps = new Map([['awmg-mcpg', '172.30.0.40']]);
      patchComposeWithTopologyHosts(tmpDir, peerIps, log);

      const patched = yaml.load(fs.readFileSync(path.join(tmpDir, 'docker-compose.yml'), 'utf8')) as any;
      expect(patched.services['squid-proxy'].extra_hosts).toEqual({ 'awmg-mcpg': '172.30.0.40' });
      expect(patched.services.agent.extra_hosts).toEqual({ 'awmg-mcpg': '172.30.0.40' });
    });

    it('warns when squid-proxy service is missing but still patches the agent', () => {
      const compose = { services: { agent: { container_name: 'awf-agent' } } };
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), yaml.dump(compose));
      const log = { info: jest.fn(), warn: jest.fn() };

      patchComposeWithTopologyHosts(tmpDir, new Map([['awmg-mcpg', '172.30.0.40']]), log);

      const patched = yaml.load(fs.readFileSync(path.join(tmpDir, 'docker-compose.yml'), 'utf8')) as any;
      expect(patched.services.agent.extra_hosts).toEqual({ 'awmg-mcpg': '172.30.0.40' });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find squid-proxy service'));
    });

    it('warns and returns when agent service is not found', () => {
      const compose = { services: { squid: {} } };
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), yaml.dump(compose));
      const log = { info: jest.fn(), warn: jest.fn() };

      patchComposeWithTopologyHosts(tmpDir, new Map([['x', '1.2.3.4']]), log);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not find agent service'));
    });
  });
});
