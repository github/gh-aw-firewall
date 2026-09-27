import {
  assertSbxEgressEnforced,
  createSandbox,
  removeSandbox,
  SBX_DEFAULT_NAME,
  testHelpers,
} from './sbx-manager';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

const {
  restoreHomeCredentials,
  sanitizeEnvForSbx,
  withCreateSandboxEnvironment,
} = testHelpers;

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());
// Mock fs so home-mount curation and credential scrub/restore are deterministic.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    readdirSync: jest.fn(() => []),
    renameSync: jest.fn(() => undefined),
    mkdirSync: jest.fn(() => undefined),
    rmSync: jest.fn(() => undefined),
    lstatSync: jest.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })),
    statSync: jest.fn(() => ({
      isDirectory: () => true,
    })),
    realpathSync: jest.fn((p: fs.PathLike) => String(p)),
  };
});

const mockedExistsSync = fs.existsSync as jest.Mock;
const mockedReaddirSync = fs.readdirSync as jest.Mock;
const mockedRenameSync = fs.renameSync as jest.Mock;
const mockedMkdirSync = fs.mkdirSync as jest.Mock;
const mockedRmSync = fs.rmSync as jest.Mock;
const mockedLstatSync = fs.lstatSync as jest.Mock;
const mockedStatSync = fs.statSync as jest.Mock;
const mockedRealpathSync = jest.mocked(fs.realpathSync);

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

  describe('withCreateSandboxEnvironment', () => {
    afterEach(() => {
      delete process.env.DOCKER_SANDBOXES_PROXY;
      delete process.env.XDG_CONFIG_HOME;
    });

    it('temporarily removes DOCKER_SANDBOXES_PROXY and XDG_CONFIG_HOME and restores them on success', async () => {
      process.env.DOCKER_SANDBOXES_PROXY = 'http://old-proxy:3128';
      process.env.XDG_CONFIG_HOME = '/home/runner';

      await withCreateSandboxEnvironment(async () => {
        expect(process.env.DOCKER_SANDBOXES_PROXY).toBeUndefined();
        expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
      });

      expect(process.env.DOCKER_SANDBOXES_PROXY).toBe('http://old-proxy:3128');
      expect(process.env.XDG_CONFIG_HOME).toBe('/home/runner');
    });

    it('restores DOCKER_SANDBOXES_PROXY and XDG_CONFIG_HOME after failure', async () => {
      process.env.DOCKER_SANDBOXES_PROXY = 'http://old-proxy:3128';
      process.env.XDG_CONFIG_HOME = '/home/runner';

      await expect(withCreateSandboxEnvironment(async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');

      expect(process.env.DOCKER_SANDBOXES_PROXY).toBe('http://old-proxy:3128');
      expect(process.env.XDG_CONFIG_HOME).toBe('/home/runner');
    });
  });

  describe('SBX_DEFAULT_NAME', () => {
    it('has awf-agent prefix and process pid', () => {
      expect(SBX_DEFAULT_NAME).toMatch(/^awf-agent-\d+$/);
    });
  });

  describe('assertSbxEgressEnforced', () => {
    it('probes denied domains without proxy environment variables or curl configuration', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await expect(assertSbxEgressEnforced(
        'awf-agent-test',
        { HTTPS_PROXY: 'http://host.docker.internal:3128' },
        ['github.com'],
        '/workspace',
      )).resolves.toBeUndefined();

      const args: string[] = mockExecaFn.mock.calls[0][1];
      const command = args[args.length - 1];
      expect(command).toContain('env -u HTTP_PROXY -u HTTPS_PROXY');
      expect(command).toContain('-u ALL_PROXY -u all_proxy');
      expect(command).toContain('https://1.1.1.1/');
      expect(command).toContain('curl --disable --fail --insecure --silent');
      expect(command).toContain('exit 86');
      expect(spawnSync('bash', ['-n', '-c', command]).status).toBe(0);
    });

    it('does not select a probe covered by a mixed-case plain-domain allowlist', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await expect(assertSbxEgressEnforced(
        'awf-agent-test',
        {},
        ['EXAMPLE.COM'],
      )).resolves.toBeUndefined();

      const args: string[] = mockExecaFn.mock.calls[0][1];
      const command = args[args.length - 1];
      expect(command).not.toContain('https://example.com/');
    });

    it('rejects startup when a direct request reaches the internet on every retry', async () => {
      jest.useFakeTimers();
      try {
        mockExecaFn.mockResolvedValue({ exitCode: 86, stdout: '', stderr: '' });

        const assertion = expect(assertSbxEgressEnforced(
          'awf-agent-test',
          {},
          ['github.com'],
        )).rejects.toThrow('direct egress bypassed Squid');

        await jest.advanceTimersByTimeAsync(2_000);
        await jest.advanceTimersByTimeAsync(2_000);
        await assertion;
        // One initial probe plus retries for the transient-Squid-startup grace window.
        expect(mockExecaFn).toHaveBeenCalledTimes(3);
      } finally {
        jest.useRealTimers();
      }
    });

    it('tolerates a transient bypass that clears on retry', async () => {
      jest.useFakeTimers();
      try {
        mockExecaFn
          .mockResolvedValueOnce({ exitCode: 86, stdout: '', stderr: '' })
          .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

        const assertion = expect(assertSbxEgressEnforced(
          'awf-agent-test',
          {},
          ['github.com'],
        )).resolves.toBeUndefined();

        await jest.advanceTimersByTimeAsync(2_000);
        await assertion;
        expect(mockExecaFn).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('fails closed when the probe cannot execute', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 127, stdout: '', stderr: '' });

      await expect(assertSbxEgressEnforced(
        'awf-agent-test',
        {},
        ['github.com'],
      )).rejects.toThrow('Could not verify Docker sbx egress enforcement');
    });

    it('fails when the allowlist covers every built-in probe domain', async () => {
      await expect(assertSbxEgressEnforced(
        'awf-agent-test',
        {},
        ['1.1.1.1', '*.com', '*.org', '*.net'],
      )).rejects.toThrow('allowlist covers every built-in probe domain');

      expect(mockExecaFn).not.toHaveBeenCalled();
    });
  });

  describe('createSandbox', () => {
    beforeEach(() => {
      // Default: no host $HOME subdirs exist, so home-mount curation is a no-op
      // unless a test opts in. Individual tests re-mock as needed.
      mockedExistsSync.mockReset();
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReset();
      mockedReaddirSync.mockReturnValue([]);
      mockedRenameSync.mockReset();
      mockedRenameSync.mockReturnValue(undefined);
      mockedLstatSync.mockReset();
      mockedLstatSync.mockImplementation((p: fs.PathLike) => {
        if (!mockedExistsSync(p)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(p)}'`), {
            code: 'ENOENT',
          });
        }
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      });
      mockedStatSync.mockReset();
      mockedStatSync.mockReturnValue({
        isDirectory: () => true,
      });
      mockedRealpathSync.mockReset();
      mockedRealpathSync.mockImplementation((p: fs.PathLike) => String(p));
      // Ensure no scrubbed state leaks between tests.
      restoreHomeCredentials();
      mockedRenameSync.mockReset();
      mockedRenameSync.mockReturnValue(undefined);
    });

    it('uses shell agent, configured mounts, and sanitized env', async () => {
      // No host $HOME subdirs exist → only workspace, extra mounts, /tmp and
      // /usr/local/bin are mounted (the whole $HOME is never mounted).
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
      ], expect.objectContaining({
        input: 'y\n',
      }));
      // sbx create must NOT pass a custom env — it inherits process.env so the
      // sbx CLI can find daemon credentials. The sandbox interior is isolated
      // separately by execInSandbox() which uses sanitizeEnvForSbx().
      const sbxCreateCall = mockExecaFn.mock.calls[1][2];
      expect(sbxCreateCall.env).toBeUndefined();
    });

    it('never mounts the whole $HOME (only whitelisted subdirs that exist)', async () => {
      const homePath = process.env.HOME || '/home/runner';
      // Simulate a host home that contains both tool dirs AND credential stores.
      mockedExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return (
          s === `${homePath}/.cache` ||
          s === `${homePath}/.config` ||
          s === `${homePath}/.copilot` ||
          s === `${homePath}/.aws` ||
          s === `${homePath}/.ssh` ||
          s === `${homePath}/.docker`
        );
      });
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      const args: string[] = mockExecaFn.mock.calls[1][1];
      // The whole home is never mounted...
      expect(args).not.toContain(homePath);
      // ...whitelisted tool dirs that exist ARE mounted...
      expect(args).toContain(`${homePath}/.cache`);
      // ...and credential stores are NEVER mounted, even though they exist.
      expect(args).not.toContain(`${homePath}/.aws`);
      expect(args).not.toContain(`${homePath}/.ssh`);
      expect(args).not.toContain(`${homePath}/.docker`);
    });

    it('never exposes sandboxd state through the sbx .local mount', async () => {
      const homePath = process.env.HOME || '/home/runner';
      mockedExistsSync.mockImplementation((p: fs.PathLike) => [
        `${homePath}/.local`,
        `${homePath}/.local/bin`,
        `${homePath}/.local/share`,
        `${homePath}/.local/state`,
        `${homePath}/.local/state/sandboxes`,
      ].includes(String(p)));
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      const args: string[] = mockExecaFn.mock.calls[1][1];
      expect(args).toContain(`${homePath}/.local/bin`);
      expect(args).toContain(`${homePath}/.local/share`);
      expect(args).not.toContain(`${homePath}/.local`);
      expect(args).not.toContain(`${homePath}/.local/state`);
      expect(args).not.toContain(`${homePath}/.local/state/sandboxes`);
    });

    it('mounts credential-nesting tool dirs wholesale and scrubs nested secrets before create', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const parents = [
        `${homePath}/.cargo`,
        `${homePath}/.claude`,
        `${homePath}/.gemini`,
      ];
      const secrets = [
        `${homePath}/.cargo/credentials`,
        `${homePath}/.cargo/credentials.toml`,
        `${homePath}/.claude/.credentials.json`,
        `${homePath}/.gemini/oauth_creds.json`,
        `${homePath}/.gemini/google_accounts.json`,
      ];
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) => parents.includes(String(p)) || secrets.includes(String(p)),
      );
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      const args: string[] = mockExecaFn.mock.calls[1][1];
      // Parents ARE mounted wholesale (as directories) so their loose files work.
      for (const parent of parents) expect(args).toContain(parent);
      // No individual file is ever passed as a positional mount.
      for (const secret of secrets) expect(args).not.toContain(secret);
      // Each nested credential path is moved aside on the host before create.
      const movedOriginals = mockedRenameSync.mock.calls.map((c) => String(c[0]));
      for (const secret of secrets) expect(movedOriginals).toContain(secret);

      restoreHomeCredentials();
    });

    it('refuses symlinked home tool dirs before passing mounts to sbx', async () => {
      const homePath = process.env.HOME || '/home/runner';
      mockedExistsSync.mockImplementation((p: fs.PathLike) => (
        String(p) === `${homePath}/.local/bin`
      ));
      mockedLstatSync.mockImplementation((p: fs.PathLike) => {
        if (!mockedExistsSync(p)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(p)}'`), {
            code: 'ENOENT',
          });
        }
        if (String(p) === `${homePath}/.local/bin`) {
          return {
            isDirectory: () => false,
            isSymbolicLink: () => true,
          };
        }
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      });
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await expect(createSandbox({
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
      })).rejects.toThrow(`Refusing to use symlink as directory: ${homePath}/.local/bin`);
      expect(mockExecaFn).toHaveBeenCalledTimes(1);
    });

    it('mounts ~/.config wholesale and scrubs nested credential dirs before create', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const secrets = [
        `${homePath}/.config/gh`,
        `${homePath}/.config/gcloud`,
        `${homePath}/.config/rclone`,
      ];
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) =>
          String(p) === `${homePath}/.config` || secrets.includes(String(p)),
      );
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      const args: string[] = mockExecaFn.mock.calls[1][1];
      // The parent .config IS mounted wholesale so benign tool config still works.
      expect(args).toContain(`${homePath}/.config`);
      // Known credential subdirs are moved aside before create, not mounted.
      for (const secret of secrets) expect(args).not.toContain(secret);
      const movedOriginals = mockedRenameSync.mock.calls.map((c) => String(c[0]));
      for (const secret of secrets) expect(movedOriginals).toContain(secret);

      restoreHomeCredentials();
    });

    it('continues without mutating credentials when the backup directory cannot be created', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const secret = `${homePath}/.claude/.credentials.json`;
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === `${homePath}/.claude` || String(p) === secret,
      );
      mockedMkdirSync.mockImplementationOnce(() => {
        throw new Error('read-only home');
      });
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      expect(mockedRenameSync).not.toHaveBeenCalled();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not create credential backup dir'),
      );
    });

    it('continues after a credential path cannot be moved aside', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const secret = `${homePath}/.claude/.credentials.json`;
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === `${homePath}/.claude` || String(p) === secret,
      );
      mockedRenameSync.mockImplementationOnce(() => {
        throw new Error('busy');
      });
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not hide credential path'),
      );
      restoreHomeCredentials();
    });

    it('restores scrubbed credentials after the sandbox is removed', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const secret = `${homePath}/.claude/.credentials.json`;
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) =>
          String(p) === `${homePath}/.claude` ||
          String(p) === secret ||
          String(p).includes('.awf-sbx-cred-backup'),
      );
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      // The secret was moved to a backup during create.
      const createMoves = mockedRenameSync.mock.calls.map((c) => [String(c[0]), String(c[1])]);
      const scrubMove = createMoves.find(([from]) => from === secret);
      expect(scrubMove).toBeDefined();
      const backupPath = scrubMove![1];

      mockedRenameSync.mockClear();
      // removeSandbox: stop + rm both succeed, then restore runs.
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await removeSandbox(SBX_DEFAULT_NAME);

      // The backup is moved back to its original location after teardown.
      const restoreMoves = mockedRenameSync.mock.calls.map((c) => [String(c[0]), String(c[1])]);
      expect(restoreMoves).toContainEqual([backupPath, secret]);
    });

    it('preserves the backup when credential restoration fails', async () => {
      const homePath = process.env.HOME || '/home/runner';
      const secret = `${homePath}/.claude/.credentials.json`;
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) =>
          String(p) === `${homePath}/.claude` ||
          String(p) === secret ||
          String(p).includes('.awf-sbx-cred-backup'),
      );
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });
      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });
      mockedRenameSync.mockImplementationOnce(() => {
        throw new Error('restore denied');
      });
      mockedRmSync.mockImplementationOnce(() => {
        throw new Error('not empty');
      });

      restoreHomeCredentials();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not restore credential path'),
      );
    });

    it('skips whitelisted home subdirs that do not exist on the host', async () => {
      const homePath = process.env.HOME || '/home/runner';
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === `${homePath}/.npm`,
      );
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/workspace', squidIp: '172.30.0.10' });

      const args: string[] = mockExecaFn.mock.calls[1][1];
      expect(args).toContain(`${homePath}/.npm`);
      expect(args).not.toContain(`${homePath}/.cache`);
      expect(args).not.toContain(`${homePath}/.rustup`);
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

    it('does not pass custom env during create (inherits process.env)', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' });

      const sbxCreateCall = mockExecaFn.mock.calls[1][2];
      expect(sbxCreateCall.env).toBeUndefined();
    });

    it('temporarily removes DOCKER_SANDBOXES_PROXY and XDG_CONFIG_HOME during create', async () => {
      process.env.DOCKER_SANDBOXES_PROXY = 'http://old-proxy:3128';
      process.env.XDG_CONFIG_HOME = '/home/runner';
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' });

      await createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10', squidPort: 8080 });

      // Both should be restored after create
      expect(process.env.DOCKER_SANDBOXES_PROXY).toBe('http://old-proxy:3128');
      expect(process.env.XDG_CONFIG_HOME).toBe('/home/runner');
      delete process.env.DOCKER_SANDBOXES_PROXY;
      delete process.env.XDG_CONFIG_HOME;
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

    it('reports an authentication failure when the probes return no diagnostics', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });

      await expect(createSandbox({ workspaceDir: '/ws', squidIp: '172.30.0.10' })).rejects.toThrow(
        /sbx is not authenticated/,
      );
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('daemon status: '),
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
      mockedExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === `${home}/.cache`,
      );
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
      // The whole $HOME is never mounted; only existing whitelisted subdirs are.
      expect(args).not.toContain(home);
      expect(args).toContain(`${home}/.cache`);
    });
  });

});
