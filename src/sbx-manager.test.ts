import {
  createSandbox,
  execInSandbox,
  isSbxAvailable,
  removeSandbox,
  sanitizeEnvForSbx,
  SBX_DEFAULT_NAME,
} from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);

describe('sbx-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeEnvForSbx', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        MY_SECRET_TOKEN: 'secret',
        GITHUB_TOKEN: 'ghp_123',
        API_KEY: 'key123',
        AWS_SECRET_ACCESS_KEY: 'awssecret',
        PASSWORD: 'pass',
        DOCKER_PAT: 'pat',
        DOCKER_USERNAME: 'user',
        SAFE_VAR: 'safe',
      };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('removes TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL, PAT env vars', () => {
      const result = sanitizeEnvForSbx();
      expect(result).not.toHaveProperty('MY_SECRET_TOKEN');
      expect(result).not.toHaveProperty('GITHUB_TOKEN');
      expect(result).not.toHaveProperty('API_KEY');
      expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(result).not.toHaveProperty('PASSWORD');
      expect(result).not.toHaveProperty('DOCKER_PAT');
      expect(result).not.toHaveProperty('DOCKER_USERNAME');
    });

    it('keeps non-secret env vars', () => {
      const result = sanitizeEnvForSbx();
      expect(result.PATH).toBe('/usr/bin');
      expect(result.HOME).toBe('/home/runner');
      expect(result.SAFE_VAR).toBe('safe');
    });

    it('merges overrides and they take precedence', () => {
      const result = sanitizeEnvForSbx({ EXTRA: 'extra', PATH: '/custom' });
      expect(result.EXTRA).toBe('extra');
      expect(result.PATH).toBe('/custom');
    });

    it('overrides take precedence even for secret-like key names', () => {
      // Overrides are applied after filtering, so explicit overrides DO appear
      const result = sanitizeEnvForSbx({ MY_TOKEN: 'override' });
      expect(result.MY_TOKEN).toBe('override');
    });
  });

  describe('SBX_DEFAULT_NAME', () => {
    it('has awf-agent prefix and process pid', () => {
      expect(SBX_DEFAULT_NAME).toMatch(/^awf-agent-\d+$/);
    });
  });

  describe('createSandbox', () => {
    it('uses shell agent, configured mounts, and sanitized env', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // auth check
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' }); // sbx create

      await createSandbox({
        name: 'awf-agent-test',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/tmp/gh-aw:/tmp/gh-aw:ro'],
      });

      expect(mockExecaFn).toHaveBeenCalledWith('sbx', [
        'create',
        '--name', 'awf-agent-test',
        'shell',
        '/workspace',
        '/tmp/gh-aw:ro',
        '/tmp',
        '/usr/local/bin',
        process.env.HOME || '/home/runner',
      ], expect.objectContaining({
        input: 'y\n',
        env: expect.objectContaining({
          DOCKER_SANDBOXES_PROXY: 'http://172.30.0.10:3128',
        }),
      }));
      // XDG_CONFIG_HOME must not reach the sbx CLI
      const sbxCreateCallEnv: Record<string, string | undefined> = mockExecaFn.mock.calls[1][2].env;
      expect(sbxCreateCallEnv).not.toMatchObject({ XDG_CONFIG_HOME: expect.anything() });
    });

    it('uses SBX_DEFAULT_NAME when no name provided', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // auth check
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      const name = await createSandbox({
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
      });

      expect(name).toBe(SBX_DEFAULT_NAME);
    });

    it('uses default squidPort 3128 when not specified', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' });

      expect(mockExecaFn).toHaveBeenCalledWith(
        'sbx',
        expect.arrayContaining(['create']),
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_SANDBOXES_PROXY: 'http://172.30.0.10:3128' }),
        }),
      );
    });

    it('uses custom squidPort when specified', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10', squidPort: 8080 });

      expect(mockExecaFn).toHaveBeenCalledWith(
        'sbx',
        expect.arrayContaining(['create']),
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_SANDBOXES_PROXY: 'http://172.30.0.10:8080' }),
        }),
      );
    });

    it('throws when auth check fails (non-zero exit)', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not authenticated' }) // sbx ls
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'daemon running', stderr: '' }); // daemon status

      await expect(createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' })).rejects.toThrow(
        /sbx is not authenticated/,
      );
    });

    it('throws when auth check exits null (treated as non-zero)', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: null, stdout: '', stderr: 'error' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'daemon ok', stderr: '' });

      await expect(createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' })).rejects.toThrow(
        /sbx is not authenticated/,
      );
    });

    it('throws when sbx create fails with non-zero exit', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'quota exceeded' });

      await expect(createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' })).rejects.toThrow(
        /sbx create failed.*quota exceeded/,
      );
    });

    it('throws when sbx create exits null and no "Created sandbox" in stdout', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: null, stdout: 'something else', stderr: 'err' });

      await expect(createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' })).rejects.toThrow(
        /sbx create failed/,
      );
    });

    it('succeeds even if exit code is non-zero when "Created sandbox" in stdout', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 1, stdout: 'Created sandbox awf-agent-test', stderr: '' });

      const name = await createSandbox({ name: 'awf-agent-test', workspaceDir: '/ws', squidIp: '172.30.0.10' });
      expect(name).toBe('awf-agent-test');
    });

    it('deduplicates extra mounts with the same host path', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({
        name: 'awf-agent-dedup',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/workspace:/workspace:rw', '/workspace:/workspace:ro'],
      });

      const createCall = mockExecaFn.mock.calls[1];
      const args: string[] = createCall[1];
      // /workspace should appear only once (from workspaceDir)
      const workspaceCount = args.filter(a => a === '/workspace').length;
      expect(workspaceCount).toBe(1);
    });

    it('handles rw extra mounts without :ro suffix', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({
        name: 'awf-agent-rw',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/data:/data:rw'],
      });

      const createCall = mockExecaFn.mock.calls[1];
      const args: string[] = createCall[1];
      expect(args).toContain('/data');
      expect(args).not.toContain('/data:ro');
    });

    it('handles extra mount with only host:container (2-segment) format', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({
        name: 'awf-agent-2seg',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/data:/data'],
      });

      const createCall = mockExecaFn.mock.calls[1];
      const args: string[] = createCall[1];
      // two segments where second is not ro/rw → no mode suffix
      expect(args).toContain('/data');
    });

    it('skips system paths already in workspace or dedup list', async () => {
      const home = process.env.HOME || '/home/runner';
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      // workspaceDir IS /tmp — should not be added again
      await createSandbox({
        name: 'awf-agent-tmp',
        workspaceDir: '/tmp',
        squidIp: '172.30.0.10',
      });

      const createCall = mockExecaFn.mock.calls[1];
      const args: string[] = createCall[1];
      const tmpCount = args.filter(a => a === '/tmp').length;
      expect(tmpCount).toBe(1);
      expect(args).toContain('/usr/local/bin');
      expect(args).toContain(home);
    });
  });

  describe('execInSandbox', () => {
    it('returns exit code 0 on success', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      const result = await execInSandbox('awf-agent-test', 'echo hello');
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero exit code and warns', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 42 });

      const result = await execInSandbox('awf-agent-test', 'exit 42');
      expect(result.exitCode).toBe(42);
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exited with code 42'),
      );
    });

    it('returns exit code 1 when exitCode is null', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: null });

      const result = await execInSandbox('awf-agent-test', 'cmd');
      expect(result.exitCode).toBe(1);
    });

    it('returns exit code 124 on timeout', async () => {
      const timeoutError = Object.assign(new Error('timed out'), { timedOut: true });
      mockExecaFn.mockRejectedValueOnce(timeoutError);

      const result = await execInSandbox('awf-agent-test', 'sleep 999', { timeoutMinutes: 1 });
      expect(result.exitCode).toBe(124);
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('timed out after 1 minutes'),
      );
    });

    it('returns exit code 1 on unexpected exec error', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('exec failed'));

      const result = await execInSandbox('awf-agent-test', 'cmd');
      expect(result.exitCode).toBe(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('exec failed'),
      );
    });

    it('passes workDir flag when specified', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      await execInSandbox('awf-agent-test', 'ls', { workDir: '/workspace' });

      const args: string[] = mockExecaFn.mock.calls[0][1];
      expect(args).toContain('--workdir');
      expect(args).toContain('/workspace');
    });

    it('passes --tty flag when tty option is true', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      await execInSandbox('awf-agent-test', 'bash', { tty: true });

      const args: string[] = mockExecaFn.mock.calls[0][1];
      expect(args).toContain('--tty');
    });

    it('passes --env flags for environment variables', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      await execInSandbox('awf-agent-test', 'env', { environment: { FOO: 'bar', BAZ: 'qux' } });

      const args: string[] = mockExecaFn.mock.calls[0][1];
      expect(args).toContain('--env');
      expect(args).toContain('FOO=bar');
      expect(args).toContain('BAZ=qux');
    });

    it('sets timeout when timeoutMinutes is specified', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      await execInSandbox('awf-agent-test', 'cmd', { timeoutMinutes: 5 });

      const callOptions = mockExecaFn.mock.calls[0][2];
      expect(callOptions.timeout).toBe(5 * 60 * 1000);
    });

    it('does not set timeout when timeoutMinutes is not specified', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

      await execInSandbox('awf-agent-test', 'cmd');

      const callOptions = mockExecaFn.mock.calls[0][2];
      expect(callOptions.timeout).toBeUndefined();
    });
  });

  describe('removeSandbox', () => {
    it('warns when sbx rm exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // stop
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still running' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox "awf-agent-test"'),
      );
    });

    it('warns when sbx stop exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' }) // stop
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop sandbox "awf-agent-test"'),
      );
    });

    it('handles stop throwing (sandbox may already be stopped)', async () => {
      mockExecaFn
        .mockRejectedValueOnce(new Error('stop threw')) // stop throws
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('removed'),
      );
    });

    it('logs success when stop and rm both succeed', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('"awf-agent-test" removed'),
      );
    });

    it('warns (not throws) when rm exits null', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: null, stdout: '', stderr: 'null exit' });

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox'),
      );
    });
  });

  describe('isSbxAvailable', () => {
    it('returns true when sbx version succeeds', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: 'sbx 1.0.0', stderr: '' });

      const result = await isSbxAvailable();
      expect(result).toBe(true);
    });

    it('returns false when sbx version throws (not installed)', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('command not found: sbx'));

      const result = await isSbxAvailable();
      expect(result).toBe(false);
    });
  });
});
