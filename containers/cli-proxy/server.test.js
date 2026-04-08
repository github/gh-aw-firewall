'use strict';
/**
 * Tests for cli-proxy server.js
 *
 * Write control is now handled by the external DIFC guard policy.
 * The server only enforces meta-command denial (auth, config, extension).
 */

const { validateArgs, ALWAYS_DENIED_SUBCOMMANDS } = require('./server');

describe('validateArgs', () => {
  describe('input validation', () => {
    it('should reject non-array args', () => {
      const result = validateArgs('pr list');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('array');
    });

    it('should reject args with non-string elements', () => {
      const result = validateArgs(['pr', 42]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('strings');
    });

    it('should allow empty args array', () => {
      const result = validateArgs([]);
      expect(result.valid).toBe(true);
    });

    it('should allow flags-only args (e.g. --version)', () => {
      const result = validateArgs(['--version']);
      expect(result.valid).toBe(true);
    });

    it('should allow --help flag', () => {
      const result = validateArgs(['--help']);
      expect(result.valid).toBe(true);
    });
  });

  describe('always-denied subcommands', () => {
    for (const cmd of ALWAYS_DENIED_SUBCOMMANDS) {
      it(`should deny '${cmd}'`, () => {
        const result = validateArgs([cmd]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(cmd);
      });
    }
  });

  describe('allowed subcommands (DIFC guard policy handles write control)', () => {
    it('should allow pr list', () => {
      const result = validateArgs(['pr', 'list', '--json', 'number,title']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr view', () => {
      const result = validateArgs(['pr', 'view', '42']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr create (guard policy handles write control)', () => {
      const result = validateArgs(['pr', 'create', '--title', 'My PR']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr merge (guard policy handles write control)', () => {
      const result = validateArgs(['pr', 'merge', '42']);
      expect(result.valid).toBe(true);
    });

    it('should allow issue list', () => {
      const result = validateArgs(['issue', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow issue create (guard policy handles write control)', () => {
      const result = validateArgs(['issue', 'create', '--title', 'Bug']);
      expect(result.valid).toBe(true);
    });

    it('should allow repo view', () => {
      const result = validateArgs(['repo', 'view', 'owner/repo']);
      expect(result.valid).toBe(true);
    });

    it('should allow api subcommand (guard policy handles write control)', () => {
      const result = validateArgs(['api', 'repos/owner/repo']);
      expect(result.valid).toBe(true);
    });

    it('should allow api POST (guard policy handles write control)', () => {
      const result = validateArgs(['api', '-X', 'POST', '/repos/owner/repo/issues', '-f', 'title=Test']);
      expect(result.valid).toBe(true);
    });

    it('should allow search', () => {
      const result = validateArgs(['search', 'issues', '--query', 'bug']);
      expect(result.valid).toBe(true);
    });

    it('should allow workflow list', () => {
      const result = validateArgs(['workflow', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow workflow run (guard policy handles write control)', () => {
      const result = validateArgs(['workflow', 'run', 'ci.yml']);
      expect(result.valid).toBe(true);
    });

    it('should allow secret list', () => {
      const result = validateArgs(['secret', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow run list', () => {
      const result = validateArgs(['run', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow release list', () => {
      const result = validateArgs(['release', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow gist view', () => {
      const result = validateArgs(['gist', 'view', 'abc123']);
      expect(result.valid).toBe(true);
    });

    it('should handle flags before subcommand gracefully', () => {
      // e.g.: gh --repo owner/repo pr list
      const result = validateArgs(['--repo', 'owner/repo', 'pr', 'list']);
      expect(result.valid).toBe(true);
    });
  });

  describe('meta-command denial', () => {
    it('should deny auth login', () => {
      const result = validateArgs(['auth', 'login']);
      expect(result.valid).toBe(false);
    });

    it('should deny config set', () => {
      const result = validateArgs(['config', 'set', 'editor', 'vim']);
      expect(result.valid).toBe(false);
    });

    it('should deny extension install', () => {
      const result = validateArgs(['extension', 'install', 'owner/ext']);
      expect(result.valid).toBe(false);
    });
  });

  describe('allowlist completeness', () => {
    it('should have ALWAYS_DENIED_SUBCOMMANDS as a non-empty Set', () => {
      expect(ALWAYS_DENIED_SUBCOMMANDS.size).toBeGreaterThan(0);
    });
  });
});
