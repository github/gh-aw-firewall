import * as copilotApiResolverModule from './copilot-api-resolver';
import {
  resolveCopilotApiRouting,
} from './copilot-api-resolver';
import { copilotApiResolverTestHelpers } from './copilot-api-resolver.test-utils';

const {
  deriveCopilotApiTargetFromProviderBaseUrl,
  deriveCopilotApiBasePathFromProviderBaseUrl,
} = copilotApiResolverTestHelpers;

describe('copilot-api-resolver module', () => {
  it('should not expose test helpers from the production module API', () => {
    expect(copilotApiResolverModule).not.toHaveProperty('copilotApiResolverTestHelpers');
  });
});

describe('deriveCopilotApiTargetFromProviderBaseUrl', () => {
  it('should extract hostname from full URL', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://api.openai.com')).toBe('api.openai.com');
  });

  it('should extract hostname from URL with path', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://api.example.com/v1/chat')).toBe('api.example.com');
  });

  it('should extract hostname from URL with port', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://localhost:8080')).toBe('localhost');
  });

  it('should handle URL without scheme by adding https://', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('api.openai.com')).toBe('api.openai.com');
  });

  it('should handle URL with http scheme', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('http://api.example.com')).toBe('api.example.com');
  });

  it('should return undefined for empty string', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('')).toBeUndefined();
  });

  it('should return undefined for whitespace-only string', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('   ')).toBeUndefined();
  });

  it('should return undefined for undefined input', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl(undefined)).toBeUndefined();
  });

  it('should return undefined for invalid URL', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('://invalid')).toBeUndefined();
  });

  it('should handle URLs with subdomains', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://api.us-west.openai.com')).toBe('api.us-west.openai.com');
  });

  it('should handle IPv4 addresses', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://192.168.1.1:8080')).toBe('192.168.1.1');
  });

  it('should handle IPv6 addresses', () => {
    expect(deriveCopilotApiTargetFromProviderBaseUrl('https://[::1]:8080')).toBe('[::1]');
  });
});

describe('deriveCopilotApiBasePathFromProviderBaseUrl', () => {
  it('should extract path from URL', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1')).toBe('/v1');
  });

  it('should extract multi-segment path', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1/chat/completions')).toBe('/v1/chat/completions');
  });

  it('should strip trailing slashes', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1/')).toBe('/v1');
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1///')).toBe('/v1');
  });

  it('should return undefined for URL with no path', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com')).toBeUndefined();
  });

  it('should return undefined for URL with only root path', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/')).toBeUndefined();
  });

  it('should ensure path starts with slash', () => {
    // Even without scheme, URL parsing should normalize
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('api.example.com/v1')).toBe('/v1');
  });

  it('should return undefined for empty string', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('')).toBeUndefined();
  });

  it('should return undefined for whitespace-only string', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('   ')).toBeUndefined();
  });

  it('should return undefined for undefined input', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl(undefined)).toBeUndefined();
  });

  it('should return undefined for invalid URL', () => {
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('://invalid')).toBeUndefined();
  });

  it('should handle URL with query parameters', () => {
    // Path should not include query string
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1?param=value')).toBe('/v1');
  });

  it('should handle URL with fragment', () => {
    // Path should not include fragment
    expect(deriveCopilotApiBasePathFromProviderBaseUrl('https://api.example.com/v1#section')).toBe('/v1');
  });
});

