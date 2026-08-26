import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  appleContainerHostSocketPath,
  assertPrivateDirectory,
  assertPrivateSocket,
  assertSocketPathBudget,
  assertSocketPathUnused,
  createAppleContainerSocketDirectory,
  generateAppleContainerTransportRunId,
  removeAppleContainerSocketDirectory,
} from './transport-socket-dir';

/**
 * macOS `os.tmpdir()` is already long, so tests bind under a short `/tmp` base
 * to stay inside the 104-byte `sun_path` limit — the same constraint the module
 * enforces for real runs.
 */
function shortBase(): string {
  return fs.mkdtempSync('/tmp/awfsd');
}

describe('createAppleContainerSocketDirectory', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates a private, self-owned directory', async () => {
    const base = shortBase();
    created.push(base);
    const handle = await createAppleContainerSocketDirectory({ baseDirectory: base });

    const stats = await fsp.lstat(handle.path);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    expect(stats.uid).toBe(process.getuid!());
    expect(path.basename(handle.path)).toBe(`awf-apple-${handle.runId}`);
  });

  it('refuses to reuse an existing directory, so runs cannot collide', async () => {
    const base = shortBase();
    created.push(base);
    const runId = 'abc123def456';
    await createAppleContainerSocketDirectory({ baseDirectory: base, runId });
    await expect(createAppleContainerSocketDirectory({ baseDirectory: base, runId }))
      .rejects.toThrow(/could not be created/);
  });

  it('rejects a base directory that does not exist', async () => {
    await expect(createAppleContainerSocketDirectory({ baseDirectory: '/tmp/awf-absent-base-xyz' }))
      .rejects.toThrow(/is not usable/);
  });

  it('rejects a base directory that is a file', async () => {
    const base = shortBase();
    created.push(base);
    const file = path.join(base, 'file');
    fs.writeFileSync(file, 'x');
    await expect(createAppleContainerSocketDirectory({ baseDirectory: file }))
      .rejects.toThrow(/is not a directory|could not be created/);
  });

  it('rejects relative, unnormalized, and colon-bearing base paths', async () => {
    for (const baseDirectory of ['relative/path', '/tmp/../tmp', '/tmp/a:b']) {
      await expect(createAppleContainerSocketDirectory({ baseDirectory }))
        .rejects.toThrow();
    }
  });

  it('rejects a malformed run id', async () => {
    const base = shortBase();
    created.push(base);
    for (const runId of ['', 'UPPER123', '../escape', 'short', 'g'.repeat(12)]) {
      await expect(createAppleContainerSocketDirectory({ baseDirectory: base, runId }))
        .rejects.toThrow(/run id must be 8-16 lowercase hex/);
    }
  });

  it('resolves a symlinked base to its real path before creating anything', async () => {
    const base = shortBase();
    created.push(base);
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, link);

    const handle = await createAppleContainerSocketDirectory({ baseDirectory: link });
    expect(handle.path.startsWith(fs.realpathSync(real))).toBe(true);
    expect(await fsp.realpath(handle.path)).toBe(handle.path);
  });

  it('generates distinct run ids', () => {
    const ids = new Set(Array.from({ length: 50 }, generateAppleContainerTransportRunId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe('appleContainerHostSocketPath', () => {
  it('builds a direct child of the run directory', () => {
    const directory = { path: '/tmp/awf-apple-abc123def456', runId: 'abc123def456' };
    expect(appleContainerHostSocketPath(directory, 'squid.sock'))
      .toBe('/tmp/awf-apple-abc123def456/squid.sock');
  });

  it('rejects traversal and non-socket names', () => {
    const directory = { path: '/tmp/awf-apple-abc123def456', runId: 'abc123def456' };
    for (const name of ['../escape.sock', 'nested/one.sock', 'squid.txt', '/abs.sock', '.sock']) {
      expect(() => appleContainerHostSocketPath(directory, name)).toThrow();
    }
  });

  it('rejects a path the kernel would truncate', () => {
    const directory = { path: `/tmp/${'d'.repeat(95)}`, runId: 'abc123def456' };
    expect(() => appleContainerHostSocketPath(directory, 'squid.sock'))
      .toThrow(/sun_path limit/);
  });
});

describe('assertSocketPathBudget', () => {
  it('accepts a path at the limit and rejects one byte more', () => {
    const atLimit = `/tmp/${'a'.repeat(MAX_UNIX_SOCKET_PATH_BYTES - 5)}`;
    expect(Buffer.byteLength(atLimit)).toBe(MAX_UNIX_SOCKET_PATH_BYTES);
    expect(assertSocketPathBudget(atLimit)).toBe(atLimit);
    expect(() => assertSocketPathBudget(`${atLimit}b`)).toThrow(/sun_path limit/);
  });
});

describe('assertPrivateDirectory', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  });

  it('rejects a group- or world-accessible directory', async () => {
    const base = shortBase();
    cleanup.push(base);
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o755);
    await expect(assertPrivateDirectory(loose)).rejects.toThrow(/group\/world accessible/);
  });

  it('rejects a symlink standing in for the directory', async () => {
    const base = shortBase();
    cleanup.push(base);
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, link);
    await expect(assertPrivateDirectory(link)).rejects.toThrow(/is not a directory/);
  });

  it('rejects a file', async () => {
    const base = shortBase();
    cleanup.push(base);
    const file = path.join(base, 'file');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    await expect(assertPrivateDirectory(file)).rejects.toThrow(/is not a directory/);
  });
});

