import { Command } from 'commander';
import {
  parseEnvironmentVariables,
  escapeShellArg,
  joinShellArgs,
  parseVolumeMounts,
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
  validateSkipPullWithBuildLocal,
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableOpenCodeFlag,
  hasRateLimitOptions,
  validateAllowHostPorts,
  validateAllowHostServicePorts,
  applyHostServicePortsConfig,
  parseMemoryLimit,
  parseAgentTimeout,
  applyAgentTimeout,
  collectRulesetFile,
  checkDockerHost,
  formatItem,
} from './option-parsers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('environment variable parsing', () => {
  it('should parse KEY=VALUE format correctly', () => {
    const envVars = ['GITHUB_TOKEN=abc123', 'API_KEY=xyz789'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        GITHUB_TOKEN: 'abc123',
        API_KEY: 'xyz789',
      });
    }
  });

  it('should handle empty values', () => {
    const envVars = ['EMPTY_VAR='];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        EMPTY_VAR: '',
      });
    }
  });

  it('should handle values with equals signs', () => {
    const envVars = ['BASE64_VAR=abc=def=ghi'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        BASE64_VAR: 'abc=def=ghi',
      });
    }
  });

  it('should reject invalid format (no equals sign)', () => {
    const envVars = ['INVALID_VAR'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidVar).toBe('INVALID_VAR');
    }
  });

  it('should handle empty array', () => {
    const envVars: string[] = [];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({});
    }
  });

  it('should return error on first invalid entry', () => {
    const envVars = ['VALID_VAR=value', 'INVALID_VAR', 'ANOTHER_VALID=value2'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidVar).toBe('INVALID_VAR');
    }
  });
});

describe('shell argument escaping', () => {
  it('should not escape simple arguments', () => {
    expect(escapeShellArg('curl')).toBe('curl');
    expect(escapeShellArg('https://api.github.com')).toBe('https://api.github.com');
    expect(escapeShellArg('/usr/bin/node')).toBe('/usr/bin/node');
    expect(escapeShellArg('--log-level=debug')).toBe('--log-level=debug');
  });

  it('should escape arguments with spaces', () => {
    expect(escapeShellArg('hello world')).toBe("'hello world'");
    expect(escapeShellArg('Authorization: Bearer token')).toBe("'Authorization: Bearer token'");
  });

  it('should escape arguments with special characters', () => {
    expect(escapeShellArg('test$var')).toBe("'test$var'");
    expect(escapeShellArg('test`cmd`')).toBe("'test`cmd`'");
    expect(escapeShellArg('test;echo')).toBe("'test;echo'");
  });

  it('should escape single quotes in arguments', () => {
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
    expect(escapeShellArg("don't")).toBe("'don'\\''t'");
  });

  it('should join multiple arguments with proper escaping', () => {
    expect(joinShellArgs(['curl', 'https://api.github.com'])).toBe('curl https://api.github.com');
    expect(joinShellArgs(['curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']))
      .toBe("curl -H 'Authorization: Bearer token' https://api.github.com");
    expect(joinShellArgs(['echo', 'hello world', 'test']))
      .toBe("echo 'hello world' test");
  });
});

