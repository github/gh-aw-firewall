import { predownloadCommand } from './predownload';

type PredownloadOptions = Parameters<typeof predownloadCommand>[0];

// Mock execa
jest.mock('execa', () => {
  const mockExeca = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
  return { __esModule: true, default: mockExeca };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const execa = require('execa').default as jest.Mock;

describe('predownload', () => {
  describe('image resolution via predownloadCommand', () => {
    const defaults: PredownloadOptions = {
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      agentImage: 'default',
      enableApiProxy: false,
    };

    beforeEach(() => {
      execa.mockReset();
      execa.mockResolvedValue({ stdout: '', stderr: '' });
    });

    it('should resolve squid and default agent images', async () => {
      await predownloadCommand(defaults);

      expect(execa).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/squid:latest'],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/agent:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should resolve agent-act image for act preset', async () => {
      await predownloadCommand({ ...defaults, agentImage: 'act' });

      expect(execa).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/agent-act:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should include api-proxy when enabled', async () => {
      await predownloadCommand({ ...defaults, enableApiProxy: true });

      expect(execa).toHaveBeenNthCalledWith(
        3,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/api-proxy:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should include cli-proxy when enabled (no mcpg — runs externally)', async () => {
      await predownloadCommand({ ...defaults, difcProxy: true });

      expect(execa).toHaveBeenNthCalledWith(
        3,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/cli-proxy:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should include both api-proxy and cli-proxy when both enabled', async () => {
      await predownloadCommand({ ...defaults, enableApiProxy: true, difcProxy: true });

      expect(execa).toHaveBeenNthCalledWith(
        3,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/api-proxy:latest'],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        4,
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/cli-proxy:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should use custom registry and tag', async () => {
      await predownloadCommand({
        ...defaults,
        imageRegistry: 'my-registry.io/awf',
        imageTag: 'v1.0.0',
      });

      expect(execa).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['pull', 'my-registry.io/awf/squid:v1.0.0'],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['pull', 'my-registry.io/awf/agent:v1.0.0'],
        { stdio: 'inherit' },
      );
    });

    it('should append per-image digests from image-tag metadata', async () => {
      await predownloadCommand({
        ...defaults,
        imageTag: [
          '0.25.18',
          'squid=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'agent=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'api-proxy=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          'cli-proxy=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ].join(','),
        enableApiProxy: true,
        difcProxy: true,
      });

      expect(execa).toHaveBeenNthCalledWith(
        1,
        'docker',
        [
          'pull',
          'ghcr.io/github/gh-aw-firewall/squid:0.25.18@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'pull',
          'ghcr.io/github/gh-aw-firewall/agent:0.25.18@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'pull',
          'ghcr.io/github/gh-aw-firewall/api-proxy:0.25.18@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenNthCalledWith(
        4,
        'docker',
        [
          'pull',
          'ghcr.io/github/gh-aw-firewall/cli-proxy:0.25.18@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ],
        { stdio: 'inherit' },
      );
    });

    it('should use custom agent image as-is', async () => {
      await predownloadCommand({ ...defaults, agentImage: 'ubuntu:22.04' });

      expect(execa).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['pull', 'ubuntu:22.04'],
        { stdio: 'inherit' },
      );
    });

    it('should reject custom image starting with dash', async () => {
      await expect(predownloadCommand({ ...defaults, agentImage: '--help' })).rejects.toThrow(
        'must not start with "-"',
      );
    });

    it('should reject custom image containing whitespace', async () => {
      await expect(predownloadCommand({ ...defaults, agentImage: 'ubuntu 22.04' })).rejects.toThrow(
        'must not contain whitespace',
      );
    });

    it('should reject invalid image-tag digest metadata', async () => {
      await expect(
        predownloadCommand({ ...defaults, imageTag: '0.25.18,squid=sha256:not-a-real-digest' })
      ).rejects.toThrow('Invalid --image-tag digest');
    });
  });

  describe('predownloadCommand', () => {
    const defaults: PredownloadOptions = {
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      agentImage: 'default',
      enableApiProxy: false,
    };

    beforeEach(() => {
      execa.mockReset();
      execa.mockResolvedValue({ stdout: '', stderr: '' });
    });

    it('should pull all resolved images', async () => {
      await predownloadCommand(defaults);

      expect(execa).toHaveBeenCalledTimes(2);
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/squid:latest'],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/agent:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should pull api-proxy when enabled', async () => {
      await predownloadCommand({ ...defaults, enableApiProxy: true });

      expect(execa).toHaveBeenCalledTimes(3);
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/api-proxy:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should pull cli-proxy when enabled (no mcpg)', async () => {
      await predownloadCommand({ ...defaults, difcProxy: true });

      expect(execa).toHaveBeenCalledTimes(3);
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/cli-proxy:latest'],
        { stdio: 'inherit' },
      );
    });

    it('should throw with exitCode 1 when a pull fails', async () => {
      execa
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('pull failed'));

      try {
        await predownloadCommand(defaults);
        fail('Expected predownloadCommand to throw');
      } catch (error) {
        expect((error as Error).message).toBe('1 of 2 image(s) failed to pull');
        expect((error as Error & { exitCode?: number }).exitCode).toBe(1);
      }
    });

    it('should continue pulling remaining images after a failure', async () => {
      execa.mockRejectedValueOnce(new Error('pull failed')).mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(predownloadCommand(defaults)).rejects.toThrow(
        '1 of 2 image(s) failed to pull',
      );

      // Both images should have been attempted
      expect(execa).toHaveBeenCalledTimes(2);
    });

    it('should handle non-Error rejection', async () => {
      execa.mockRejectedValueOnce('string error').mockResolvedValueOnce({ stdout: '', stderr: '' });

      try {
        await predownloadCommand(defaults);
        fail('Expected predownloadCommand to throw');
      } catch (error) {
        expect((error as Error).message).toBe('1 of 2 image(s) failed to pull');
        expect((error as Error & { exitCode?: number }).exitCode).toBe(1);
      }
    });
  });
});
