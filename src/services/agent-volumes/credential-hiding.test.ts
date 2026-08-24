import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCredentialHidingOverlays } from './credential-hiding';
import { credentialFilesToHide } from '../../config/mount-policy';

/**
 * Creates a throwaway home directory containing every credential file in the
 * central policy, so the overlay builder sees them as present on the host.
 */
function createPopulatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-home-'));
  for (const rel of credentialFilesToHide()) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'DUMMY_SECRET_VALUE');
  }
  return home;
}

describe('buildCredentialHidingOverlays', () => {
  let home: string;

  beforeEach(() => {
    home = createPopulatedHome();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('hides every policy credential file at both home and /host paths', () => {
    const overlays = buildCredentialHidingOverlays(home);
    const expectedFiles = credentialFilesToHide();

    // One overlay at the real $HOME path and one at the chroot /host path.
    expect(overlays).toHaveLength(expectedFiles.length * 2);

    for (const rel of expectedFiles) {
      expect(overlays).toContain(`/dev/null:${home}/${rel}:ro`);
      expect(overlays).toContain(`/dev/null:/host${home}/${rel}:ro`);
    }
  });

  it('masks representative credential files from the central policy', () => {
    const overlays = buildCredentialHidingOverlays(home);

    expect(overlays).toContain(`/dev/null:${home}/.docker/config.json:ro`);
    expect(overlays).toContain(`/dev/null:/host${home}/.docker/config.json:ro`);
    expect(overlays).toContain(`/dev/null:${home}/.config/gh/hosts.yml:ro`);
    expect(overlays).toContain(`/dev/null:/host${home}/.config/gh/hosts.yml:ro`);
    // Newly centralized entries (previously only protected by sbx).
    expect(overlays).toContain(`/dev/null:${home}/.claude/.credentials.json:ro`);
    expect(overlays).toContain(`/dev/null:${home}/.gemini/oauth_creds.json:ro`);
  });

  it('still masks a credential file that is a symlink to a real file', () => {
    const target = path.join(home, 'real-docker-config.json');
    fs.writeFileSync(target, 'DUMMY_SECRET_VALUE');
    const linkPath = path.join(home, '.docker/config.json');
    fs.rmSync(linkPath);
    fs.symlinkSync(target, linkPath);

    const overlays = buildCredentialHidingOverlays(home);

    expect(overlays).toContain(`/dev/null:${home}/.docker/config.json:ro`);
    expect(overlays).toContain(`/dev/null:/host${home}/.docker/config.json:ro`);
  });

  // Regression: a `/dev/null` overlay needs its mountpoint to already exist.
  // runc creates a missing one with openat(O_CREAT) on the parent, which fails
  // with EROFS once filesystem.allowWrite narrows the $HOME bind to read-only,
  // killing the agent container before it starts. Absent files carry no
  // credential, so they must simply be skipped.
  describe('credential files that do not exist on the host', () => {
    it('omits overlays for them', () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-empty-'));
      try {
        expect(buildCredentialHidingOverlays(emptyHome)).toEqual([]);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    });

    it('omits only the absent ones and keeps the rest', () => {
      const removed = '.docker/config.json';
      fs.rmSync(path.join(home, removed));

      const overlays = buildCredentialHidingOverlays(home);
      const remaining = credentialFilesToHide().filter((rel) => rel !== removed);

      expect(overlays).toHaveLength(remaining.length * 2);
      expect(overlays).not.toContain(`/dev/null:${home}/${removed}:ro`);
      expect(overlays).not.toContain(`/dev/null:/host${home}/${removed}:ro`);
      for (const rel of remaining) {
        expect(overlays).toContain(`/dev/null:${home}/${rel}:ro`);
      }
    });

    it('omits overlays for a dangling symlink, which cannot leak anything', () => {
      const linkPath = path.join(home, '.docker/config.json');
      fs.rmSync(linkPath);
      fs.symlinkSync(path.join(home, 'nonexistent-target'), linkPath);

      const overlays = buildCredentialHidingOverlays(home);

      expect(overlays).not.toContain(`/dev/null:${home}/.docker/config.json:ro`);
    });
  });
});