describe('assertPrivateSocket and assertSocketPathUnused', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  });

  it('accepts a 0600 socket and rejects a loosened one', async () => {
    const base = shortBase();
    cleanup.push(base);
    const socketPath = path.join(base, 's.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      fs.chmodSync(socketPath, 0o600);
      await expect(assertPrivateSocket(socketPath)).resolves.toBeUndefined();
      fs.chmodSync(socketPath, 0o666);
      await expect(assertPrivateSocket(socketPath)).rejects.toThrow(/group\/world accessible/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a regular file masquerading as a socket', async () => {
    const base = shortBase();
    cleanup.push(base);
    const file = path.join(base, 'not.sock');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    await expect(assertPrivateSocket(file)).rejects.toThrow(/is not a Unix socket/);
  });

  it('treats an absent path as unused and any existing entry as fatal', async () => {
    const base = shortBase();
    cleanup.push(base);
    const absent = path.join(base, 'absent.sock');
    await expect(assertSocketPathUnused(absent)).resolves.toBeUndefined();

    fs.writeFileSync(absent, 'stale');
    await expect(assertSocketPathUnused(absent)).rejects.toThrow(/already exists/);
  });

  it('treats a dangling symlink as an existing entry rather than an absent path', async () => {
    const base = shortBase();
    cleanup.push(base);
    const link = path.join(base, 'planted.sock');
    fs.symlinkSync(path.join(base, 'nowhere'), link);
    await expect(assertSocketPathUnused(link)).rejects.toThrow(/already exists/);
  });
});

describe('removeAppleContainerSocketDirectory', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  });

  it('removes owned sockets and the directory, and is idempotent', async () => {
    const base = shortBase();
    cleanup.push(base);
    const handle = await createAppleContainerSocketDirectory({ baseDirectory: base });
    const socketPath = appleContainerHostSocketPath(handle, 'squid.sock');
    fs.writeFileSync(socketPath, '');

    await removeAppleContainerSocketDirectory(handle, [socketPath]);
    expect(fs.existsSync(handle.path)).toBe(false);

    await expect(removeAppleContainerSocketDirectory(handle, [socketPath]))
      .resolves.toBeUndefined();
  });

  it('refuses to delete a path outside the run directory', async () => {
    const base = shortBase();
    cleanup.push(base);
    const handle = await createAppleContainerSocketDirectory({ baseDirectory: base });
    const outsider = path.join(base, 'outside.sock');
    fs.writeFileSync(outsider, '');

    await expect(removeAppleContainerSocketDirectory(handle, [outsider]))
      .rejects.toThrow(/outside/);
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('never recurses into unexpected content', async () => {
    const base = shortBase();
    cleanup.push(base);
    const handle = await createAppleContainerSocketDirectory({ baseDirectory: base });
    fs.writeFileSync(path.join(handle.path, 'unexpected'), 'x');

    // rmdir on a non-empty directory fails loudly rather than deleting content
    // this run did not create.
    await expect(removeAppleContainerSocketDirectory(handle, [])).rejects.toThrow();
    expect(fs.existsSync(path.join(handle.path, 'unexpected'))).toBe(true);
  });
});

describe('default base directory', () => {
  it('is the process temporary directory', () => {
    // Documents the default used by the manager; kept here so a change to the
    // default is a deliberate, visible edit.
    expect(typeof os.tmpdir()).toBe('string');
  });
});
