import { Command } from 'commander';
import { parseEnvironmentVariables, parseDomains, parseDomainsFile, escapeShellArg, joinShellArgs, parseVolumeMounts, isValidIPv4, isValidIPv6, parseDnsServers, validateAgentImage, isAgentImagePreset, AGENT_IMAGE_PRESETS, processAgentImageOption, processLocalhostKeyword, validateSkipPullWithBuildLocal, validateFormat, validateApiProxyConfig, buildRateLimitConfig, validateRateLimitFlags } from './cli';
import { redactSecrets } from './redact-secrets';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('cli', () => {
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

  describe('secret redaction', () => {
    it('should redact Bearer tokens', () => {
      const command = 'curl -H "Authorization: Bearer ghp_1234567890abcdef" https://api.github.com';
      const result = redactSecrets(command);

      // The regex captures quotes too, so the closing quote gets included in \S+
      expect(result).not.toContain('ghp_1234567890abcdef');
      expect(result).toContain('***REDACTED***');
    });

    it('should redact non-Bearer Authorization headers', () => {
      const command = 'curl -H "Authorization: token123" https://api.github.com';
      const result = redactSecrets(command);

      expect(result).not.toContain('token123');
      expect(result).toContain('***REDACTED***');
    });

    it('should redact GITHUB_TOKEN environment variable', () => {
      const command = 'GITHUB_TOKEN=ghp_abc123 npx @github/copilot';
      const result = redactSecrets(command);

      expect(result).toBe('GITHUB_TOKEN=***REDACTED*** npx @github/copilot');
      expect(result).not.toContain('ghp_abc123');
    });

    it('should redact API_KEY environment variable', () => {
      const command = 'API_KEY=secret123 npm run deploy';
      const result = redactSecrets(command);

      expect(result).toBe('API_KEY=***REDACTED*** npm run deploy');
      expect(result).not.toContain('secret123');
    });

    it('should redact PASSWORD environment variable', () => {
      const command = 'DB_PASSWORD=supersecret npm start';
      const result = redactSecrets(command);

      expect(result).toBe('DB_PASSWORD=***REDACTED*** npm start');
      expect(result).not.toContain('supersecret');
    });

    it('should redact GitHub personal access tokens', () => {
      const command = 'echo ghp_1234567890abcdefghijklmnopqrstuvwxyz0123';
      const result = redactSecrets(command);

      expect(result).toBe('echo ***REDACTED***');
      expect(result).not.toContain('ghp_');
    });

    it('should redact multiple secrets in one command', () => {
      const command = 'GITHUB_TOKEN=ghp_token API_KEY=secret curl -H "Authorization: Bearer ghp_bearer"';
      const result = redactSecrets(command);

      expect(result).not.toContain('ghp_token');
      expect(result).not.toContain('secret');
      expect(result).not.toContain('ghp_bearer');
      expect(result).toContain('***REDACTED***');
    });

    it('should not redact non-secret content', () => {
      const command = 'echo "Hello World" && ls -la';
      const result = redactSecrets(command);

      expect(result).toBe(command);
    });

    it('should handle mixed case environment variables', () => {
      const command = 'github_token=abc GitHub_TOKEN=def GiThUb_ToKeN=ghi';
      const result = redactSecrets(command);

      expect(result).toBe('github_token=***REDACTED*** GitHub_TOKEN=***REDACTED*** GiThUb_ToKeN=***REDACTED***');
    });
  });

  describe('log level validation', () => {
    const validLogLevels = ['debug', 'info', 'warn', 'error'];

    it('should accept valid log levels', () => {
      validLogLevels.forEach(level => {
        expect(validLogLevels.includes(level)).toBe(true);
      });
    });

    it('should reject invalid log levels', () => {
      const invalidLevels = ['verbose', 'trace', 'silent', 'all', ''];

      invalidLevels.forEach(level => {
        expect(validLogLevels.includes(level)).toBe(false);
      });
    });
  });

  describe('Commander.js program configuration', () => {
    it('should configure required options correctly', () => {
      const program = new Command();

      program
        .name('awf')
        .description('Network firewall for agentic workflows with domain whitelisting')
        .version('0.1.0')
        .requiredOption(
          '--allow-domains <domains>',
          'Comma-separated list of allowed domains'
        )
        .option('--log-level <level>', 'Log level: debug, info, warn, error', 'info')
        .option('--keep-containers', 'Keep containers running after command exits', false)
        .argument('[args...]', 'Command and arguments to execute');

      expect(program.name()).toBe('awf');
      expect(program.description()).toBe('Network firewall for agentic workflows with domain whitelisting');
    });

    it('should have default values for optional flags', () => {
      const program = new Command();

      program
        .option('--log-level <level>', 'Log level', 'info')
        .option('--keep-containers', 'Keep containers', false)
        .option('--build-local', 'Build locally', false)
        .option('--env-all', 'Pass all env vars', false);

      // Parse empty args to get defaults
      program.parse(['node', 'awf'], { from: 'user' });
      const opts = program.opts();

      expect(opts.logLevel).toBe('info');
      expect(opts.keepContainers).toBe(false);
      expect(opts.buildLocal).toBe(false);
      expect(opts.envAll).toBe(false);
    });
  });

  describe('argument parsing with variadic args', () => {
    it('should handle multiple arguments after -- separator', () => {
      const program = new Command();
      let capturedArgs: string[] = [];

      program
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      program.parse(['node', 'awf', '--', 'curl', 'https://api.github.com']);

      expect(capturedArgs).toEqual(['curl', 'https://api.github.com']);
    });

    it('should handle arguments with flags after -- separator', () => {
      const program = new Command();
      let capturedArgs: string[] = [];

      program
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      program.parse(['node', 'awf', '--', 'curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']);

      expect(capturedArgs).toEqual(['curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']);
    });

    it('should handle complex command with multiple flags', () => {
      const program = new Command();
      let capturedArgs: string[] = [];

      program
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      program.parse(['node', 'awf', '--', 'npx', '@github/copilot', '--prompt', 'hello world', '--log-level', 'debug']);

      expect(capturedArgs).toEqual(['npx', '@github/copilot', '--prompt', 'hello world', '--log-level', 'debug']);
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

  describe('work directory generation', () => {
    it('should generate unique work directories', () => {
      const dir1 = `/tmp/awf-${Date.now()}`;

      // Wait 1ms to ensure different timestamp
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      return delay(2).then(() => {
        const dir2 = `/tmp/awf-${Date.now()}`;

        expect(dir1).not.toBe(dir2);
        expect(dir1).toMatch(/^\/tmp\/awf-\d+$/);
        expect(dir2).toMatch(/^\/tmp\/awf-\d+$/);
      });
    });

    it('should use /tmp prefix', () => {
      const dir = `/tmp/awf-${Date.now()}`;

      expect(dir).toMatch(/^\/tmp\//);
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

  describe('DEFAULT_DNS_SERVERS', () => {
    it('should have correct default DNS servers', async () => {
      // Dynamic import to get the constant
      const { DEFAULT_DNS_SERVERS } = await import('./cli');
      expect(DEFAULT_DNS_SERVERS).toEqual(['8.8.8.8', '8.8.4.4']);
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

  describe('validateFormat', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    afterAll(() => {
      mockExit.mockRestore();
    });

    it('should not throw for valid formats', () => {
      expect(() => validateFormat('json', ['json', 'markdown', 'pretty'])).not.toThrow();
      expect(() => validateFormat('pretty', ['json', 'markdown', 'pretty'])).not.toThrow();
      expect(() => validateFormat('markdown', ['json', 'markdown', 'pretty'])).not.toThrow();
    });

    it('should exit with error for invalid format', () => {
      expect(() => validateFormat('xml', ['json', 'markdown', 'pretty'])).toThrow('process.exit called');
    });
  });

  describe('validateApiProxyConfig', () => {
    it('should return disabled when enableApiProxy is false', () => {
      const result = validateApiProxyConfig(false);
      expect(result.enabled).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.debugMessages).toEqual([]);
    });

    it('should warn when enabled but no API keys provided', () => {
      const result = validateApiProxyConfig(true);
      expect(result.enabled).toBe(true);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('no API keys found');
      expect(result.debugMessages).toEqual([]);
    });

    it('should warn when enabled with undefined keys', () => {
      const result = validateApiProxyConfig(true, undefined, undefined);
      expect(result.enabled).toBe(true);
      expect(result.warnings).toHaveLength(2);
    });

    it('should detect OpenAI key', () => {
      const result = validateApiProxyConfig(true, true);
      expect(result.enabled).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.debugMessages).toHaveLength(1);
      expect(result.debugMessages[0]).toContain('OpenAI');
    });

    it('should detect Anthropic key', () => {
      const result = validateApiProxyConfig(true, false, true);
      expect(result.enabled).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.debugMessages).toHaveLength(1);
      expect(result.debugMessages[0]).toContain('Anthropic');
    });

    it('should detect both keys', () => {
      const result = validateApiProxyConfig(true, true, true);
      expect(result.enabled).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.debugMessages).toHaveLength(2);
      expect(result.debugMessages[0]).toContain('OpenAI');
      expect(result.debugMessages[1]).toContain('Anthropic');
    });

    it('should not warn when disabled even with keys', () => {
      const result = validateApiProxyConfig(false, true, true);
      expect(result.enabled).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.debugMessages).toEqual([]);
    });
  });

  describe('buildRateLimitConfig', () => {
    it('should return defaults when no options provided', () => {
      const r = buildRateLimitConfig({});
      expect('config' in r).toBe(true);
      if ('config' in r) { expect(r.config).toEqual({ enabled: true, rpm: 60, rph: 1000, bytesPm: 52428800 }); }
    });
    it('should disable with rateLimit=false', () => {
      const r = buildRateLimitConfig({ rateLimit: false });
      if ('config' in r) { expect(r.config.enabled).toBe(false); }
    });
    it('should parse custom RPM', () => {
      const r = buildRateLimitConfig({ rateLimitRpm: '30' });
      if ('config' in r) { expect(r.config.rpm).toBe(30); }
    });
    it('should parse custom RPH', () => {
      const r = buildRateLimitConfig({ rateLimitRph: '500' });
      if ('config' in r) { expect(r.config.rph).toBe(500); }
    });
    it('should parse custom bytes-pm', () => {
      const r = buildRateLimitConfig({ rateLimitBytesPm: '1000000' });
      if ('config' in r) { expect(r.config.bytesPm).toBe(1000000); }
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
    it('should ignore custom values when disabled', () => {
      const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '999' });
      if ('config' in r) { expect(r.config.rpm).toBe(60); }
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
});
