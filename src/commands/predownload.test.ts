import { resolveImages, predownloadCommand, PredownloadOptions } from './predownload';

// Mock execa
jest.mock('execa', () => {
  const mockExeca = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
  return { __esModule: true, default: mockExeca };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const execa = require('execa').default as jest.Mock;

describe('predownload', () => {
  describe('resolveImages', () => {
    const defaults: PredownloadOptions = {
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      agentImage: 'default',
      enableApiProxy: false,
    };

    it('should resolve squid and default agent images', () => {
      const images = resolveImages(defaults);
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent:latest',
      ]);
    });

    it('should resolve agent-act image for act preset', () => {
      const images = resolveImages({ ...defaults, agentImage: 'act' });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent-act:latest',
      ]);
    });

    it('should include api-proxy when enabled', () => {
      const images = resolveImages({ ...defaults, enableApiProxy: true });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent:latest',
        'ghcr.io/github/gh-aw-firewall/api-proxy:latest',
      ]);
    });

    it('should include cli-proxy and mcpg when enabled', () => {
      const images = resolveImages({ ...defaults, enableCliProxy: true });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent:latest',
        'ghcr.io/github/gh-aw-firewall/cli-proxy:latest',
        'ghcr.io/github/gh-aw-mcpg:v0.2.15',
      ]);
    });

    it('should include both api-proxy and cli-proxy when both enabled', () => {
      const images = resolveImages({ ...defaults, enableApiProxy: true, enableCliProxy: true });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent:latest',
        'ghcr.io/github/gh-aw-firewall/api-proxy:latest',
        'ghcr.io/github/gh-aw-firewall/cli-proxy:latest',
        'ghcr.io/github/gh-aw-mcpg:v0.2.15',
      ]);
    });

    it('should use custom mcpg image when specified', () => {
      const images = resolveImages({ ...defaults, enableCliProxy: true, cliProxyMcpgImage: 'ghcr.io/github/gh-aw-mcpg:v0.3.0' });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ghcr.io/github/gh-aw-firewall/agent:latest',
        'ghcr.io/github/gh-aw-firewall/cli-proxy:latest',
        'ghcr.io/github/gh-aw-mcpg:v0.3.0',
      ]);
    });

    it('should use custom registry and tag', () => {
      const images = resolveImages({
        ...defaults,
        imageRegistry: 'my-registry.io/awf',
        imageTag: 'v1.0.0',
      });
      expect(images).toEqual([
        'my-registry.io/awf/squid:v1.0.0',
        'my-registry.io/awf/agent:v1.0.0',
      ]);
    });

    it('should use custom agent image as-is', () => {
      const images = resolveImages({ ...defaults, agentImage: 'ubuntu:22.04' });
      expect(images).toEqual([
        'ghcr.io/github/gh-aw-firewall/squid:latest',
        'ubuntu:22.04',
      ]);
    });

    it('should reject custom image starting with dash', () => {
      expect(() => resolveImages({ ...defaults, agentImage: '--help' })).toThrow(
        'must not start with "-"',
      );
    });

    it('should reject custom image containing whitespace', () => {
      expect(() => resolveImages({ ...defaults, agentImage: 'ubuntu 22.04' })).toThrow(
        'must not contain whitespace',
      );
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

    it('should pull cli-proxy and mcpg when enabled', async () => {
      await predownloadCommand({ ...defaults, enableCliProxy: true });

      expect(execa).toHaveBeenCalledTimes(4);
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-firewall/cli-proxy:latest'],
        { stdio: 'inherit' },
      );
      expect(execa).toHaveBeenCalledWith(
        'docker',
        ['pull', 'ghcr.io/github/gh-aw-mcpg:v0.2.15'],
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
