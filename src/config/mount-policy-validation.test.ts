/**
 * Validation-branch tests for mount-policy.ts.
 *
 * The `validate()` function and its helpers (`assertStringArray`,
 * `assertHomeSubdirArray`, `assertAbsolutePathArray`, `parseCredentials`) are
 * called once at module load time with the real JSON, so their error paths are
 * never exercised by the main test suite.  Here we use `jest.mock()` to inject
 * malformed JSON and then `jest.isolateModules()` to reload the module so that
 * each error branch is hit in isolation.
 */

// We do NOT import mount-policy at the top level — each test reloads it via
// jest.isolateModules so the module-level `validate(rawPolicy)` call runs with
// whatever mock we installed.

function loadModule(mockJson: unknown): Promise<typeof import('./mount-policy')> {
  return new Promise((resolve, reject) => {
    jest.isolateModules(() => {
      jest.mock('./sandbox-mount-policy.json', () => mockJson, { virtual: false });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        resolve(require('./mount-policy'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Minimal valid JSON that passes the validator without errors. */
const validJson = {
  system: {
    directories: {
      default: ['/usr', '/bin'],
      sysroot: ['/sys', '/dev'],
    },
    etc: ['/etc/ssl'],
  },
  home: {
    toolSubdirs: ['.cache', '.config'],
    forbiddenSubdirs: ['.ssh', '.aws'],
  },
  credentials: {
    entries: [
      { path: '.docker/config.json', type: 'file', reason: 'Docker token' },
      {
        path: '.config/gh',
        type: 'dir',
        files: ['hosts.yml'],
        reason: 'GitHub CLI credentials',
      },
    ],
  },
};

// ─── root validation ──────────────────────────────────────────────────────────

describe('mount-policy validate – root', () => {
  it('throws when root is null', async () => {
    await expect(loadModule(null)).rejects.toThrow('Invalid sandbox-mount-policy.json: root must be an object');
  });

  it('throws when root is a string', async () => {
    await expect(loadModule('bad')).rejects.toThrow('root must be an object');
  });

  it('throws when system.directories is missing', async () => {
    const bad = { ...validJson, system: { etc: ['/etc/ssl'] } };
    await expect(loadModule(bad)).rejects.toThrow('system.directories is required');
  });

  it('throws when home is missing', async () => {
    const bad = { ...validJson, home: undefined };
    await expect(loadModule(bad)).rejects.toThrow('home is required');
  });
});

// ─── assertAbsolutePathArray ──────────────────────────────────────────────────

describe('mount-policy validate – assertAbsolutePathArray', () => {
  it('throws when system.directories.default is not an array', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: 'not-an-array' },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'system.directories.default must be an array of strings',
    );
  });

  it('throws when system.directories.default contains a non-string', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: [42] },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'system.directories.default must be an array of strings',
    );
  });

  it('throws when system.directories.default contains a relative path', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: ['relative/path'] },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "system.directories.default entries must be absolute paths (start with '/')",
    );
  });

  it('throws when system.directories.default contains an empty string', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: [''] },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'system.directories.default must not contain empty strings',
    );
  });

  it('throws when system.directories.default contains a path with ..', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: ['/usr/../etc'] },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "system.directories.default entries must not contain '..'",
    );
  });

  it('throws when system.directories.default has duplicate entries', async () => {
    const bad = {
      ...validJson,
      system: {
        ...validJson.system,
        directories: { ...validJson.system.directories, default: ['/usr', '/usr'] },
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'system.directories.default has duplicate entry',
    );
  });

  it('throws when system.etc contains a non-absolute path', async () => {
    const bad = {
      ...validJson,
      system: { ...validJson.system, etc: ['etc/ssl'] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "system.etc entries must be absolute paths (start with '/')",
    );
  });
});

// ─── assertHomeSubdirArray ────────────────────────────────────────────────────

describe('mount-policy validate – assertHomeSubdirArray', () => {
  it('throws when home.toolSubdirs is not an array', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: 'bad' } };
    await expect(loadModule(bad)).rejects.toThrow(
      'home.toolSubdirs must be an array of strings',
    );
  });

  it('throws when home.toolSubdirs contains an empty string', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: [''] } };
    await expect(loadModule(bad)).rejects.toThrow(
      'home.toolSubdirs must not contain empty strings',
    );
  });

  it('throws when home.toolSubdirs contains an absolute path', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: ['/absolute'] } };
    await expect(loadModule(bad)).rejects.toThrow(
      'home.toolSubdirs entries must be relative $HOME paths, not absolute',
    );
  });

  it('throws when home.toolSubdirs entry starts with ~', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: ['~/.cache'] } };
    await expect(loadModule(bad)).rejects.toThrow(
      'home.toolSubdirs entries must be relative $HOME paths, not absolute',
    );
  });

  it('throws when home.toolSubdirs entry contains a path separator', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: ['nested/dir'] } };
    await expect(loadModule(bad)).rejects.toThrow(
      "home.toolSubdirs entries must be simple directory names (no '/')",
    );
  });

  it('throws when home.toolSubdirs entry contains ..', async () => {
    const bad = { ...validJson, home: { ...validJson.home, toolSubdirs: ['..'] } };
    await expect(loadModule(bad)).rejects.toThrow(
      "home.toolSubdirs entries must not contain '..'",
    );
  });

  it('throws when home.toolSubdirs has duplicate entries', async () => {
    const bad = {
      ...validJson,
      home: { ...validJson.home, toolSubdirs: ['.cache', '.cache'] },
    };
    await expect(loadModule(bad)).rejects.toThrow('home.toolSubdirs has duplicate entry');
  });

  it('throws when home.forbiddenSubdirs has a path separator', async () => {
    const bad = {
      ...validJson,
      home: { ...validJson.home, forbiddenSubdirs: ['bad/dir'] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "home.forbiddenSubdirs entries must be simple directory names (no '/')",
    );
  });
});