describe('command argument handling with variables', () => {
  it('should preserve $ in single argument for container expansion', () => {
    // Single argument - passed through for container expansion
    const args = ['echo $HOME && echo $USER'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('echo $HOME && echo $USER');
    // $ signs will be escaped to $$ by Docker Compose generator
  });

  it('should escape arguments when multiple provided', () => {
    // Multiple arguments - each escaped
    const args = ['echo', '$HOME', '&&', 'echo', '$USER'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe("echo '$HOME' '&&' echo '$USER'");
    // Now $ signs are quoted, won't expand
  });

  it('should handle GitHub Actions style commands', () => {
    // Simulates: awf -- 'cd $GITHUB_WORKSPACE && npm test'
    const args = ['cd $GITHUB_WORKSPACE && npm test'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('cd $GITHUB_WORKSPACE && npm test');
  });

  it('should preserve command substitution', () => {
    // Simulates: awf -- 'echo $(pwd) && echo $(whoami)'
    const args = ['echo $(pwd) && echo $(whoami)'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('echo $(pwd) && echo $(whoami)');
  });
});

describe('volume mount parsing', () => {
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

  it('should parse valid mount with read-write mode', () => {
    const mounts = [`${testDir}:/workspace:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/workspace:rw`]);
    }
  });

  it('should parse valid mount with read-only mode', () => {
    const mounts = [`${testDir}:/data:ro`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/data:ro`]);
    }
  });

  it('should parse valid mount without mode (defaults to rw)', () => {
    const mounts = [`${testDir}:/app`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/app`]);
    }
  });

  it('should parse multiple valid mounts', () => {
    const subdir1 = path.join(testDir, 'dir1');
    const subdir2 = path.join(testDir, 'dir2');
    fs.mkdirSync(subdir1);
    fs.mkdirSync(subdir2);

    const mounts = [`${subdir1}:/workspace:ro`, `${subdir2}:/data:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${subdir1}:/workspace:ro`, `${subdir2}:/data:rw`]);
    }
  });

  it('should reject mount with too few parts', () => {
    const mounts = ['/workspace'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('/workspace');
      expect(result.reason).toContain('host_path:container_path[:mode]');
    }
  });

  it('should reject mount with too many parts', () => {
    const mounts = [`${testDir}:/workspace:rw:extra`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:/workspace:rw:extra`);
      expect(result.reason).toContain('host_path:container_path[:mode]');
    }
  });

  it('should reject mount with empty host path', () => {
    const mounts = [':/workspace:rw'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(':/workspace:rw');
      expect(result.reason).toContain('Host path cannot be empty');
    }
  });

  it('should reject mount with empty container path', () => {
    const mounts = [`${testDir}::rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}::rw`);
      expect(result.reason).toContain('Container path cannot be empty');
    }
  });

  it('should reject mount with relative host path', () => {
    const mounts = ['./relative/path:/workspace:rw'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('./relative/path:/workspace:rw');
      expect(result.reason).toContain('Host path must be absolute');
    }
  });

  it('should reject mount with relative container path', () => {
    const mounts = [`${testDir}:relative/path:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:relative/path:rw`);
      expect(result.reason).toContain('Container path must be absolute');
    }
  });

  it('should reject mount with invalid mode', () => {
    const mounts = [`${testDir}:/workspace:invalid`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:/workspace:invalid`);
      expect(result.reason).toContain('Mount mode must be either "ro" or "rw"');
    }
  });

  it('should reject mount with non-existent host path', () => {
    const nonExistentPath = '/tmp/this-path-definitely-does-not-exist-12345';
    const mounts = [`${nonExistentPath}:/workspace:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${nonExistentPath}:/workspace:rw`);
      expect(result.reason).toContain('Host path does not exist');
    }
  });

  it('should handle empty array', () => {
    const mounts: string[] = [];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([]);
    }
  });

  it('should return error on first invalid entry', () => {
    const subdir = path.join(testDir, 'valid');
    fs.mkdirSync(subdir);

    const mounts = [`${subdir}:/workspace:ro`, 'invalid-mount', `${testDir}:/data:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('invalid-mount');
    }
  });
});

describe('DNS servers parsing', () => {
  it('should parse valid IPv4 DNS servers', () => {
    const result = parseDnsServers('8.8.8.8,8.8.4.4');
    expect(result).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('should parse single DNS server', () => {
    const result = parseDnsServers('1.1.1.1');
    expect(result).toEqual(['1.1.1.1']);
  });

  it('should parse mixed IPv4 and IPv6 DNS servers', () => {
    const result = parseDnsServers('8.8.8.8,2001:4860:4860::8888');
    expect(result).toEqual(['8.8.8.8', '2001:4860:4860::8888']);
  });

  it('should trim whitespace from DNS servers', () => {
    const result = parseDnsServers('  8.8.8.8  ,  1.1.1.1  ');
    expect(result).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('should filter empty entries', () => {
    const result = parseDnsServers('8.8.8.8,,1.1.1.1,');
    expect(result).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('should throw error for invalid IP address', () => {
    expect(() => parseDnsServers('invalid.dns.server')).toThrow('Invalid DNS server IP address');
  });

  it('should throw error for empty input', () => {
    expect(() => parseDnsServers('')).toThrow('At least one DNS server must be specified');
  });

  it('should throw error for whitespace-only input', () => {
    expect(() => parseDnsServers('  ,  ,  ')).toThrow('At least one DNS server must be specified');
  });

  it('should throw error if any server is invalid', () => {
    expect(() => parseDnsServers('8.8.8.8,invalid,1.1.1.1')).toThrow('Invalid DNS server IP address: invalid');
  });
});

describe('parseDnsOverHttps', () => {
  it('should return undefined when value is undefined', () => {
    expect(parseDnsOverHttps(undefined)).toBeUndefined();
  });

  it('should return default Google resolver when value is true (flag without argument)', () => {
    const result = parseDnsOverHttps(true);
    expect(result).toEqual({ url: 'https://dns.google/dns-query' });
  });

  it('should return custom resolver URL when provided', () => {
    const result = parseDnsOverHttps('https://cloudflare-dns.com/dns-query');
    expect(result).toEqual({ url: 'https://cloudflare-dns.com/dns-query' });
  });

  it('should return error for non-https URL', () => {
    const result = parseDnsOverHttps('http://dns.google/dns-query');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });

  it('should return error for plain string without https prefix', () => {
    const result = parseDnsOverHttps('dns.google');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });
});

describe('processLocalhostKeyword', () => {
  describe('when localhost keyword is not present', () => {
    it('should return domains unchanged', () => {
      const result = processLocalhostKeyword(
        ['github.com', 'example.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(false);
      expect(result.allowedDomains).toEqual(['github.com', 'example.com']);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('when plain localhost is present', () => {
    it('should replace localhost with host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });

    it('should replace localhost when it is the only domain', () => {
      const result = processLocalhostKeyword(
        ['localhost'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
    });
  });

  describe('when http://localhost is present', () => {
    it('should replace with http://host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['http://localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'http://host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when https://localhost is present', () => {
    it('should replace with https://host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['https://localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'https://host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when host access is already enabled', () => {
    it('should not suggest enabling host access again', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        true, // Already enabled
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when custom ports are already specified', () => {
    it('should not suggest default ports', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        false,
        '8080,9000' // Custom ports
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('when both host access and custom ports are specified', () => {
    it('should not suggest either', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        true, // Already enabled
        '8080' // Custom ports
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should only replace first occurrence of localhost', () => {
      // Although unlikely, the function should handle this gracefully
      const result = processLocalhostKeyword(
        ['localhost', 'github.com', 'http://localhost'],
        false,
        undefined
      );

      // Should only replace the first match
      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'http://localhost', 'host.docker.internal']);
    });

    it('should preserve domain order', () => {
      const result = processLocalhostKeyword(
        ['github.com', 'localhost', 'example.com'],
        false,
        undefined
      );

      expect(result.allowedDomains).toEqual(['github.com', 'example.com', 'host.docker.internal']);
    });

    it('should handle empty domains list', () => {
      const result = processLocalhostKeyword(
        [],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(false);
      expect(result.allowedDomains).toEqual([]);
    });
  });
});

describe('validateSkipPullWithBuildLocal', () => {
  it('should return valid when both flags are false', () => {
    const result = validateSkipPullWithBuildLocal(false, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when both flags are undefined', () => {
    const result = validateSkipPullWithBuildLocal(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only skipPull is true', () => {
    const result = validateSkipPullWithBuildLocal(true, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(false, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return invalid when both skipPull and buildLocal are true', () => {
    const result = validateSkipPullWithBuildLocal(true, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--skip-pull cannot be used with --build-local');
  });

  it('should return valid when skipPull is true and buildLocal is undefined', () => {
    const result = validateSkipPullWithBuildLocal(true, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when skipPull is undefined and buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(undefined, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('buildRateLimitConfig', () => {
  it('should return defaults when no options provided', () => {
    const r = buildRateLimitConfig({});
    expect('config' in r).toBe(true);
    if ('config' in r) { expect(r.config).toEqual({ enabled: false, rpm: 0, rph: 0, bytesPm: 0 }); }
  });
  it('should disable with rateLimit=false even if limits provided', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); }
  });
  it('should enable and parse custom RPM', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rpm).toBe(30); }
  });
  it('should enable and parse custom RPH', () => {
    const r = buildRateLimitConfig({ rateLimitRph: '500' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rph).toBe(500); }
  });
  it('should enable and parse custom bytes-pm', () => {
    const r = buildRateLimitConfig({ rateLimitBytesPm: '1000000' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.bytesPm).toBe(1000000); }
  });
  it('should error on negative RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '-5' })).toBe(true);
  });
  it('should error on zero RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '0' })).toBe(true);
  });
  it('should error on non-integer RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: 'abc' })).toBe(true);
  });
  it('should error on negative RPH', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRph: '-1' })).toBe(true);
  });
  it('should error on negative bytes-pm', () => {
    expect('error' in buildRateLimitConfig({ rateLimitBytesPm: '-100' })).toBe(true);
  });
  it('should ignore custom values when disabled via --no-rate-limit', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '999' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); expect(r.config.rpm).toBe(0); }
  });
  it('should accept all custom values', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '10', rateLimitRph: '100', rateLimitBytesPm: '5000000' });
    if ('config' in r) { expect(r.config).toEqual({ enabled: true, rpm: 10, rph: 100, bytesPm: 5000000 }); }
  });
});

describe('validateRateLimitFlags', () => {
  it('should pass when api proxy is enabled', () => {
    expect(validateRateLimitFlags(true, { rateLimitRpm: '30' })).toEqual({ valid: true });
  });
  it('should pass when no rate limit flags used', () => {
    expect(validateRateLimitFlags(false, {})).toEqual({ valid: true });
  });
  it('should fail when --rate-limit-rpm used without api proxy', () => {
    const r = validateRateLimitFlags(false, { rateLimitRpm: '30' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
  it('should fail when --rate-limit-rph used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitRph: '100' }).valid).toBe(false);
  });
  it('should fail when --rate-limit-bytes-pm used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitBytesPm: '1000' }).valid).toBe(false);
  });
  it('should fail when --no-rate-limit used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimit: false }).valid).toBe(false);
  });
  it('should pass when all flags used with api proxy enabled', () => {
    const r = validateRateLimitFlags(true, { rateLimitRpm: '10', rateLimitRph: '100', rateLimit: false });
    expect(r.valid).toBe(true);
  });
});

describe('validateEnableOpenCodeFlag', () => {
  it('should pass when both --enable-opencode and --enable-api-proxy are set', () => {
    expect(validateEnableOpenCodeFlag(true, true)).toEqual({ valid: true });
  });
  it('should pass when --enable-opencode is false', () => {
    expect(validateEnableOpenCodeFlag(false, false)).toEqual({ valid: true });
  });
  it('should pass when --enable-opencode is false and --enable-api-proxy is true', () => {
    expect(validateEnableOpenCodeFlag(true, false)).toEqual({ valid: true });
  });
  it('should fail when --enable-opencode is true without --enable-api-proxy', () => {
    const r = validateEnableOpenCodeFlag(false, true);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
});

describe('hasRateLimitOptions', () => {
  it('should return false when no rate limit options set', () => {
    expect(hasRateLimitOptions({})).toBe(false);
  });

  it('should return true when rateLimitRpm is set', () => {
    expect(hasRateLimitOptions({ rateLimitRpm: '30' })).toBe(true);
  });

  it('should return true when rateLimitRph is set', () => {
    expect(hasRateLimitOptions({ rateLimitRph: '1000' })).toBe(true);
  });

  it('should return true when rateLimitBytesPm is set', () => {
    expect(hasRateLimitOptions({ rateLimitBytesPm: '1048576' })).toBe(true);
  });

  it('should return true when rateLimit is explicitly false (--no-rate-limit)', () => {
    expect(hasRateLimitOptions({ rateLimit: false })).toBe(true);
  });

  it('should return false when rateLimit is true', () => {
    expect(hasRateLimitOptions({ rateLimit: true })).toBe(false);
  });
});

describe('validateAllowHostPorts', () => {
  it('should fail when --allow-host-ports is used without --enable-host-access', () => {
    const result = validateAllowHostPorts('3000', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should fail when --allow-host-ports is used with enableHostAccess=false', () => {
    const result = validateAllowHostPorts('8080', false);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should pass when --allow-host-ports is used with --enable-host-access', () => {
    const result = validateAllowHostPorts('3000', true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass when --allow-host-ports is not provided', () => {
    const result = validateAllowHostPorts(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass when only --enable-host-access is set without ports', () => {
    const result = validateAllowHostPorts(undefined, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should fail for port ranges without --enable-host-access', () => {
    const result = validateAllowHostPorts('3000-3010,8080', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should pass for port ranges with --enable-host-access', () => {
    const result = validateAllowHostPorts('3000-3010,8000-8090', true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('validateAllowHostServicePorts', () => {
  it('should pass when no service ports are provided', () => {
    const result = validateAllowHostServicePorts(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.autoEnableHostAccess).toBeUndefined();
  });

  it('should pass for valid single port', () => {
    const result = validateAllowHostServicePorts('5432', undefined);
    expect(result.valid).toBe(true);
  });

  it('should pass for valid multiple ports', () => {
    const result = validateAllowHostServicePorts('5432,6379,3306', undefined);
    expect(result.valid).toBe(true);
  });

  it('should auto-enable host access when not already enabled', () => {
    const result = validateAllowHostServicePorts('5432', undefined);
    expect(result.valid).toBe(true);
    expect(result.autoEnableHostAccess).toBe(true);
  });

  it('should auto-enable host access when enableHostAccess is false', () => {
    const result = validateAllowHostServicePorts('5432', false);
    expect(result.valid).toBe(true);
    expect(result.autoEnableHostAccess).toBe(true);
  });

  it('should not auto-enable host access when already enabled', () => {
    const result = validateAllowHostServicePorts('5432', true);
    expect(result.valid).toBe(true);
    expect(result.autoEnableHostAccess).toBe(false);
  });

  it('should fail for non-numeric port', () => {
    const result = validateAllowHostServicePorts('abc', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid port');
    expect(result.error).toContain('Must be a numeric value');
  });

  it('should fail for port with letters mixed in', () => {
    const result = validateAllowHostServicePorts('54a32', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Must be a numeric value');
  });

  it('should fail for port 0', () => {
    const result = validateAllowHostServicePorts('0', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Must be a number between 1 and 65535');
  });

  it('should fail for port above 65535', () => {
    const result = validateAllowHostServicePorts('65536', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Must be a number between 1 and 65535');
  });

  it('should fail if any port in comma-separated list is invalid', () => {
    const result = validateAllowHostServicePorts('5432,abc,6379', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('abc');
  });

  it('should allow dangerous ports (by design, for host-local services)', () => {
    // Ports like 22 (SSH), 25 (SMTP), 5432 (Postgres), 6379 (Redis) are allowed
    // because they are restricted to host gateway only
    const result = validateAllowHostServicePorts('22,25,5432,6379,27017', undefined);
    expect(result.valid).toBe(true);
  });

  it('should handle ports with whitespace around them', () => {
    const result = validateAllowHostServicePorts(' 5432 , 6379 ', undefined);
    expect(result.valid).toBe(true);
  });

  it('should pass for port 1 (minimum valid)', () => {
    const result = validateAllowHostServicePorts('1', undefined);
    expect(result.valid).toBe(true);
  });

  it('should pass for port 65535 (maximum valid)', () => {
    const result = validateAllowHostServicePorts('65535', undefined);
    expect(result.valid).toBe(true);
  });

  it('should fail for negative port number', () => {
    const result = validateAllowHostServicePorts('-1', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Must be a numeric value');
  });

  it('should fail for decimal port number', () => {
    const result = validateAllowHostServicePorts('80.5', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Must be a numeric value');
  });
});

describe('applyHostServicePortsConfig', () => {
  let warnings: string[];
  let infos: string[];
  let mockLog: { warn: (msg: string) => void; info: (msg: string) => void };

  beforeEach(() => {
    warnings = [];
    infos = [];
    mockLog = {
      warn: (msg: string) => warnings.push(msg),
      info: (msg: string) => infos.push(msg),
    };
  });

  it('should return valid with no changes when no service ports provided', () => {
    const result = applyHostServicePortsConfig(undefined, undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBeUndefined();
    }
    expect(warnings).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  it('should return error for invalid port', () => {
    const result = applyHostServicePortsConfig('abc', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid port');
    }
  });

  it('should auto-enable host access and emit warnings when ports provided without host access', () => {
    const result = applyHostServicePortsConfig('5432,6379', undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('bypasses dangerous port restrictions');
    expect(warnings[1]).toContain('Ensure host services');
    expect(warnings[2]).toContain('automatically enabling host access');
    expect(warnings[2]).toContain('80/443');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('5432,6379');
  });

  it('should not auto-enable host access when already enabled', () => {
    const result = applyHostServicePortsConfig('5432', true, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    // Should still warn but not log auto-enable message
    expect(warnings).toHaveLength(2);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('5432');
  });

  it('should auto-enable host access when enableHostAccess is false', () => {
    const result = applyHostServicePortsConfig('3306', false, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    expect(warnings.some(m => m.includes('automatically enabling'))).toBe(true);
  });

  it('should return error for out-of-range port', () => {
    const result = applyHostServicePortsConfig('70000', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a number between 1 and 65535');
    }
  });
});

describe('parseMemoryLimit', () => {
  it('accepts valid memory limits', () => {
    expect(parseMemoryLimit('2g')).toEqual({ value: '2g' });
    expect(parseMemoryLimit('4g')).toEqual({ value: '4g' });
    expect(parseMemoryLimit('512m')).toEqual({ value: '512m' });
    expect(parseMemoryLimit('1024k')).toEqual({ value: '1024k' });
    expect(parseMemoryLimit('8G')).toEqual({ value: '8g' });
  });

  it('rejects invalid formats', () => {
    expect(parseMemoryLimit('abc')).toHaveProperty('error');
    expect(parseMemoryLimit('-1g')).toHaveProperty('error');
    expect(parseMemoryLimit('2x')).toHaveProperty('error');
    expect(parseMemoryLimit('')).toHaveProperty('error');
    expect(parseMemoryLimit('g')).toHaveProperty('error');
  });

  it('rejects zero', () => {
    expect(parseMemoryLimit('0g')).toHaveProperty('error');
  });
});

describe('parseAgentTimeout', () => {
  it('should parse a valid positive integer', () => {
    const result = parseAgentTimeout('30');
    expect(result).toEqual({ minutes: 30 });
  });

  it('should parse single minute timeout', () => {
    const result = parseAgentTimeout('1');
    expect(result).toEqual({ minutes: 1 });
  });

  it('should return error for zero', () => {
    const result = parseAgentTimeout('0');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should return error for negative value', () => {
    const result = parseAgentTimeout('-5');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should return error for non-numeric string', () => {
    const result = parseAgentTimeout('abc');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should return error for empty string', () => {
    const result = parseAgentTimeout('');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should parse large timeout values', () => {
    const result = parseAgentTimeout('1440');
    expect(result).toEqual({ minutes: 1440 });
  });

  it('should return error for value with trailing non-numeric characters', () => {
    const result = parseAgentTimeout('30m');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should return error for decimal value', () => {
    const result = parseAgentTimeout('1.5');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });

  it('should return error for value with leading zero', () => {
    const result = parseAgentTimeout('030');
    expect(result).toEqual({ error: '--agent-timeout must be a positive integer (minutes)' });
  });
});

describe('applyAgentTimeout', () => {
  it('should do nothing when agentTimeout is undefined', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    applyAgentTimeout(undefined, config, logger);
    expect(config.agentTimeout).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should set agentTimeout on config for valid value', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    applyAgentTimeout('30', config, logger);
    expect(config.agentTimeout).toBe(30);
    expect(logger.info).toHaveBeenCalledWith('Agent timeout set to 30 minutes');
  });

  it('should call process.exit for invalid value', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    applyAgentTimeout('abc', config, logger);
    expect(logger.error).toHaveBeenCalledWith('--agent-timeout must be a positive integer (minutes)');
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});

describe('collectRulesetFile', () => {
  it('should accumulate multiple values into an array', () => {
    let result = collectRulesetFile('a.yml');
    result = collectRulesetFile('b.yml', result);
    expect(result).toEqual(['a.yml', 'b.yml']);
  });

  it('should default to empty array when no previous values', () => {
    const result = collectRulesetFile('first.yml');
    expect(result).toEqual(['first.yml']);
  });

  it('should work with Commander option parsing', () => {
    const testProgram = new Command();
    testProgram
      .option('--ruleset-file <path>', 'YAML rule file', collectRulesetFile, [])
      .action(() => {});

    testProgram.parse(['node', 'awf', '--ruleset-file', 'a.yml', '--ruleset-file', 'b.yml'], { from: 'node' });
    const opts = testProgram.opts();
    expect(opts.rulesetFile).toEqual(['a.yml', 'b.yml']);
  });

  it('should default to empty array when not provided', () => {
    const testProgram = new Command();
    testProgram
      .option('--ruleset-file <path>', 'YAML rule file', collectRulesetFile, [])
      .action(() => {});

    testProgram.parse(['node', 'awf'], { from: 'node' });
    const opts = testProgram.opts();
    expect(opts.rulesetFile).toEqual([]);
  });
});

describe('checkDockerHost', () => {
  it('should return valid when DOCKER_HOST is not set', () => {
    const result = checkDockerHost({});
    expect(result.valid).toBe(true);
  });

  it('should return valid when DOCKER_HOST is undefined', () => {
    const result = checkDockerHost({ DOCKER_HOST: undefined });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the default /var/run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///var/run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the /run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return invalid for a TCP daemon (workflow-scope DinD)', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2375' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('tcp://localhost:2375');
      expect(result.error).toContain('external daemon');
      expect(result.error).toContain('network isolation model');
    }
  });

  it('should return invalid for a TCP daemon on a non-default port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2376' });
    expect(result.valid).toBe(false);
  });

  it('should return valid for a non-standard unix socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///tmp/custom-docker.sock' });
    expect(result.valid).toBe(true);
  });
});

describe('formatItem', () => {
  it('should format item with description on same line when term fits', () => {
    const result = formatItem('-v', 'verbose output', 20, 2, 2, 80);
    expect(result).toBe('  -v                    verbose output');
  });

  it('should format item with description on next line when term is long', () => {
    const result = formatItem('--very-long-option-name-here', 'desc', 10, 2, 2, 80);
    expect(result).toContain('--very-long-option-name-here');
    expect(result).toContain('\n');
    expect(result).toContain('desc');
  });

  it('should format item without description', () => {
    const result = formatItem('--flag', '', 20, 2, 2, 80);
    expect(result).toBe('  --flag');
  });

  it('should format term with description when term fits within width', () => {
    const result = formatItem('--flag', 'Description text', 20, 2, 2, 80);
    expect(result).toBe('  --flag                Description text');
  });

  it('should wrap description to next line when term exceeds width', () => {
    const result = formatItem('--very-long-flag-name-that-exceeds-width', 'Description', 10, 2, 2, 80);
    expect(result).toContain('--very-long-flag-name-that-exceeds-width\n');
    expect(result).toContain('Description');
  });
});
