import { buildCredentialHidingOverlays } from './credential-hiding';

describe('buildCredentialHidingOverlays', () => {
  it('hides credentials at both home and /host paths', () => {
    const overlays = buildCredentialHidingOverlays('/home/runner');

    expect(overlays).toContain('/dev/null:/home/runner/.docker/config.json:ro');
    expect(overlays).toContain('/dev/null:/host/home/runner/.docker/config.json:ro');
    expect(overlays).toContain('/dev/null:/home/runner/.config/gh/hosts.yml:ro');
    expect(overlays).toContain('/dev/null:/host/home/runner/.config/gh/hosts.yml:ro');
    expect(overlays).toHaveLength(28);
  });
});
