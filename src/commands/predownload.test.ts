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

    it('should exit with code 1 when a pull fails', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      execa
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('pull failed'));

      await expect(predownloadCommand(defaults)).rejects.toThrow(
        'process.exit called',
      );

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it('should continue pulling remaining images after a failure', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      execa.mockRejectedValueOnce(new Error('pull failed')).mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(predownloadCommand(defaults)).rejects.toThrow(
        'process.exit called',
      );

      // Both images should have been attempted
      expect(execa).toHaveBeenCalledTimes(2);
      mockExit.mockRestore();
    });

    it('should handle non-Error rejection', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      execa.mockRejectedValueOnce('string error').mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(predownloadCommand(defaults)).rejects.toThrow(
        'process.exit called',
      );

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });
});
