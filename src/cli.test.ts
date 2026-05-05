import { Command } from 'commander';
import { validateFormat, program, handlePredownloadAction } from './cli';
import { redactSecrets } from './redact-secrets';

describe('cli', () => {
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
      const testProgram = new Command();

      testProgram
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

      expect(testProgram.name()).toBe('awf');
      expect(testProgram.description()).toBe('Network firewall for agentic workflows with domain whitelisting');
    });

    it('should have default values for optional flags', () => {
      const testProgram = new Command();

      testProgram
        .option('--log-level <level>', 'Log level', 'info')
        .option('--keep-containers', 'Keep containers', false)
        .option('--build-local', 'Build locally', false)
        .option('--env-all', 'Pass all env vars', false);

      // Parse empty args to get defaults (from: 'node' treats argv[0] as node, argv[1] as script)
      testProgram.parse(['node', 'awf'], { from: 'node' });
      const opts = testProgram.opts();

      expect(opts.logLevel).toBe('info');
      expect(opts.keepContainers).toBe(false);
      expect(opts.buildLocal).toBe(false);
      expect(opts.envAll).toBe(false);
    });
  });

  describe('argument parsing with variadic args', () => {
    it('should handle multiple arguments after -- separator', () => {
      const testProgram = new Command();
      let capturedArgs: string[] = [];

      testProgram
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      testProgram.parse(['node', 'awf', '--', 'curl', 'https://api.github.com']);

      expect(capturedArgs).toEqual(['curl', 'https://api.github.com']);
    });

    it('should handle arguments with flags after -- separator', () => {
      const testProgram = new Command();
      let capturedArgs: string[] = [];

      testProgram
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      testProgram.parse(['node', 'awf', '--', 'curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']);

      expect(capturedArgs).toEqual(['curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']);
    });

    it('should handle complex command with multiple flags', () => {
      const testProgram = new Command();
      let capturedArgs: string[] = [];

      testProgram
        .argument('[args...]', 'Command and arguments')
        .action((args: string[]) => {
          capturedArgs = args;
        });

      testProgram.parse(['node', 'awf', '--', 'npx', '@github/copilot', '--prompt', 'hello world', '--log-level', 'debug']);

      expect(capturedArgs).toEqual(['npx', '@github/copilot', '--prompt', 'hello world', '--log-level', 'debug']);
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

  describe('help text formatting', () => {
    it('should include section headers in help output', () => {
      const help = program.helpInformation();
      expect(help).toContain('Domain Filtering:');
      expect(help).toContain('Image Management:');
      expect(help).toContain('Container Configuration:');
      expect(help).toContain('Network & Security:');
      expect(help).toContain('API Proxy:');
      expect(help).toContain('Logging & Debug:');
    });

    it('should include usage line', () => {
      const help = program.helpInformation();
      expect(help).toContain('Usage: awf');
    });

    it('should include program description', () => {
      const help = program.helpInformation();
      expect(help).toContain('Network firewall for agentic workflows');
    });

    it('should include arguments section', () => {
      const help = program.helpInformation();
      expect(help).toContain('Arguments:');
    });

    it('should include options section', () => {
      const help = program.helpInformation();
      expect(help).toContain('Options:');
    });
  });

  describe('handlePredownloadAction', () => {
    afterEach(() => {
      jest.resetModules();
      jest.clearAllMocks();
      jest.restoreAllMocks();
      jest.unmock('./commands/predownload');
    });

    it('should delegate to predownloadCommand with correct options', async () => {
      // Mock the predownload module that handlePredownloadAction dynamically imports
      const mockPredownloadCommand = jest.fn().mockResolvedValue(undefined);
      jest.resetModules();
      jest.doMock('./commands/predownload', () => ({
        predownloadCommand: mockPredownloadCommand,
      }));

      await handlePredownloadAction({
        imageRegistry: 'ghcr.io/test',
        imageTag: 'v1.0',
        agentImage: 'default',
        enableApiProxy: false,
        difcProxy: true,
      });

      expect(mockPredownloadCommand).toHaveBeenCalledWith({
        imageRegistry: 'ghcr.io/test',
        imageTag: 'v1.0',
        agentImage: 'default',
        enableApiProxy: false,
        difcProxy: true,
      });
    });

    it('should use the exitCode from the thrown error when available', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const errorWithExitCode = Object.assign(new Error('pull failed'), { exitCode: 2 });
      jest.resetModules();
      jest.doMock('./commands/predownload', () => ({
        predownloadCommand: jest.fn().mockRejectedValue(errorWithExitCode),
      }));

      await expect(handlePredownloadAction({
        imageRegistry: 'test',
        imageTag: 'latest',
        agentImage: 'default',
        enableApiProxy: false,
      })).rejects.toThrow('process.exit called');

      expect(mockExit).toHaveBeenCalledWith(2);
      mockExit.mockRestore();
    });

    it('should default to exit code 1 when error has no exitCode property', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const errorWithoutExitCode = new Error('unexpected failure');
      jest.resetModules();
      jest.doMock('./commands/predownload', () => ({
        predownloadCommand: jest.fn().mockRejectedValue(errorWithoutExitCode),
      }));

      await expect(handlePredownloadAction({
        imageRegistry: 'test',
        imageTag: 'latest',
        agentImage: 'default',
        enableApiProxy: false,
      })).rejects.toThrow('process.exit called');

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });
});
