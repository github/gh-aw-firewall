import {
  parseDomains,
  parseDomainsFile,
  isValidIPv4,
  isValidIPv6,
  isAgentImagePreset,
  AGENT_IMAGE_PRESETS,
  validateAgentImage,
  processAgentImageOption,
  DEFAULT_OPENAI_API_TARGET,
  DEFAULT_ANTHROPIC_API_TARGET,
  DEFAULT_COPILOT_API_TARGET,
  DEFAULT_GEMINI_API_TARGET,
} from './domain-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('domain parsing', () => {
  it('should split comma-separated domains correctly', () => {
    const result = parseDomains('github.com, api.github.com, npmjs.org');

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should handle domains without spaces', () => {
    const result = parseDomains('github.com,api.github.com,npmjs.org');

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should filter out empty domains', () => {
    const result = parseDomains('github.com,,, api.github.com,  ,npmjs.org');

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should return empty array for whitespace-only input', () => {
    const result = parseDomains('  ,  ,  ');

    expect(result).toEqual([]);
  });

  it('should handle single domain', () => {
    const result = parseDomains('github.com');

    expect(result).toEqual(['github.com']);
  });
});

describe('domain file parsing', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
  });

  afterEach(() => {
    // Clean up the test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should parse domains from file with one domain per line', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com\napi.github.com\nnpmjs.org');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should parse comma-separated domains from file', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com, api.github.com, npmjs.org');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should handle mixed formats (lines and commas)', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com\napi.github.com, npmjs.org\nexample.com');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org', 'example.com']);
  });

  it('should skip empty lines', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com\n\n\napi.github.com\n\nnpmjs.org');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should skip lines with only whitespace', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com\n   \n\t\napi.github.com');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com']);
  });

  it('should skip comments starting with #', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, '# This is a comment\ngithub.com\n# Another comment\napi.github.com');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com']);
  });

  it('should handle inline comments (after domain)', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com # GitHub main domain\napi.github.com # API endpoint');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com']);
  });

  it('should handle domains with inline comments in comma-separated format', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com, api.github.com # GitHub domains\nnpmjs.org');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should throw error if file does not exist', () => {
    const nonExistentPath = path.join(testDir, 'nonexistent.txt');

    expect(() => parseDomainsFile(nonExistentPath)).toThrow('Domains file not found');
  });

  it('should return empty array for file with only comments and whitespace', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, '# Comment 1\n\n# Comment 2\n   \n');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual([]);
  });

  it('should handle file with Windows line endings (CRLF)', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, 'github.com\r\napi.github.com\r\nnpmjs.org');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });

  it('should trim whitespace from each domain', () => {
    const filePath = path.join(testDir, 'domains.txt');
    fs.writeFileSync(filePath, '  github.com  \n  api.github.com  \n  npmjs.org  ');

    const result = parseDomainsFile(filePath);

    expect(result).toEqual(['github.com', 'api.github.com', 'npmjs.org']);
  });
});

describe('IPv4 validation', () => {
  it('should accept valid IPv4 addresses', () => {
    expect(isValidIPv4('8.8.8.8')).toBe(true);
    expect(isValidIPv4('1.1.1.1')).toBe(true);
    expect(isValidIPv4('192.168.1.1')).toBe(true);
    expect(isValidIPv4('0.0.0.0')).toBe(true);
    expect(isValidIPv4('255.255.255.255')).toBe(true);
    expect(isValidIPv4('10.0.0.1')).toBe(true);
    expect(isValidIPv4('172.16.0.1')).toBe(true);
  });

  it('should reject invalid IPv4 addresses', () => {
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('1.1.1')).toBe(false);
    expect(isValidIPv4('1.1.1.1.1')).toBe(false);
    expect(isValidIPv4('1.1.1.256')).toBe(false);
    expect(isValidIPv4('a.b.c.d')).toBe(false);
    expect(isValidIPv4('1.1.1.1a')).toBe(false);
    expect(isValidIPv4('')).toBe(false);
    expect(isValidIPv4('localhost')).toBe(false);
    expect(isValidIPv4('::1')).toBe(false);
  });
});

