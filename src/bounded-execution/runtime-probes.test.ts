import execa from 'execa';
import {
  defaultDockerAvailabilityQuery,
  defaultDockerRuntimeQuery,
  defaultSbxAvailabilityQuery,
} from './runtime-probes';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

describe('bounded runtime probes', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('detects an exactly registered Docker runtime with the bounded timeout and local Docker environment', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '{"runc":{},"runsc":{}}' });

    await expect(defaultDockerRuntimeQuery('runsc')).resolves.toBe(true);
    await expect(defaultDockerRuntimeQuery('run')).resolves.toBe(false);
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{json .Runtimes}}'],
      expect.objectContaining({
        env: expect.any(Object),
        reject: false,
        timeout: 30_000,
      }),
    );
  });

  it('fails the Docker runtime probe closed for command failure or malformed output', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(defaultDockerRuntimeQuery('runsc')).resolves.toBe(false);

    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'not-json' });
    await expect(defaultDockerRuntimeQuery('runsc')).resolves.toBe(false);
  });

  it('reports Docker availability only for a successful daemon query', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '28.0.0' });
    await expect(defaultDockerAvailabilityQuery()).resolves.toBe(true);

    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(defaultDockerAvailabilityQuery()).resolves.toBe(false);
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      expect.objectContaining({
        env: expect.any(Object),
        reject: false,
        timeout: 30_000,
      }),
    );
  });

  it('sanitizes only sbx management overrides and preserves probe failure handling', async () => {
    const savedToken = process.env.SBX_AUTH_TOKEN;
    const savedProxy = process.env.DOCKER_SANDBOXES_PROXY;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.SBX_AUTH_TOKEN = 'daemon-credential';
    process.env.DOCKER_SANDBOXES_PROXY = 'http://proxy.invalid';
    process.env.XDG_CONFIG_HOME = '/wrong/config';

    try {
      mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '[]' });
      await expect(defaultSbxAvailabilityQuery()).resolves.toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        'sbx',
        ['ls'],
        {
          reject: false,
          timeout: 10_000,
          env: expect.objectContaining({ SBX_AUTH_TOKEN: 'daemon-credential' }),
        },
      );
      const options = mockExeca.mock.calls[0][2];
      expect(options.env).not.toHaveProperty('DOCKER_SANDBOXES_PROXY');
      expect(options.env).not.toHaveProperty('XDG_CONFIG_HOME');

      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
      await expect(defaultSbxAvailabilityQuery()).resolves.toBe(false);

      mockExeca.mockRejectedValueOnce(new Error('sbx missing'));
      await expect(defaultSbxAvailabilityQuery()).resolves.toBe(false);
    } finally {
      if (savedToken === undefined) delete process.env.SBX_AUTH_TOKEN;
      else process.env.SBX_AUTH_TOKEN = savedToken;
      if (savedProxy === undefined) delete process.env.DOCKER_SANDBOXES_PROXY;
      else process.env.DOCKER_SANDBOXES_PROXY = savedProxy;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});
