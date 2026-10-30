import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCredentialHidingOverlays, pruneUnmountableCredentialOverlays } from './credential-hiding';
import { credentialFilesToHide } from '../../config/mount-policy';
import { createLocalSourceResolver } from './mount-topology';

// `accessSync` is wrapped so tests can deterministically simulate the EROFS a
// truly read-only mount raises, without depending on a `chmod`-based
// directory (which a root test process, and rootful `runc`, can still pass a
// `W_OK` check against).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    accessSync: jest.fn((...args: Parameters<typeof actual.accessSync>) => actual.accessSync(...args)),
  };
});

describe('buildCredentialHidingOverlays', () => {
  it('hides every policy credential file at both home and /host paths', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner');
    const expectedFiles = credentialFilesToHide();

    // One overlay at the real $HOME path and one at the chroot /host path.
    expect(overlays).toHaveLength(expectedFiles.length * 2);

    for (const rel of expectedFiles) {
      expect(overlays).toContain(`/dev/null:/home/runner/${rel}:ro`);
      expect(overlays).toContain(`/dev/null:/host/home/runner/${rel}:ro`);
    }
  });

  it('masks representative credential files from the central policy', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner');

    expect(overlays).toContain('/dev/null:/home/runner/.docker/config.json:ro');
    expect(overlays).toContain('/dev/null:/host/home/runner/.docker/config.json:ro');
    expect(overlays).toContain('/dev/null:/home/runner/.config/gh/hosts.yml:ro');
    expect(overlays).toContain('/dev/null:/host/home/runner/.config/gh/hosts.yml:ro');
    expect(overlays).toContain('/dev/null:/home/runner/.config/glab-cli/config.yml:ro');
    expect(overlays).toContain('/dev/null:/host/home/runner/.config/glab-cli/config.yml:ro');
    // Newly centralized entries (previously only protected by sbx).
    expect(overlays).toContain('/dev/null:/home/runner/.claude/.credentials.json:ro');
    expect(overlays).toContain('/dev/null:/home/runner/.gemini/oauth_creds.json:ro');
  });

  it('masks exposed GitLab overrides and platform paths through every bind alias', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner', [
      '/workspace:/host/workspace:rw',
      '/workspace/gitlab-auth:/auth:ro',
      '/workspace/gitlab-auth/config.yml:/credential.yml:ro',
      '/home/runner/Library:/host/home/runner/Library:rw',
      '/home/runner/.cache:/host/home/runner/.cache:rw',
    ], undefined, {
      GLAB_CONFIG_DIR: '/workspace/gitlab-auth',
      XDG_CONFIG_HOME: '/home/runner/.cache/xdg',
    });

    expect(overlays).toEqual(expect.arrayContaining([
      '/dev/null:/host/workspace/gitlab-auth/config.yml:ro',
      '/dev/null:/auth/config.yml:ro',
      '/dev/null:/credential.yml:ro',
      '/dev/null:/host/home/runner/Library/Application Support/glab-cli/config.yml:ro',
      '/dev/null:/host/home/runner/.cache/xdg/glab-cli/config.yml:ro',
    ]));
    expect(overlays.some((spec) => spec.includes('aliases.yml'))).toBe(false);
  });

  it('does not expose unmounted overrides or similarly named source siblings', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner', [
      '/workspace/gitlab-auth-other:/auth:rw',
    ], undefined, { GLAB_CONFIG_DIR: '/workspace/gitlab-auth' });
    expect(overlays.some((spec) => spec.includes('/auth/'))).toBe(false);
    expect(overlays.some((spec) => spec.includes('/workspace/'))).toBe(false);
  });

  it('resolves daemon-prefixed custom sources before masking GitLab credentials', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner', [
      '/host/workspace/gitlab-auth:/auth:ro',
    ], createLocalSourceResolver(new Map([
      ['/host/workspace/gitlab-auth', '/workspace/gitlab-auth'],
    ]), '/host'), { GLAB_CONFIG_DIR: '/workspace/gitlab-auth' });
    expect(overlays).toContain('/dev/null:/auth/config.yml:ro');
  });
});

