import { HOME_TOOL_SUBDIRS, HOME_FORBIDDEN_SUBDIRS } from './home-whitelist';

describe('home-whitelist (mount-policy shim)', () => {
  it('re-exports the shared home allow list', () => {
    expect(HOME_TOOL_SUBDIRS).toEqual(
      expect.arrayContaining(['.cache', '.config', '.local', '.cargo', '.npm', '.copilot', '.gemini']),
    );
  });

  it('never whitelists a directory that is on the forbidden deny list', () => {
    for (const dir of HOME_FORBIDDEN_SUBDIRS) {
      expect(HOME_TOOL_SUBDIRS as readonly string[]).not.toContain(dir);
    }
  });

  it('lists the well-known top-level credential store dirs as forbidden', () => {
    expect(HOME_FORBIDDEN_SUBDIRS).toEqual(
      expect.arrayContaining(['.aws', '.ssh', '.docker', '.kube', '.azure', '.gnupg']),
    );
  });
});
