import execa from 'execa';
import {
  TOPOLOGY_NETWORK_NAME,
  assertTopologySupported,
  connectTopologyContainers,
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
});