describe('IPv6 validation', () => {
  it('should accept valid IPv6 addresses', () => {
    expect(isValidIPv6('2001:4860:4860::8888')).toBe(true);
    expect(isValidIPv6('2001:4860:4860::8844')).toBe(true);
    expect(isValidIPv6('::1')).toBe(true);
    expect(isValidIPv6('::')).toBe(true);
    expect(isValidIPv6('fe80::1')).toBe(true);
    expect(isValidIPv6('2001:db8:85a3::8a2e:370:7334')).toBe(true);
    expect(isValidIPv6('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
  });

  it('should accept IPv4-mapped IPv6 addresses', () => {
    expect(isValidIPv6('::ffff:192.0.2.1')).toBe(true);
    expect(isValidIPv6('::ffff:8.8.8.8')).toBe(true);
    expect(isValidIPv6('::ffff:127.0.0.1')).toBe(true);
  });

  it('should reject invalid IPv6 addresses', () => {
    expect(isValidIPv6('8.8.8.8')).toBe(false);
    expect(isValidIPv6('localhost')).toBe(false);
    expect(isValidIPv6('')).toBe(false);
    expect(isValidIPv6('2001:4860:4860:8888')).toBe(false); // Missing ::
  });

  it('should reject malformed input', () => {
    expect(isValidIPv6('not-an-ip')).toBe(false);
    expect(isValidIPv6('192.168.1.1')).toBe(false);
    expect(isValidIPv6(':::1')).toBe(false);
    expect(isValidIPv6('2001:db8::g')).toBe(false); // Invalid hex character
  });
});

describe('isAgentImagePreset', () => {
  it('should return true for "default" preset', () => {
    expect(isAgentImagePreset('default')).toBe(true);
  });

  it('should return true for "act" preset', () => {
    expect(isAgentImagePreset('act')).toBe(true);
  });

  it('should return false for custom images', () => {
    expect(isAgentImagePreset('ubuntu:22.04')).toBe(false);
    expect(isAgentImagePreset('ghcr.io/catthehacker/ubuntu:runner-22.04')).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isAgentImagePreset(undefined)).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isAgentImagePreset('')).toBe(false);
  });

  it('should return false for case variations of presets', () => {
    expect(isAgentImagePreset('Default')).toBe(false);
    expect(isAgentImagePreset('DEFAULT')).toBe(false);
    expect(isAgentImagePreset('Act')).toBe(false);
    expect(isAgentImagePreset('ACT')).toBe(false);
  });

  it('should return false for presets with whitespace', () => {
    expect(isAgentImagePreset(' default')).toBe(false);
    expect(isAgentImagePreset('default ')).toBe(false);
    expect(isAgentImagePreset(' act ')).toBe(false);
  });

  it('should return false for similar but not exact preset names', () => {
    expect(isAgentImagePreset('defaults')).toBe(false);
    expect(isAgentImagePreset('action')).toBe(false);
    expect(isAgentImagePreset('def')).toBe(false);
  });
});

describe('AGENT_IMAGE_PRESETS', () => {
  it('should contain default and act', () => {
    expect(AGENT_IMAGE_PRESETS).toContain('default');
    expect(AGENT_IMAGE_PRESETS).toContain('act');
    expect(AGENT_IMAGE_PRESETS.length).toBe(2);
  });
});

