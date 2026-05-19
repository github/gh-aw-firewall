import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadAndMergeDomains } from './rules';

describe('rules', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-rules-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function writeRuleFile(name: string, content: string): string {
    const filePath = path.join(testDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  describe('loadAndMergeDomains (ruleset parsing)', () => {
    it('should parse a valid YAML ruleset', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
    subdomains: true
  - domain: npmjs.org
    subdomains: false
`);
      const result = loadAndMergeDomains([filePath], []);
      expect(result).toEqual(['github.com', 'npmjs.org']);
    });

    it('should allow domains when subdomains is not specified', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
`);
      const result = loadAndMergeDomains([filePath], []);
      expect(result).toEqual(['github.com']);
    });

    it('should throw for missing file', () => {
      expect(() => loadAndMergeDomains(['/nonexistent/rules.yml'], [])).toThrow(
        'Ruleset file not found: /nonexistent/rules.yml'
      );
    });

    it('should throw for invalid YAML', () => {
      const filePath = writeRuleFile('bad.yml', '{ invalid yaml: [}');
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('Invalid YAML');
    });

    it('should throw for empty file', () => {
      const filePath = writeRuleFile('empty.yml', '');
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('is empty');
    });

    it('should throw for missing version field', () => {
      const filePath = writeRuleFile('no-version.yml', `
rules:
  - domain: github.com
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('missing required "version" field');
    });

    it('should throw for unsupported version', () => {
      const filePath = writeRuleFile('bad-version.yml', `
version: 2
rules:
  - domain: github.com
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('Unsupported ruleset version 2');
    });

    it('should throw for missing rules field', () => {
      const filePath = writeRuleFile('no-rules.yml', `
version: 1
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('missing required "rules" field');
    });

    it('should throw for non-array rules', () => {
      const filePath = writeRuleFile('bad-rules.yml', `
version: 1
rules: "not an array"
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('"rules" field in');
    });

    it('should throw for rule without domain', () => {
      const filePath = writeRuleFile('no-domain.yml', `
version: 1
rules:
  - subdomains: true
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('missing required "domain" string field');
    });

    it('should throw for rule with empty domain', () => {
      const filePath = writeRuleFile('empty-domain.yml', `
version: 1
rules:
  - domain: "  "
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('empty "domain" field');
    });

    it('should throw for non-boolean subdomains', () => {
      const filePath = writeRuleFile('bad-subdomains.yml', `
version: 1
rules:
  - domain: github.com
    subdomains: "yes"
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('"subdomains" must be a boolean');
    });

    it('should throw for non-object rule', () => {
      const filePath = writeRuleFile('string-rule.yml', `
version: 1
rules:
  - "github.com"
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('must be an object');
    });

    it('should throw for non-object top level', () => {
      const filePath = writeRuleFile('array.yml', `
- github.com
- npmjs.org
`);
      expect(() => loadAndMergeDomains([filePath], [])).toThrow('must contain a YAML object');
    });

    it('should handle an empty rules array', () => {
      const filePath = writeRuleFile('empty-rules.yml', `
version: 1
rules: []
`);
      const result = loadAndMergeDomains([filePath], []);
      expect(result).toEqual([]);
    });
  });

  describe('loadAndMergeDomains', () => {
    it('should merge file domains with CLI domains', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
  - domain: npmjs.org
`);

      const result = loadAndMergeDomains([filePath], ['api.example.com']);
      expect(result).toContain('api.example.com');
      expect(result).toContain('github.com');
      expect(result).toContain('npmjs.org');
      expect(result).toHaveLength(3);
    });

    it('should deduplicate across CLI and file domains', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
`);

      const result = loadAndMergeDomains([filePath], ['github.com', 'npmjs.org']);
      expect(result).toEqual(['github.com', 'npmjs.org']);
    });

    it('should merge multiple ruleset files', () => {
      const file1 = writeRuleFile('rules1.yml', `
version: 1
rules:
  - domain: github.com
`);
      const file2 = writeRuleFile('rules2.yml', `
version: 1
rules:
  - domain: npmjs.org
`);

      const result = loadAndMergeDomains([file1, file2], []);
      expect(result).toEqual(['github.com', 'npmjs.org']);
    });

    it('should deduplicate domains across multiple ruleset files', () => {
      const file1 = writeRuleFile('rules1.yml', `
version: 1
rules:
  - domain: github.com
  - domain: npmjs.org
`);
      const file2 = writeRuleFile('rules2.yml', `
version: 1
rules:
  - domain: github.com
  - domain: pypi.org
`);

      const result = loadAndMergeDomains([file1, file2], []);
      expect(result).toEqual(['github.com', 'npmjs.org', 'pypi.org']);
    });

    it('should work with no CLI domains', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
`);

      const result = loadAndMergeDomains([filePath], []);
      expect(result).toEqual(['github.com']);
    });

    it('should work with no ruleset files', () => {
      const result = loadAndMergeDomains([], ['github.com']);
      expect(result).toEqual(['github.com']);
    });
  });
});
