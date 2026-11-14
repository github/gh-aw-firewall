import * as fs from 'fs';
import * as path from 'path';
import { SbxLifecycleManager } from './sbx-manager';
import { CredentialScrubHandle } from './sbx/credential-scrub';
import * as sandboxCreate from './sbx/sandbox-create';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
  lstatSync: jest.fn(),
  statSync: jest.fn(),
  realpathSync: jest.fn(),
  mkdtempSync: jest.fn(),
  chmodSync: jest.fn(),
  renameSync: jest.fn(),
  rmSync: jest.fn(),
}));

interface FixtureEntry {
  ino: number;
  directory: boolean;
  contents?: string;
  mode?: number;
}

const success = { exitCode: 0, stdout: '', stderr: '' };
const config = { name: 'first', workspaceDir: '/workspace', squidIp: '172.30.0.10' };

describe('isolated sbx credential and lifecycle state', () => {
  let entries: Map<string, FixtureEntry>;
  let nextInode: number;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecaFn.mockReset();
    entries = new Map();
    nextInode = 1;
    jest.mocked(fs.existsSync).mockImplementation(candidate => entries.has(String(candidate)));
    const stat = (candidate: fs.PathLike): fs.Stats => {
      const entry = entries.get(String(candidate));
      if (!entry) {
        throw Object.assign(new Error(`Missing fixture: ${String(candidate)}`), { code: 'ENOENT' });
      }
      return {
        dev: 1,
        ino: entry.ino,
        mode: entry.mode ?? 0o700,
        isDirectory: () => entry.directory,
        isSymbolicLink: () => false,
      } as fs.Stats;
    };
    jest.mocked(fs.lstatSync).mockImplementation(stat);
    jest.mocked(fs.statSync).mockImplementation(stat);
    jest.mocked(fs.realpathSync).mockImplementation(candidate => String(candidate));
    jest.mocked(fs.mkdtempSync).mockImplementation(prefix => {
      const root = `${String(prefix)}${nextInode}`;
      entries.set(root, { ino: nextInode++, directory: true });
      return root;
    });
    jest.mocked(fs.chmodSync).mockImplementation((candidate, mode) => {
      entries.get(String(candidate))!.mode = Number(mode);
    });
    jest.mocked(fs.renameSync).mockImplementation((from, to) => {
      const original = String(from);
      const entry = entries.get(original);
      if (!entry) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
      entries.delete(original);
      entries.set(String(to), entry);
    });
    jest.mocked(fs.rmSync).mockImplementation(candidate => {
      const root = String(candidate);
      for (const name of entries.keys()) {
        if (name === root || name.startsWith(`${root}/`)) entries.delete(name);
      }
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function homeFixture(name: string): { home: string; secret: string; value: string } {
    const home = `/home/${name}`;
    const secret = path.join(home, '.cargo', 'credentials.toml');
    const value = `fixture-${name}`;
    entries.set(home, { ino: nextInode++, directory: true });
    entries.set(path.dirname(secret), { ino: nextInode++, directory: true });
    entries.set(secret, { ino: nextInode++, directory: false, contents: value });
    return { home, secret, value };
  }

  function backupRoot(home: string): string {
    const root = [...entries.keys()].find(name => name.startsWith(`${home}/.awf-sbx-cred-backup-`));
    expect(root).toBeDefined();
    return root!;
  }

  function contents(candidate: string): string | undefined {
    return entries.get(candidate)?.contents;
  }

  it('scrubs distinct homes with independent handles and restores only the owning home', () => {
    const first = homeFixture('first');
    const second = homeFixture('second');
    const firstHandle = new CredentialScrubHandle();
    const secondHandle = new CredentialScrubHandle();
    firstHandle.scrubHomeCredentials(first.home, new Set(['.cargo']));
    secondHandle.scrubHomeCredentials(second.home, new Set(['.cargo']));

    expect(entries.has(first.secret)).toBe(false);
    expect(entries.has(second.secret)).toBe(false);
    const firstBackupRoot = backupRoot(first.home);
    const secondBackupRoot = backupRoot(second.home);
    expect(entries.get(firstBackupRoot)?.mode).toBe(0o700);
    expect(entries.get(secondBackupRoot)?.mode).toBe(0o700);

    firstHandle.restoreHomeCredentials();
    firstHandle.restoreHomeCredentials();
    expect(contents(first.secret)).toBe(first.value);
    expect(entries.has(firstBackupRoot)).toBe(false);
    expect(firstHandle.hasPendingRestoration).toBe(false);
    expect(entries.has(second.secret)).toBe(false);
    expect(secondHandle.hasPendingRestoration).toBe(true);

    secondHandle.restoreHomeCredentials();
    expect(contents(second.secret)).toBe(second.value);
    expect(entries.has(secondBackupRoot)).toBe(false);
    expect(secondHandle.hasPendingRestoration).toBe(false);
  });

  it('retains backups across unsuccessful restore retries and refuses another scrub', () => {
    const first = homeFixture('first');
    const second = homeFixture('second');
    const credentials = new CredentialScrubHandle();
    credentials.scrubHomeCredentials(first.home, new Set(['.cargo']));
    const backup = path.join(backupRoot(first.home), '.cargo__credentials.toml');
    entries.set(first.secret, { ino: nextInode++, directory: false, contents: 'replacement' });

    credentials.restoreHomeCredentials();
    credentials.restoreHomeCredentials();
    expect(credentials.hasPendingRestoration).toBe(true);
    expect(contents(backup)).toBe(first.value);
    expect(contents(first.secret)).toBe('replacement');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Credential destination already exists: ${first.secret}`),
    );
    expect(() => credentials.scrubHomeCredentials(second.home, new Set(['.cargo'])))
      .toThrow('previous credential backups still need restoration');
    expect(contents(second.secret)).toBe(second.value);
    expect(contents(backup)).toBe(first.value);

    entries.delete(first.secret);
    credentials.restoreHomeCredentials();
    expect(credentials.hasPendingRestoration).toBe(false);
    expect(contents(first.secret)).toBe(first.value);
  });

  it('rejects a substituted parent without losing restoration state', () => {
    const first = homeFixture('first');
    const credentials = new CredentialScrubHandle();
    credentials.scrubHomeCredentials(first.home, new Set(['.cargo']));
    const parent = path.dirname(first.secret);
    const originalParent = entries.get(parent)!;
    entries.set(parent, { ino: nextInode++, directory: true });

    credentials.restoreHomeCredentials();
    expect(credentials.hasPendingRestoration).toBe(true);
    expect(entries.has(first.secret)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Credential parent path changed while sandbox was running: ${parent}`),
    );

    entries.set(parent, originalParent);
    credentials.restoreHomeCredentials();
    expect(credentials.hasPendingRestoration).toBe(false);
    expect(contents(first.secret)).toBe(first.value);
  });

  describe('lifecycle delegation', () => {
    let create: jest.SpiedFunction<typeof sandboxCreate.createSandboxInternal>;

    beforeEach(() => {
      create = jest.spyOn(sandboxCreate, 'createSandboxInternal').mockImplementation(async (options, handle) => {
        handle.scrubHomeCredentials(`/home/${options.name}`, new Set(['.cargo']));
        return options.name!;
      });
    });

    it('transfers distinct handles to create and restores only after the owning sandbox removal', async () => {
      const first = homeFixture('first');
      const second = homeFixture('second');
      const firstManager = new SbxLifecycleManager();
      const secondManager = new SbxLifecycleManager();
      await firstManager.createSandbox(config);
      await secondManager.createSandbox({ ...config, name: 'second' });
      const firstHandle = create.mock.calls[0][1];
      const secondHandle = create.mock.calls[1][1];
      expect(firstHandle).not.toBe(secondHandle);
      expect(firstHandle.hasPendingRestoration).toBe(true);
      expect(secondHandle.hasPendingRestoration).toBe(true);

      mockExecaFn.mockImplementation(async (_command, args) => {
        expect(entries.has(first.secret)).toBe(false);
        expect(args).toEqual(args[0] === 'stop' ? ['stop', 'first'] : ['rm', '--force', 'first']);
        return success;
      });
      await firstManager.removeSandbox('first');
      expect(mockExecaFn).toHaveBeenCalledTimes(2);
      expect(contents(first.secret)).toBe(first.value);
      expect(firstHandle.hasPendingRestoration).toBe(false);
      expect(entries.has(second.secret)).toBe(false);
      expect(secondHandle.hasPendingRestoration).toBe(true);

      mockExecaFn.mockResolvedValue(success);
      await secondManager.removeSandbox('second');
      expect(contents(second.secret)).toBe(second.value);
    });

    it.each(['resolve', 'reject'] as const)(
      'guards before delegation and clears the creation guard after %s',
      async outcome => {
        homeFixture('first');
        const lifecycle = new SbxLifecycleManager();
        let resolve!: (name: string) => void;
        let reject!: (error: Error) => void;
        create.mockImplementationOnce(() => new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        }));
        const creating = lifecycle.createSandbox(config);
        await expect(lifecycle.createSandbox(config)).rejects.toThrow('sandbox creation is in progress');
        expect(create).toHaveBeenCalledTimes(1);
        expect(mockExecaFn).not.toHaveBeenCalled();
        if (outcome === 'resolve') {
          resolve('first');
          await expect(creating).resolves.toBe('first');
        } else {
          reject(new Error('create transport failed'));
          await expect(creating).rejects.toThrow('create transport failed');
        }
        await expect(lifecycle.createSandbox(config)).resolves.toBe('first');
        expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
      },
    );

    it('retains failed-create restoration state and refuses to delegate until a retry succeeds', async () => {
      const first = homeFixture('first');
      const lifecycle = new SbxLifecycleManager();
      create.mockImplementationOnce(async (_options, handle) => {
        handle.scrubHomeCredentials(first.home, new Set(['.cargo']));
        entries.set(first.secret, { ino: nextInode++, directory: false, contents: 'replacement' });
        handle.restoreHomeCredentials();
        throw new Error('sbx create failed (exit 1): quota exceeded');
      });
      await expect(lifecycle.createSandbox(config)).rejects.toThrow('quota exceeded');
      lifecycle.restoreHomeCredentials();
      await expect(lifecycle.createSandbox(config)).rejects.toThrow(
        'previous credential backups still need restoration',
      );
      expect(create).toHaveBeenCalledTimes(1);
      const backup = path.join(backupRoot(first.home), '.cargo__credentials.toml');
      expect(contents(backup)).toBe(first.value);

      entries.delete(first.secret);
      lifecycle.restoreHomeCredentials();
      expect(contents(first.secret)).toBe(first.value);
      await expect(lifecycle.createSandbox(config)).resolves.toBe('first');
      expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
    });

    it('preserves restoration after a nonzero rm result', async () => {
      const first = homeFixture('first');
      const lifecycle = new SbxLifecycleManager();
      await lifecycle.createSandbox(config);
      mockExecaFn
        .mockResolvedValueOnce(success)
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still running' });
      await lifecycle.removeSandbox('first');
      expect(contents(first.secret)).toBe(first.value);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to remove sandbox "first" (exit 1: still running)',
      );
    });

    it('retains backups when create or rm throws and clears only the in-flight guard', async () => {
      const first = homeFixture('first');
      const lifecycle = new SbxLifecycleManager();
      create.mockImplementationOnce(async (_options, handle) => {
        handle.scrubHomeCredentials(first.home, new Set(['.cargo']));
        throw new Error('create transport failed');
      });
      await expect(lifecycle.createSandbox(config)).rejects.toThrow('create transport failed');
      await expect(lifecycle.createSandbox(config)).rejects.toThrow(
        'previous credential backups still need restoration',
      );
      mockExecaFn.mockResolvedValueOnce(success).mockRejectedValueOnce(new Error('rm transport failed'));
      await expect(lifecycle.removeSandbox('first')).rejects.toThrow('rm transport failed');
      expect(entries.has(first.secret)).toBe(false);
      expect(contents(path.join(backupRoot(first.home), '.cargo__credentials.toml'))).toBe(first.value);

      lifecycle.restoreHomeCredentials();
      expect(contents(first.secret)).toBe(first.value);
      await expect(lifecycle.createSandbox(config)).resolves.toBe('first');
      expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
    });
  });
});
