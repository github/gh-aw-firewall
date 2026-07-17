import {
  HOME_TOOL_SUBDIRS,
  CREDENTIAL_EXCLUSIONS_BY_PARENT,
  CREDENTIAL_NESTING_SUBDIRS,
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

  it('excludes the known nested credential paths for each tool dir', () => {
    // Compose blanks these via /dev/null overlays; sbx excludes them by mount.
    expect(CREDENTIAL_EXCLUSIONS_BY_PARENT['.config']).toEqual(
      expect.arrayContaining(['gh', 'gcloud']),
    );
    expect(CREDENTIAL_EXCLUSIONS_BY_PARENT['.cargo']).toContain('credentials');
    expect(CREDENTIAL_EXCLUSIONS_BY_PARENT['.claude']).toContain('.credentials.json');
    expect(CREDENTIAL_EXCLUSIONS_BY_PARENT['.copilot']).toContain('config.json');
    expect(CREDENTIAL_EXCLUSIONS_BY_PARENT['.gemini']).toContain('oauth_creds.json');
  });

  it('treats every exclusion parent as a credential-nesting subdir', () => {
    expect(CREDENTIAL_NESTING_SUBDIRS).toEqual(
      Object.keys(CREDENTIAL_EXCLUSIONS_BY_PARENT),
    );
    // Every nesting parent must itself be a mounted home subdir (whitelisted
    // tool dir, or an agent-state dir the sbx path adds: .copilot / .gemini).
    const mountedHomeSubdirs = new Set<string>([
      '.copilot',
      ...HOME_TOOL_SUBDIRS,
      '.gemini',
    ]);
    for (const parent of CREDENTIAL_NESTING_SUBDIRS) {
      expect(mountedHomeSubdirs.has(parent)).toBe(true);
    }
  });
});
