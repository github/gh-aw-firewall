import {
  HOME_TOOL_SUBDIRS,
  CREDENTIAL_SUBDIR_NAMES,
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

  it('deny-lists the known credential subdirs that compose masks under .config', () => {
    // Compose blanks .config/gh/hosts.yml and .config/gcloud/credentials.db.
    expect(CREDENTIAL_SUBDIR_NAMES).toContain('gh');
    expect(CREDENTIAL_SUBDIR_NAMES).toContain('gcloud');
  });

  it('treats .config as a credential-nesting parent that must be expanded', () => {
    expect(CREDENTIAL_NESTING_SUBDIRS).toContain('.config');
    // Every nesting parent must itself be a whitelisted tool dir.
    for (const parent of CREDENTIAL_NESTING_SUBDIRS) {
      expect(HOME_TOOL_SUBDIRS as readonly string[]).toContain(parent);
    }
  });
});
