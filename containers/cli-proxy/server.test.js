'use strict';
/**
 * Tests for cli-proxy server.js
 */

const { validateArgs, ALLOWED_SUBCOMMANDS_READONLY, BLOCKED_ACTIONS_READONLY, ALWAYS_DENIED_SUBCOMMANDS } = require('./server');

describe('validateArgs', () => {
  describe('input validation', () => {
    it('should reject non-array args', () => {
      const result = validateArgs('pr list', false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('array');
    });

    it('should reject args with non-string elements', () => {
      const result = validateArgs(['pr', 42], false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('strings');
    });

    it('should allow empty args array', () => {
      const result = validateArgs([], false);
      expect(result.valid).toBe(true);
    });

    it('should allow flags-only args (e.g. --version)', () => {
      const result = validateArgs(['--version'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow --help flag', () => {
      const result = validateArgs(['--help'], false);
      expect(result.valid).toBe(true);
    });
  });

  describe('always-denied subcommands', () => {
    for (const cmd of ALWAYS_DENIED_SUBCOMMANDS) {
      it(`should deny '${cmd}' even in writable mode`, () => {
        const result = validateArgs([cmd], true);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(cmd);
      });

      it(`should deny '${cmd}' in read-only mode`, () => {
        const result = validateArgs([cmd], false);
        expect(result.valid).toBe(false);
      });
    }
  });

  describe('read-only mode', () => {
    it('should allow all subcommands in the allowlist', () => {
      for (const cmd of ALLOWED_SUBCOMMANDS_READONLY) {
        // Use 'list' as the action (safe for all)
        const result = validateArgs([cmd, 'list'], false);
        expect(result.valid).toBe(true);
      }
    });

    it('should deny unknown subcommands', () => {
      const result = validateArgs(['unknown-subcommand'], false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('read-only mode');
    });

    it('should deny pr create', () => {
      const result = validateArgs(['pr', 'create', '--title', 'My PR'], false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('pr create');
    });

    it('should deny pr merge', () => {
      const result = validateArgs(['pr', 'merge', '42'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow pr list', () => {
      const result = validateArgs(['pr', 'list', '--json', 'number,title'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow pr view', () => {
      const result = validateArgs(['pr', 'view', '42'], false);
      expect(result.valid).toBe(true);
    });

    it('should deny issue create', () => {
      const result = validateArgs(['issue', 'create', '--title', 'Bug'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow issue list', () => {
      const result = validateArgs(['issue', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow issue view', () => {
      const result = validateArgs(['issue', 'view', '1'], false);
      expect(result.valid).toBe(true);
    });

    it('should deny repo create', () => {
      const result = validateArgs(['repo', 'create'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow repo view', () => {
      const result = validateArgs(['repo', 'view', 'owner/repo'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow api (raw API calls)', () => {
      const result = validateArgs(['api', 'repos/owner/repo'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow search', () => {
      const result = validateArgs(['search', 'issues', '--query', 'bug'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow workflow list', () => {
      const result = validateArgs(['workflow', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should deny workflow run', () => {
      const result = validateArgs(['workflow', 'run', 'ci.yml'], false);
      expect(result.valid).toBe(false);
    });

    it('should deny workflow enable', () => {
      const result = validateArgs(['workflow', 'enable', 'ci.yml'], false);
      expect(result.valid).toBe(false);
    });

    it('should deny secret set', () => {
      const result = validateArgs(['secret', 'set', 'MY_SECRET'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow secret list', () => {
      const result = validateArgs(['secret', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should allow run list', () => {
      const result = validateArgs(['run', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should deny run cancel', () => {
      const result = validateArgs(['run', 'cancel', '123'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow release list', () => {
      const result = validateArgs(['release', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should deny release create', () => {
      const result = validateArgs(['release', 'create', 'v1.0.0'], false);
      expect(result.valid).toBe(false);
    });

    it('should deny gist create', () => {
      const result = validateArgs(['gist', 'create', 'file.txt'], false);
      expect(result.valid).toBe(false);
    });

    it('should allow gist view', () => {
      const result = validateArgs(['gist', 'view', 'abc123'], false);
      expect(result.valid).toBe(true);
    });

    it('should handle flags before subcommand gracefully', () => {
      // e.g.: gh --repo owner/repo pr list
      const result = validateArgs(['--repo', 'owner/repo', 'pr', 'list'], false);
      expect(result.valid).toBe(true);
    });

    it('should handle flags before action gracefully', () => {
      // e.g.: gh pr --json number list
      const result = validateArgs(['pr', '--json', 'number', 'list'], false);
      expect(result.valid).toBe(true);
    });
  });

  describe('writable mode', () => {
    it('should allow pr create in writable mode', () => {
      const result = validateArgs(['pr', 'create', '--title', 'My PR'], true);
      expect(result.valid).toBe(true);
    });

    it('should allow issue create in writable mode', () => {
      const result = validateArgs(['issue', 'create', '--title', 'Bug'], true);
      expect(result.valid).toBe(true);
    });

    it('should allow repo create in writable mode', () => {
      const result = validateArgs(['repo', 'create', 'new-repo'], true);
      expect(result.valid).toBe(true);
    });

    it('should allow secret set in writable mode', () => {
      const result = validateArgs(['secret', 'set', 'MY_SECRET'], true);
      expect(result.valid).toBe(true);
    });

    it('should still deny auth in writable mode', () => {
      const result = validateArgs(['auth', 'login'], true);
      expect(result.valid).toBe(false);
    });

    it('should still deny config in writable mode', () => {
      const result = validateArgs(['config', 'set', 'editor', 'vim'], true);
      expect(result.valid).toBe(false);
    });

    it('should still deny extension in writable mode', () => {
      const result = validateArgs(['extension', 'install', 'owner/ext'], true);
      expect(result.valid).toBe(false);
    });

    it('should allow all read-only subcommands in writable mode', () => {
      for (const cmd of ALLOWED_SUBCOMMANDS_READONLY) {
        const result = validateArgs([cmd, 'list'], true);
        expect(result.valid).toBe(true);
      }
    });

    it('should allow previously blocked actions in writable mode', () => {
      for (const [subcommand, blockedActions] of BLOCKED_ACTIONS_READONLY) {
        for (const action of blockedActions) {
          const result = validateArgs([subcommand, action], true);
          expect(result.valid).toBe(true);
        }
      }
    });
  });

  describe('allowlist completeness', () => {
    it('should have ALLOWED_SUBCOMMANDS_READONLY as a non-empty Set', () => {
      expect(ALLOWED_SUBCOMMANDS_READONLY.size).toBeGreaterThan(0);
    });

    it('should have ALWAYS_DENIED_SUBCOMMANDS as a non-empty Set', () => {
      expect(ALWAYS_DENIED_SUBCOMMANDS.size).toBeGreaterThan(0);
    });

    it('should have no overlap between ALLOWED_SUBCOMMANDS_READONLY and ALWAYS_DENIED_SUBCOMMANDS', () => {
      for (const cmd of ALWAYS_DENIED_SUBCOMMANDS) {
        expect(ALLOWED_SUBCOMMANDS_READONLY.has(cmd)).toBe(false);
      }
    });
  });
});