describe('validateAgentImage', () => {
  describe('presets', () => {
    it('should accept "default" preset', () => {
      expect(validateAgentImage('default')).toEqual({ valid: true });
    });

    it('should accept "act" preset', () => {
      expect(validateAgentImage('act')).toEqual({ valid: true });
    });
  });

  describe('valid custom images', () => {
    it('should accept official Ubuntu images', () => {
      expect(validateAgentImage('ubuntu:22.04')).toEqual({ valid: true });
      expect(validateAgentImage('ubuntu:24.04')).toEqual({ valid: true });
      expect(validateAgentImage('ubuntu:20.04')).toEqual({ valid: true });
    });

    it('should accept catthehacker runner images', () => {
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:runner-22.04')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:runner-24.04')).toEqual({ valid: true });
    });

    it('should accept catthehacker full images', () => {
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:full-22.04')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:full-24.04')).toEqual({ valid: true });
    });

    it('should accept catthehacker act images', () => {
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:act-22.04')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:act-24.04')).toEqual({ valid: true });
    });

    it('should accept images with SHA256 digest pinning', () => {
      expect(validateAgentImage('ubuntu:22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:runner-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:full-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:act-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1')).toEqual({ valid: true });
    });
  });

  describe('invalid custom images', () => {
    it('should reject arbitrary images', () => {
      const result = validateAgentImage('malicious-registry.com/evil:latest');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject images with typos', () => {
      const result = validateAgentImage('ubunto:22.04');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject non-ubuntu official images', () => {
      const result = validateAgentImage('alpine:latest');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject unknown registries', () => {
      const result = validateAgentImage('docker.io/library/ubuntu:22.04');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject images from other catthehacker registries', () => {
      const result = validateAgentImage('ghcr.io/catthehacker/debian:latest');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject ubuntu with non-standard tags', () => {
      const result = validateAgentImage('ubuntu:latest');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject empty image string', () => {
      const result = validateAgentImage('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject ubuntu with only major version', () => {
      const result = validateAgentImage('ubuntu:22');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject catthehacker with wrong prefix', () => {
      const result = validateAgentImage('ghcr.io/catthehacker/ubuntu:minimal-22.04');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject malformed SHA256 digest (too short)', () => {
      const result = validateAgentImage('ubuntu:22.04@sha256:abc123');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject SHA256 digest with uppercase hex', () => {
      const result = validateAgentImage('ubuntu:22.04@sha256:A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject image with path traversal attempt', () => {
      const result = validateAgentImage('../ubuntu:22.04');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should reject similar but invalid registry paths', () => {
      // Similar to ghcr.io/catthehacker but different
      expect(validateAgentImage('ghcr.io/catthehacker2/ubuntu:runner-22.04').valid).toBe(false);
      expect(validateAgentImage('ghcr.io/catthehackerubuntu:runner-22.04').valid).toBe(false);
      expect(validateAgentImage('ghcr.io/cat-the-hacker/ubuntu:runner-22.04').valid).toBe(false);
    });

    it('should provide helpful error message with allowed options including presets', () => {
      const result = validateAgentImage('invalid:image');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('default');
      expect(result.error).toContain('act');
      expect(result.error).toContain('ubuntu:XX.XX');
      expect(result.error).toContain('ghcr.io/catthehacker/ubuntu:runner-XX.XX');
      expect(result.error).toContain('ghcr.io/catthehacker/ubuntu:full-XX.XX');
      expect(result.error).toContain('ghcr.io/catthehacker/ubuntu:act-XX.XX');
      expect(result.error).toContain('@sha256:');
    });
  });

  describe('regex pattern coverage', () => {
    // Ensure each regex pattern in SAFE_BASE_IMAGE_PATTERNS is individually tested
    it('should match pattern 1: plain ubuntu version', () => {
      expect(validateAgentImage('ubuntu:18.04')).toEqual({ valid: true });
      expect(validateAgentImage('ubuntu:26.10')).toEqual({ valid: true });
    });

    it('should match pattern 2: catthehacker runner/full/act without digest', () => {
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:runner-18.04')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:full-26.10')).toEqual({ valid: true });
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:act-22.04')).toEqual({ valid: true });
    });

    it('should match pattern 3: catthehacker with SHA256 digest', () => {
      const digest = 'sha256:' + '1234567890abcdef'.repeat(4);
      expect(validateAgentImage(`ghcr.io/catthehacker/ubuntu:runner-22.04@${digest}`)).toEqual({ valid: true });
      expect(validateAgentImage(`ghcr.io/catthehacker/ubuntu:full-24.04@${digest}`)).toEqual({ valid: true });
      expect(validateAgentImage(`ghcr.io/catthehacker/ubuntu:act-22.04@${digest}`)).toEqual({ valid: true });
    });

    it('should match pattern 4: plain ubuntu with SHA256 digest', () => {
      const digest = 'sha256:' + 'abcdef1234567890'.repeat(4);
      expect(validateAgentImage(`ubuntu:22.04@${digest}`)).toEqual({ valid: true });
      expect(validateAgentImage(`ubuntu:24.04@${digest}`)).toEqual({ valid: true });
    });

    it('should reject images that almost match but do not exactly', () => {
      // Nearly matching but invalid
      expect(validateAgentImage('ubuntu:22.04 ').valid).toBe(false); // trailing space
      expect(validateAgentImage(' ubuntu:22.04').valid).toBe(false); // leading space
      expect(validateAgentImage('Ubuntu:22.04').valid).toBe(false); // capital U
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:Runner-22.04').valid).toBe(false); // capital R
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in image names', () => {
      expect(validateAgentImage('ubuntu:22.04;rm -rf /').valid).toBe(false);
      expect(validateAgentImage('ubuntu:22.04 && malicious').valid).toBe(false);
      expect(validateAgentImage('ubuntu:22.04|cat /etc/passwd').valid).toBe(false);
      expect(validateAgentImage('ubuntu:22.04`whoami`').valid).toBe(false);
    });

    it('should reject newlines and control characters', () => {
      expect(validateAgentImage('ubuntu:22.04\nmalicious').valid).toBe(false);
      expect(validateAgentImage('ubuntu:22.04\tmalicious').valid).toBe(false);
      expect(validateAgentImage('ubuntu:22.04\rmalicious').valid).toBe(false);
    });

    it('should reject URL-like injection attempts', () => {
      expect(validateAgentImage('http://evil.com/ubuntu:22.04').valid).toBe(false);
      expect(validateAgentImage('https://evil.com/image').valid).toBe(false);
    });

    it('should reject environment variable injection', () => {
      expect(validateAgentImage('ubuntu:$VERSION').valid).toBe(false);
      expect(validateAgentImage('ubuntu:${VERSION}').valid).toBe(false);
    });

    it('should reject images with multiple @ symbols', () => {
      expect(validateAgentImage('ubuntu:22.04@sha256:abc@sha256:def').valid).toBe(false);
    });

    it('should reject catthehacker with extra path segments', () => {
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu/extra:runner-22.04').valid).toBe(false);
      expect(validateAgentImage('ghcr.io/catthehacker/ubuntu:runner-22.04/extra').valid).toBe(false);
    });

    it('should accept valid edge case versions', () => {
      // High version numbers
      expect(validateAgentImage('ubuntu:99.99')).toEqual({ valid: true });
      // Single digit versions
      expect(validateAgentImage('ubuntu:1.04')).toEqual({ valid: true });
    });
  });
});

