import {
  mountPolicy,
  HOME_TOOL_SUBDIRS,
  HOME_FORBIDDEN_SUBDIRS,
  CREDENTIAL_ENTRIES,
  credentialFilesToHide,
  credentialEntriesUnderMountedParents,
  systemDirectories,
  etcAllowlist,
} from './mount-policy';

describe('mount-policy', () => {
  describe('policy invariants', () => {
    it('never lists a forbidden home dir in the tool-subdir allow list', () => {
      for (const dir of HOME_FORBIDDEN_SUBDIRS) {
        expect(HOME_TOOL_SUBDIRS).not.toContain(dir);
      }
    });

    it('exposes credential entries with valid, relative, unique paths', () => {
      const seen = new Set<string>();
      for (const entry of CREDENTIAL_ENTRIES) {
        expect(entry.path).not.toMatch(/^[/~]/);
        expect(entry.path).not.toContain('..');
        expect(['file', 'dir']).toContain(entry.type);
        if (entry.files) expect(entry.type).toBe('dir');
        expect(seen.has(entry.path)).toBe(false);
        seen.add(entry.path);
      }
    });

    it('only attaches `files` to directory credential entries', () => {
      for (const entry of CREDENTIAL_ENTRIES) {
        if (entry.files !== undefined) expect(entry.type).toBe('dir');
      }
    });

    it('home.toolSubdirs entries are simple relative names without traversal', () => {
      for (const dir of HOME_TOOL_SUBDIRS) {
        expect(dir).not.toBe('');
        expect(dir).not.toContain('/');
        expect(dir).not.toContain('..');
        expect(dir).not.toMatch(/^[/~]/);
      }
    });

    it('home.toolSubdirs has no duplicate entries', () => {
      expect(new Set(HOME_TOOL_SUBDIRS).size).toBe(HOME_TOOL_SUBDIRS.length);
    });

    it('home.forbiddenSubdirs entries are simple relative names without traversal', () => {
      for (const dir of HOME_FORBIDDEN_SUBDIRS) {
        expect(dir).not.toBe('');
        expect(dir).not.toContain('/');
        expect(dir).not.toContain('..');
        expect(dir).not.toMatch(/^[/~]/);
      }
    });

    it('system directories are absolute paths without traversal', () => {
      for (const dir of [...systemDirectories(false), ...systemDirectories(true)]) {
        expect(dir).toMatch(/^\//);
        expect(dir).not.toContain('..');
      }
    });

    it('/etc paths are absolute without traversal', () => {
      for (const p of etcAllowlist()) {
        expect(p).toMatch(/^\//);
        expect(p).not.toContain('..');
      }
    });

    it('credential dir-entry files are plain filenames (no path separators or traversal)', () => {
      for (const entry of CREDENTIAL_ENTRIES) {
        if (entry.files) {
          for (const f of entry.files) {
            expect(f).not.toBe('');
            expect(f).not.toContain('/');
            expect(f).not.toContain('..');
          }
          expect(new Set(entry.files).size).toBe(entry.files.length);
        }
      }
    });
  });

  describe('credentialFilesToHide', () => {
    it('expands dir entries via their files and passes file entries through', () => {
      const files = credentialFilesToHide();
      // file entry
      expect(files).toContain('.docker/config.json');
      // dir entry expanded
      expect(files).toContain('.config/gh/hosts.yml');
      expect(files).toContain('.config/gcloud/credentials.db');
      // dir entry with no known files is omitted (compose can't mask a dir)
      expect(files).not.toContain('.config/heroku');
      expect(files.some((f) => f.startsWith('.config/heroku'))).toBe(false);
    });

    it('matches the number of file entries plus enumerated dir files', () => {
      const expected =
        CREDENTIAL_ENTRIES.filter((e) => e.type === 'file').length +
        CREDENTIAL_ENTRIES.filter((e) => e.type === 'dir').reduce(
          (n, e) => n + (e.files?.length ?? 0),
          0,
        );
      expect(credentialFilesToHide()).toHaveLength(expected);
    });
  });

  describe('credentialEntriesUnderMountedParents', () => {
    it('includes only entries whose top-level parent is mounted', () => {
      const mounted = new Set(['.config', '.cargo', '.claude', '.copilot', '.gemini']);
      const entries = credentialEntriesUnderMountedParents(mounted);
      const paths = entries.map((e) => e.path);

      expect(paths).toContain('.config/gh');
      expect(paths).toContain('.cargo/credentials');
      expect(paths).toContain('.claude/.credentials.json');
      // Never-mounted parents are excluded.
      expect(paths).not.toContain('.ssh/id_rsa');
      expect(paths).not.toContain('.aws/credentials');
      expect(paths).not.toContain('.docker/config.json');
      expect(paths).not.toContain('.npmrc');
    });

    it('returns nothing when no parents are mounted', () => {
      expect(credentialEntriesUnderMountedParents(new Set())).toHaveLength(0);
    });
  });

  describe('system allow lists', () => {
    it('returns the full system dir set by default and a reduced set for sysroot', () => {
      const def = systemDirectories(false);
      const sysroot = systemDirectories(true);
      expect(def).toEqual(expect.arrayContaining(['/usr', '/bin', '/lib', '/sys', '/dev']));
      expect(sysroot).toEqual(['/sys', '/dev']);
      expect(sysroot.length).toBeLessThan(def.length);
    });

    it('exposes the always-mounted /etc allow list', () => {
      expect(etcAllowlist()).toEqual(
        expect.arrayContaining(['/etc/ssl', '/etc/ca-certificates', '/etc/nsswitch.conf']),
      );
    });
  });

  it('freezes-through the raw JSON into a typed policy object', () => {
    expect(mountPolicy.home.toolSubdirs).toBe(HOME_TOOL_SUBDIRS);
    expect(mountPolicy.credentials).toBe(CREDENTIAL_ENTRIES);
  });

  it('includes .copilot and .gemini in home.toolSubdirs', () => {
    expect(HOME_TOOL_SUBDIRS).toContain('.copilot');
    expect(HOME_TOOL_SUBDIRS).toContain('.gemini');
  });
});
