import {
  HOME_TOOL_SUBDIRS,
  CREDENTIAL_PATHS_BY_PARENT,
} from './home-whitelist';

describe('home-whitelist', () => {
  it('never whitelists a top-level credential store directory', () => {
    const forbidden = [
      '.aws',
      '.ssh',
      '.docker',
      '.kube',
      '.azure',
      '.gnupg',
      '.netrc',
      '.gitconfig',
      '.git-credentials',
    ];
    for (const dir of forbidden) {
      expect(HOME_TOOL_SUBDIRS as readonly string[]).not.toContain(dir);
    }
  });

  it('enumerates the known nested credential paths for each tool dir', () => {
    // Compose blanks these via /dev/null overlays; sbx moves them aside before
    // `sbx create` and restores them after teardown.
    expect(CREDENTIAL_PATHS_BY_PARENT['.config']).toEqual(
      expect.arrayContaining(['gh', 'gcloud']),
    );
    expect(CREDENTIAL_PATHS_BY_PARENT['.cargo']).toContain('credentials');
    expect(CREDENTIAL_PATHS_BY_PARENT['.claude']).toContain('.credentials.json');
    expect(CREDENTIAL_PATHS_BY_PARENT['.copilot']).toContain('config.json');
    expect(CREDENTIAL_PATHS_BY_PARENT['.gemini']).toContain('oauth_creds.json');
  });

  it('only nests credential paths under mounted home subdirs', () => {
    // Every credential parent must itself be a mounted home subdir (whitelisted
    // tool dir, or an agent-state dir the sbx path adds: .copilot / .gemini),
    // otherwise scrubbing it would be pointless (the parent never enters the VM).
    const mountedHomeSubdirs = new Set<string>([
      '.copilot',
      ...HOME_TOOL_SUBDIRS,
      '.gemini',
    ]);
    for (const parent of Object.keys(CREDENTIAL_PATHS_BY_PARENT)) {
      expect(mountedHomeSubdirs.has(parent)).toBe(true);
    }
  });
});
