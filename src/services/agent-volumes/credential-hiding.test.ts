import { buildCredentialHidingOverlays } from './credential-hiding';
import { credentialFilesToHide } from '../../config/mount-policy';

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
