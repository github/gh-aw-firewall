import { resolveImages, PredownloadOptions } from './predownload';

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
});