describe('pruneUnmountableCredentialOverlays', () => {
  const HOME = '/home/runner';
  const overlay = (target: string) => `/dev/null:${target}:ro`;

  let hostDir: string;

  beforeEach(() => {
    hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-prune-'));
  });

  afterEach(() => {
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  it.each([HOME, `/host${HOME}`])(
    'drops missing credential overlays behind writable binds at %s without creating host paths',
    (homeTarget) => {
      const relativePaths = [
        '.config/gcloud/credentials.db',
        '.config/gcloud/access_tokens.db',
        '.config/gcloud/application_default_credentials.json',
        '.azure/accessTokens.json',
        '.cargo/credentials.toml',
        '.claude/.credentials.json',
      ];
      const volumes = [
        `${hostDir}:${homeTarget}:rw`,
        ...relativePaths.map((rel) => overlay(`${homeTarget}/${rel}`)),
      ];

      expect(pruneUnmountableCredentialOverlays(volumes)).toEqual([volumes[0]]);
      expect(fs.readdirSync(hostDir)).toEqual([]);
    },
  );

  it('drops a missing credential overlay even when its writable parent directory exists', () => {
    fs.mkdirSync(path.join(hostDir, '.config/gcloud'), { recursive: true });
    const bind = `${hostDir}/.config:/host${HOME}/.config:rw`;
    const target = `/host${HOME}/.config/gcloud/credentials.db`;

    expect(pruneUnmountableCredentialOverlays([bind, overlay(target)])).toEqual([bind]);
    expect(fs.readdirSync(path.join(hostDir, '.config/gcloud'))).toEqual([]);
  });

  it.each(['ro', 'rw'])('keeps overlays whose mountpoint exists behind a %s bind', (mode) => {
    fs.mkdirSync(path.join(hostDir, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, '.config/gh/hosts.yml'), 'DUMMY_SECRET_VALUE');
    const target = `/host${HOME}/.config/gh/hosts.yml`;

    const result = pruneUnmountableCredentialOverlays([
      `${hostDir}:/host${HOME}:${mode}`,
      overlay(target),
    ]);

    expect(result).toContain(overlay(target));
  });

  it('keeps an overlay when a file bind has the same destination', () => {
    const secret = path.join(hostDir, 'npmrc');
    fs.writeFileSync(secret, 'DUMMY_SECRET_VALUE');
    const target = `/host${HOME}/.npmrc`;
    const volumes = [`${secret}:${target}:ro`, overlay(target)];

    expect(pruneUnmountableCredentialOverlays(volumes)).toEqual(volumes);
  });

  it('drops overlays whose mountpoint is missing behind a read-only bind', () => {
    const target = `/host${HOME}/.docker/config.json`;

    const result = pruneUnmountableCredentialOverlays([
      `${hostDir}:/host${HOME}:ro`,
      overlay(target),
    ]);

    expect(result).not.toContain(overlay(target));
    expect(result).toContain(`${hostDir}:/host${HOME}:ro`);
  });

  // Regression for github/gh-aw-firewall#8076: on ARC/DinD, the covering bind
  // for `$HOME` is declared read-write (it's the AWF-managed home volume, not
  // a `filesystem.allowWrite`-narrowed one), but the directory it resolves to
  // can itself be read-only on the runner's real filesystem when staged under
  // `--docker-host-path-prefix`. Docker does not remount that case read-only,
  // so it touches the real path directly and hits the same EROFS runc would
  // hit for a declared read-only bind.
  //
  // `chmod`-based read-only directories are not a reliable stand-in for that:
  // a root test process (and rootful `runc`) can still pass a `W_OK` check
  // against a mode-only read-only directory, so these regressions instead
  // mock `fs.accessSync` to deterministically raise the `EROFS` that a truly
  // read-only mount produces, independent of the uid running the test.
  const accessSyncMock = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;
  const actualAccessSync = jest.requireActual<typeof import('fs')>('fs').accessSync;

  const mockRealReadOnlyDir = (readOnlyDir: string) => {
    accessSyncMock.mockImplementation((target, mode) => {
      if (target === readOnlyDir) {
        const err = new Error('EROFS: read-only file system') as NodeJS.ErrnoException;
        err.code = 'EROFS';
        throw err;
      }
      return actualAccessSync(target, mode);
    });
  };

  it('drops overlays whose mountpoint is missing behind a read-write bind pointing at a real read-only directory', () => {
    fs.mkdirSync(path.join(hostDir, 'home'), { recursive: true });
    mockRealReadOnlyDir(path.join(hostDir, 'home'));
    const target = `/host${HOME}/.npmrc`;

    try {
      const result = pruneUnmountableCredentialOverlays([
        `${path.join(hostDir, 'home')}:/host${HOME}:rw`,
        overlay(target),
      ]);

      expect(result).not.toContain(overlay(target));
      expect(result).toContain(`${path.join(hostDir, 'home')}:/host${HOME}:rw`);
    } finally {
      accessSyncMock.mockImplementation((...args) => actualAccessSync(...args));
    }
  });

  it('keeps overlays whose mountpoint already exists behind a read-write bind pointing at a real read-only directory', () => {
    fs.mkdirSync(path.join(hostDir, 'home'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'home/.npmrc'), 'DUMMY_SECRET_VALUE');
    mockRealReadOnlyDir(path.join(hostDir, 'home'));
    const target = `/host${HOME}/.npmrc`;

    try {
      const result = pruneUnmountableCredentialOverlays([
        `${path.join(hostDir, 'home')}:/host${HOME}:rw`,
        overlay(target),
      ]);

      // The mountpoint already exists, so runc only has to bind over it --
      // no directory write is required, so this stays mountable even though
      // the real directory is read-only.
      expect(result).toContain(overlay(target));
    } finally {
      accessSyncMock.mockImplementation((...args) => actualAccessSync(...args));
    }
  });

  it('drops overlays whose mountpoint needs a missing intermediate directory under a real read-only ancestor', () => {
    fs.mkdirSync(path.join(hostDir, 'home'), { recursive: true });
    mockRealReadOnlyDir(path.join(hostDir, 'home'));
    const target = `/host${HOME}/.config/gh/hosts.yml`;

    try {
      const result = pruneUnmountableCredentialOverlays([
        `${path.join(hostDir, 'home')}:/host${HOME}:rw`,
        overlay(target),
      ]);

      expect(result).not.toContain(overlay(target));
    } finally {
      accessSyncMock.mockImplementation((...args) => actualAccessSync(...args));
    }
  });

  it('resolves the mountpoint against the innermost covering bind', () => {
    // An outer read-only bind that does have the file, and an inner read-only
    // bind that does not. The inner bind is what supplies the directory, so the
    // overlay is unmountable and must be dropped.
    fs.mkdirSync(path.join(hostDir, 'outer/.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'outer/.config/gh/hosts.yml'), 'DUMMY');
    fs.mkdirSync(path.join(hostDir, 'inner'), { recursive: true });
    const target = `/host${HOME}/.config/gh/hosts.yml`;

    const result = pruneUnmountableCredentialOverlays([
      `${hostDir}/outer:/host${HOME}:ro`,
      `${hostDir}/inner:/host${HOME}/.config:ro`,
      overlay(target),
    ]);

    expect(result).not.toContain(overlay(target));
  });

  it('resolves duplicate covering destinations against the last bind, as Compose does', () => {
    fs.mkdirSync(path.join(hostDir, 'empty'));
    fs.mkdirSync(path.join(hostDir, 'home'));
    fs.writeFileSync(path.join(hostDir, 'home/.npmrc'), '');
    const target = `/host${HOME}/.npmrc`;
    const volumes = [
      `${hostDir}/empty:/host${HOME}:rw`,
      `${hostDir}/home:/host${HOME}:rw`,
      overlay(target),
    ];

    expect(pruneUnmountableCredentialOverlays(volumes)).toEqual(volumes);
    expect(pruneUnmountableCredentialOverlays([
      volumes[1], volumes[0], overlay(target),
    ])).toEqual([volumes[1], volumes[0]]);
  });

  it('keeps overlays that land on the container rootfs with no covering bind', () => {
    const volumes = [
      `${hostDir}:/host${HOME}:ro`,
      '/dev/null:/host/var/run/docker.sock:ro',
      '/dev/null:/host/run/docker.sock:ro',
    ];

    const result = pruneUnmountableCredentialOverlays(volumes);

    expect(result).toContain('/dev/null:/host/var/run/docker.sock:ro');
    expect(result).toContain('/dev/null:/host/run/docker.sock:ro');
  });

  it('keeps overlays covered by a named volume, which cannot be probed', () => {
    const target = `/host${HOME}/.docker/config.json`;

    const result = pruneUnmountableCredentialOverlays([
      `awf-home:/host${HOME}:ro`,
      overlay(target),
    ]);

    expect(result).toContain(overlay(target));
  });

  it('never drops non-overlay mounts', () => {
    const volumes = [`${hostDir}:/host${HOME}:ro`, '/tmp:/tmp:ro', `${hostDir}:/workspace:rw`];

    expect(pruneUnmountableCredentialOverlays(volumes)).toEqual(volumes);
  });

  describe('split-filesystem runners (--docker-host-path-prefix)', () => {
    it('keeps an overlay when the covering custom mount maps to a real runner path', () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-local-'));
      fs.mkdirSync(path.join(localRoot, '.docker'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, '.docker/config.json'), '{}');

      const resolver = createLocalSourceResolver(new Map([['/daemon' + localRoot, localRoot]]), '/daemon');
      const target = `/host${HOME}/.docker/config.json`;

      const result = pruneUnmountableCredentialOverlays(
        [`/daemon${localRoot}:/host${HOME}:ro`, overlay(target)],
        resolver,
      );

      expect(result).toContain(overlay(target));
      fs.rmSync(localRoot, { recursive: true, force: true });
    });

    it('keeps an overlay whose covering custom mount has no known runner path', () => {
      // Fail closed: probing '/daemon/staged/...' with runner-local fs would
      // report "missing" and silently unmask a real credential file.
      const resolver = createLocalSourceResolver(new Map([['/daemon/staged', '']]), '/daemon');
      const target = `/host${HOME}/.docker/config.json`;

      const result = pruneUnmountableCredentialOverlays(
        [`/daemon/staged:/host${HOME}:ro`, overlay(target)],
        resolver,
      );

      expect(result).toContain(overlay(target));
    });

    it('keeps an overlay behind an unattributable daemon-prefixed source', () => {
      const resolver = createLocalSourceResolver(new Map(), '/daemon');
      const target = `/host${HOME}/.npmrc`;

      const result = pruneUnmountableCredentialOverlays(
        [`/daemon/tmp/chroot-home:/host${HOME}:ro`, overlay(target)],
        resolver,
      );

      expect(result).toContain(overlay(target));
    });

    it.each(['ro', 'rw'])('drops a missing overlay behind a %s bind when the runner path is known', (mode) => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-local-'));
      const resolver = createLocalSourceResolver(new Map([['/daemon' + localRoot, localRoot]]), '/daemon');
      const target = `/host${HOME}/.docker/config.json`;

      const result = pruneUnmountableCredentialOverlays(
        [`/daemon${localRoot}:/host${HOME}:${mode}`, overlay(target)],
        resolver,
      );

      expect(result).not.toContain(overlay(target));
      fs.rmSync(localRoot, { recursive: true, force: true });
    });
  });
});
