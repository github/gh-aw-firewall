import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCredentialHidingOverlays, pruneUnmountableCredentialOverlays } from './credential-hiding';
import { credentialFilesToHide } from '../../config/mount-policy';
import { createLocalSourceResolver } from './mount-topology';

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
    // Newly centralized entries (previously only protected by sbx).
    expect(overlays).toContain('/dev/null:/home/runner/.claude/.credentials.json:ro');
    expect(overlays).toContain('/dev/null:/home/runner/.gemini/oauth_creds.json:ro');
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

  it('keeps every overlay when no covering bind is read-only (the no-policy case)', () => {
    const volumes = [
      `${hostDir}:/host${HOME}:rw`,
      `${hostDir}/.config:/host${HOME}/.config:rw`,
      overlay(`${HOME}/.docker/config.json`),
      overlay(`/host${HOME}/.docker/config.json`),
      overlay(`/host${HOME}/.config/gh/hosts.yml`),
    ];

    expect(pruneUnmountableCredentialOverlays(volumes)).toEqual(volumes);
  });

  it('keeps overlays whose mountpoint exists behind a read-only bind', () => {
    fs.mkdirSync(path.join(hostDir, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, '.config/gh/hosts.yml'), 'DUMMY_SECRET_VALUE');
    const target = `/host${HOME}/.config/gh/hosts.yml`;

    const result = pruneUnmountableCredentialOverlays([
      `${hostDir}:/host${HOME}:ro`,
      overlay(target),
    ]);

    expect(result).toContain(overlay(target));
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

    it('still drops an unreachable overlay when the runner path is known', () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-local-'));
      const resolver = createLocalSourceResolver(new Map([['/daemon' + localRoot, localRoot]]), '/daemon');
      const target = `/host${HOME}/.docker/config.json`;

      const result = pruneUnmountableCredentialOverlays(
        [`/daemon${localRoot}:/host${HOME}:ro`, overlay(target)],
        resolver,
      );

      expect(result).not.toContain(overlay(target));
      fs.rmSync(localRoot, { recursive: true, force: true });
    });
  });
});
