import { stripScheme } from './host-env';
import { hostEnvTestHelpers } from './host-env.test-utils';
import { ACT_PRESET_BASE_IMAGE } from './host-identity';
import { extractGhHostFromServerUrl } from './github-env';

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager string/network utilities', () => {
  describe('subnetsOverlap', () => {
    it('should detect overlapping subnets with same CIDR', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('172.30.0.0/24', '172.30.0.0/24')).toBe(true);
    });

    it('should detect non-overlapping subnets', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('172.30.0.0/24', '172.31.0.0/24')).toBe(false);
      expect(hostEnvTestHelpers.subnetsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
    });

    it('should detect when smaller subnet is inside larger subnet', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('172.16.0.0/16', '172.16.5.0/24')).toBe(true);
      expect(hostEnvTestHelpers.subnetsOverlap('172.16.5.0/24', '172.16.0.0/16')).toBe(true);
    });

    it('should detect partial overlap', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('172.30.0.0/23', '172.30.1.0/24')).toBe(true);
    });

    it('should handle Docker default bridge network', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('172.17.0.0/16', '172.17.5.0/24')).toBe(true);
      expect(hostEnvTestHelpers.subnetsOverlap('172.17.0.0/16', '172.18.0.0/16')).toBe(false);
    });

    it('should handle /32 (single host) networks', () => {
      expect(hostEnvTestHelpers.subnetsOverlap('192.168.1.1/32', '192.168.1.1/32')).toBe(true);
      expect(hostEnvTestHelpers.subnetsOverlap('192.168.1.1/32', '192.168.1.2/32')).toBe(false);
    });
  });

  describe('ACT_PRESET_BASE_IMAGE', () => {
    it('should be a valid catthehacker act image', () => {
      expect(ACT_PRESET_BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:act-24.04');
    });

    it('should match expected pattern for catthehacker images', () => {
      expect(ACT_PRESET_BASE_IMAGE).toMatch(/^ghcr\.io\/catthehacker\/ubuntu:act-\d+\.\d+$/);
    });
  });

  describe('extractGhHostFromServerUrl', () => {
    it('should return null for undefined GITHUB_SERVER_URL', () => {
      expect(extractGhHostFromServerUrl(undefined)).toBeNull();
    });

    it('should return null for empty string GITHUB_SERVER_URL', () => {
      expect(extractGhHostFromServerUrl('')).toBeNull();
    });

    it('should return null for github.com (public GitHub)', () => {
      expect(extractGhHostFromServerUrl('https://github.com')).toBeNull();
    });

    it('should extract hostname for GHEC instance (*.ghe.com)', () => {
      expect(extractGhHostFromServerUrl('https://acme.ghe.com')).toBe('acme.ghe.com');
    });

    it('should extract hostname for GHES instance', () => {
      expect(extractGhHostFromServerUrl('https://github.company.com')).toBe('github.company.com');
    });

    it('should extract hostname for GHES instance with custom port', () => {
      expect(extractGhHostFromServerUrl('https://github.internal:8443')).toBe('github.internal');
    });

    it('should handle GITHUB_SERVER_URL without trailing slash', () => {
      expect(extractGhHostFromServerUrl('https://github.enterprise.local')).toBe('github.enterprise.local');
    });

    it('should handle GITHUB_SERVER_URL with trailing slash', () => {
      expect(extractGhHostFromServerUrl('https://github.enterprise.local/')).toBe('github.enterprise.local');
    });

    it('should return null for invalid URL', () => {
      expect(extractGhHostFromServerUrl('not-a-valid-url')).toBeNull();
    });

    it('should return null for malformed URL', () => {
      expect(extractGhHostFromServerUrl('http://')).toBeNull();
    });
  });

  describe('stripScheme', () => {
    it('should strip https:// prefix', () => {
      expect(stripScheme('https://my-gateway.example.com')).toBe('my-gateway.example.com');
    });

    it('should strip http:// prefix', () => {
      expect(stripScheme('http://my-gateway.example.com')).toBe('my-gateway.example.com');
    });

    it('should preserve bare hostname', () => {
      expect(stripScheme('api.openai.com')).toBe('api.openai.com');
    });

    it('should normalize URL with path to hostname only', () => {
      expect(stripScheme('https://my-gateway.example.com/some-path')).toBe('my-gateway.example.com');
    });

    it('should not strip scheme-like substrings in the middle', () => {
      expect(stripScheme('api.https.example.com')).toBe('api.https.example.com');
    });
  });
});