// ─── parseCredentials ─────────────────────────────────────────────────────────

describe('mount-policy validate – parseCredentials', () => {
  it('throws when credentials is not an object', async () => {
    const bad = { ...validJson, credentials: 'bad' };
    await expect(loadModule(bad)).rejects.toThrow('credentials must be an object');
  });

  it('throws when credentials is null', async () => {
    const bad = { ...validJson, credentials: null };
    await expect(loadModule(bad)).rejects.toThrow('credentials must be an object');
  });

  it('throws when credentials.entries is not an array', async () => {
    const bad = { ...validJson, credentials: { entries: 'bad' } };
    await expect(loadModule(bad)).rejects.toThrow('credentials.entries must be an array');
  });

  it('throws when a credential entry is not an object', async () => {
    const bad = { ...validJson, credentials: { entries: ['not-an-object'] } };
    await expect(loadModule(bad)).rejects.toThrow('credentials.entries[0] must be an object');
  });

  it('throws when entry.path is missing', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ type: 'file', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].path must be a non-empty string',
    );
  });

  it('throws when entry.path is empty', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '', type: 'file', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].path must be a non-empty string',
    );
  });

  it('throws when entry.path is absolute', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '/absolute/path', type: 'file', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].path must be a relative $HOME path without '..'",
    );
  });

  it('throws when entry.path starts with ~', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '~/.docker', type: 'dir', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].path must be a relative $HOME path without '..'",
    );
  });

  it('throws when entry.path contains ..', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '../etc/passwd', type: 'file', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].path must be a relative $HOME path without '..'",
    );
  });

  it('throws on duplicate credential entry paths', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [
          { path: '.docker/config.json', type: 'file', reason: 'r' },
          { path: '.docker/config.json', type: 'file', reason: 'r' },
        ],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow('duplicate credential entry path');
  });

  it('throws when entry.type is invalid', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '.foo', type: 'symlink', reason: 'r' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].type must be 'file' or 'dir'",
    );
  });

  it('throws when files is set on a file-type entry', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [
          { path: '.foo', type: 'file', files: ['bar'], reason: 'r' },
        ],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].files is only valid for type 'dir'",
    );
  });

  it('throws when files array contains an empty string', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [{ path: '.foo', type: 'dir', files: [''], reason: 'r' }],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].files must not contain empty strings',
    );
  });

  it('throws when files array contains a path with /', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [{ path: '.foo', type: 'dir', files: ['sub/file'], reason: 'r' }],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].files entries must be plain filenames (no '/')",
    );
  });

  it('throws when files array contains a .. component', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [{ path: '.foo', type: 'dir', files: ['..'], reason: 'r' }],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      "credentials.entries[0].files entries must not contain '..'",
    );
  });

  it('throws when files array has duplicates', async () => {
    const bad = {
      ...validJson,
      credentials: {
        entries: [{ path: '.foo', type: 'dir', files: ['a', 'a'], reason: 'r' }],
      },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].files has duplicate entry',
    );
  });

  it('throws when entry.reason is missing', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '.foo', type: 'file' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].reason must be a non-empty string',
    );
  });

  it('throws when entry.reason is empty', async () => {
    const bad = {
      ...validJson,
      credentials: { entries: [{ path: '.foo', type: 'file', reason: '' }] },
    };
    await expect(loadModule(bad)).rejects.toThrow(
      'credentials.entries[0].reason must be a non-empty string',
    );
  });

  it('accepts a dir entry without files (compose-only protection falls through)', async () => {
    const good = {
      ...validJson,
      credentials: {
        entries: [{ path: '.foo', type: 'dir', reason: 'opaque store' }],
      },
    };
    const mod = await loadModule(good);
    expect(mod.CREDENTIAL_ENTRIES[0].files).toBeUndefined();
  });
});

// ─── credentialFilesToHide edge cases ────────────────────────────────────────

describe('credentialFilesToHide – edge cases via mocked JSON', () => {
  it('omits dir entries that have no files list', async () => {
    const json = {
      ...validJson,
      credentials: {
        entries: [
          { path: '.foo', type: 'dir', reason: 'opaque dir — no files enumerated' },
          { path: '.bar', type: 'file', reason: 'token file' },
        ],
      },
    };
    const mod = await loadModule(json);
    const hidden = mod.credentialFilesToHide();
    // Only the file entry should appear
    expect(hidden).toEqual(['.bar']);
    // The dir entry without files must not appear at all
    expect(hidden.some((f) => f.startsWith('.foo'))).toBe(false);
  });

  it('expands all files within a dir entry', async () => {
    const json = {
      ...validJson,
      credentials: {
        entries: [
          {
            path: '.config/tool',
            type: 'dir',
            files: ['token.json', 'secret.key'],
            reason: 'tool tokens',
          },
        ],
      },
    };
    const mod = await loadModule(json);
    expect(mod.credentialFilesToHide()).toEqual([
      '.config/tool/token.json',
      '.config/tool/secret.key',
    ]);
  });
});