describe('resolveCopilotApiRouting', () => {
  describe('target resolution', () => {
    it('should use --copilot-api-target option when provided', () => {
      const result = resolveCopilotApiRouting(
        { copilotApiTarget: 'cli.example.com' },
        { COPILOT_API_TARGET: 'env.example.com', COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com' }
      );
      expect(result.copilotApiTarget).toBe('cli.example.com');
    });

    it('should use COPILOT_API_TARGET when option not provided', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_API_TARGET: 'env.example.com', COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com' }
      );
      expect(result.copilotApiTarget).toBe('env.example.com');
    });

    it('should derive from COPILOT_PROVIDER_BASE_URL when neither option nor env target provided', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com' }
      );
      expect(result.copilotApiTarget).toBe('provider.example.com');
    });

    it('should return undefined when no target sources available', () => {
      const result = resolveCopilotApiRouting({}, {});
      expect(result.copilotApiTarget).toBeUndefined();
    });
  });

  describe('base path resolution', () => {
    it('should use COPILOT_API_BASE_PATH when provided', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_API_BASE_PATH: '/custom/path', COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com/v1' }
      );
      expect(result.copilotApiBasePath).toBe('/custom/path');
    });

    it('should derive from COPILOT_PROVIDER_BASE_URL when env base path not provided', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com/v1/chat' }
      );
      expect(result.copilotApiBasePath).toBe('/v1/chat');
    });

    it('should return undefined when no base path sources available', () => {
      const result = resolveCopilotApiRouting({}, {});
      expect(result.copilotApiBasePath).toBeUndefined();
    });

    it('should return undefined when COPILOT_PROVIDER_BASE_URL has no path', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com' }
      );
      expect(result.copilotApiBasePath).toBeUndefined();
    });
  });

  describe('combined resolution', () => {
    it('should resolve both target and base path', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: 'https://api.openai.com/v1' }
      );
      expect(result.copilotApiTarget).toBe('api.openai.com');
      expect(result.copilotApiBasePath).toBe('/v1');
    });

    it('should respect precedence rules for both target and path', () => {
      const result = resolveCopilotApiRouting(
        { copilotApiTarget: 'override.example.com' },
        {
          COPILOT_API_TARGET: 'env-target.example.com',
          COPILOT_API_BASE_PATH: '/env-path',
          COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com/provider-path',
        }
      );
      expect(result.copilotApiTarget).toBe('override.example.com');
      expect(result.copilotApiBasePath).toBe('/env-path');
    });

    it('should use process.env by default', () => {
      // Save original env
      const originalTarget = process.env.COPILOT_API_TARGET;
      const originalBasePath = process.env.COPILOT_API_BASE_PATH;
      const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;

      try {
        delete process.env.COPILOT_API_TARGET;
        delete process.env.COPILOT_API_BASE_PATH;
        delete process.env.COPILOT_PROVIDER_BASE_URL;

        const result = resolveCopilotApiRouting({});
        expect(result.copilotApiTarget).toBeUndefined();
        expect(result.copilotApiBasePath).toBeUndefined();
      } finally {
        // Restore original env
        if (originalTarget !== undefined) process.env.COPILOT_API_TARGET = originalTarget;
        else delete process.env.COPILOT_API_TARGET;
        if (originalBasePath !== undefined) process.env.COPILOT_API_BASE_PATH = originalBasePath;
        else delete process.env.COPILOT_API_BASE_PATH;
        if (originalProviderBaseUrl !== undefined) process.env.COPILOT_PROVIDER_BASE_URL = originalProviderBaseUrl;
        else delete process.env.COPILOT_PROVIDER_BASE_URL;
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty string values', () => {
      const result = resolveCopilotApiRouting(
        { copilotApiTarget: '' },
        { COPILOT_API_BASE_PATH: '', COPILOT_PROVIDER_BASE_URL: '' }
      );
      // Empty strings are falsy for ||, so should fall through to undefined
      expect(result.copilotApiTarget).toBeUndefined();
      expect(result.copilotApiBasePath).toBeUndefined();
    });

    it('should handle whitespace-only provider base URL', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: '   ' }
      );
      expect(result.copilotApiTarget).toBeUndefined();
      expect(result.copilotApiBasePath).toBeUndefined();
    });

    it('should handle malformed provider base URL', () => {
      const result = resolveCopilotApiRouting(
        {},
        { COPILOT_PROVIDER_BASE_URL: '://malformed' }
      );
      expect(result.copilotApiTarget).toBeUndefined();
      expect(result.copilotApiBasePath).toBeUndefined();
    });
  });
});