describe('processAgentImageOption', () => {
  describe('default preset', () => {
    it('should return default when no option provided', () => {
      const result = processAgentImageOption(undefined, false);
      expect(result.agentImage).toBe('default');
      expect(result.isPreset).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBeUndefined();
    });

    it('should return default when explicitly set', () => {
      const result = processAgentImageOption('default', false);
      expect(result.agentImage).toBe('default');
      expect(result.isPreset).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBeUndefined();
    });

    it('should work with --build-local', () => {
      const result = processAgentImageOption('default', true);
      expect(result.agentImage).toBe('default');
      expect(result.isPreset).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('act preset', () => {
    it('should return act preset with info message', () => {
      const result = processAgentImageOption('act', false);
      expect(result.agentImage).toBe('act');
      expect(result.isPreset).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBe('Using agent image preset: act (GitHub Actions parity)');
    });

    it('should work with --build-local', () => {
      const result = processAgentImageOption('act', true);
      expect(result.agentImage).toBe('act');
      expect(result.isPreset).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBe('Using agent image preset: act (GitHub Actions parity)');
    });
  });

  describe('custom images', () => {
    it('should require --build-local for custom images', () => {
      const result = processAgentImageOption('ubuntu:22.04', false);
      expect(result.agentImage).toBe('ubuntu:22.04');
      expect(result.isPreset).toBe(false);
      expect(result.requiresBuildLocal).toBe(true);
      expect(result.error).toContain('Custom agent images require --build-local flag');
    });

    it('should accept custom ubuntu image with --build-local', () => {
      const result = processAgentImageOption('ubuntu:22.04', true);
      expect(result.agentImage).toBe('ubuntu:22.04');
      expect(result.isPreset).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBe('Using custom agent base image: ubuntu:22.04');
    });

    it('should accept catthehacker runner image with --build-local', () => {
      const result = processAgentImageOption('ghcr.io/catthehacker/ubuntu:runner-22.04', true);
      expect(result.agentImage).toBe('ghcr.io/catthehacker/ubuntu:runner-22.04');
      expect(result.isPreset).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toBe('Using custom agent base image: ghcr.io/catthehacker/ubuntu:runner-22.04');
    });

    it('should accept catthehacker full image with --build-local', () => {
      const result = processAgentImageOption('ghcr.io/catthehacker/ubuntu:full-24.04', true);
      expect(result.agentImage).toBe('ghcr.io/catthehacker/ubuntu:full-24.04');
      expect(result.isPreset).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.infoMessage).toContain('full-24.04');
    });

    it('should accept image with SHA256 digest with --build-local', () => {
      const image = 'ubuntu:22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1';
      const result = processAgentImageOption(image, true);
      expect(result.agentImage).toBe(image);
      expect(result.isPreset).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });

  describe('invalid images', () => {
    it('should return error for invalid image', () => {
      const result = processAgentImageOption('malicious:image', false);
      expect(result.error).toContain('Invalid agent image');
      expect(result.isPreset).toBe(false);
    });

    it('should return error for invalid image even with --build-local', () => {
      const result = processAgentImageOption('malicious:image', true);
      expect(result.error).toContain('Invalid agent image');
    });

    it('should return error for alpine image', () => {
      const result = processAgentImageOption('alpine:latest', true);
      expect(result.error).toContain('Invalid agent image');
    });
  });
});

describe('DEFAULT_*_API_TARGET constants', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_OPENAI_API_TARGET).toBe('api.openai.com');
    expect(DEFAULT_ANTHROPIC_API_TARGET).toBe('api.anthropic.com');
    expect(DEFAULT_COPILOT_API_TARGET).toBe('api.githubcopilot.com');
    expect(DEFAULT_GEMINI_API_TARGET).toBe('generativelanguage.googleapis.com');
  });
});
