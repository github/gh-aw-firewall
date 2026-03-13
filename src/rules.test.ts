import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadRuleSet, mergeRuleSets, expandRule, loadAndMergeDomains, RuleSet } from './rules';

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

  describe('loadRuleSet', () => {
    it('should parse a valid YAML ruleset', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
    subdomains: true
  - domain: npmjs.org
    subdomains: false
`);
      const result = loadRuleSet(filePath);
      expect(result.version).toBe(1);
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0]).toEqual({ domain: 'github.com', subdomains: true });
      expect(result.rules[1]).toEqual({ domain: 'npmjs.org', subdomains: false });
    });

    it('should default subdomains to true when not specified', () => {
      const filePath = writeRuleFile('rules.yml', `
version: 1
rules:
  - domain: github.com
`);
      const result = loadRuleSet(filePath);
      expect(result.rules[0].subdomains).toBe(true);
    });

    it('should throw for missing file', () => {
      expect(() => loadRuleSet('/nonexistent/rules.yml')).toThrow(
        'Ruleset file not found: /nonexistent/rules.yml'
      );
    });

    it('should throw for invalid YAML', () => {
      const filePath = writeRuleFile('bad.yml', '{ invalid yaml: [}');
      expect(() => loadRuleSet(filePath)).toThrow('Invalid YAML');
    });

    it('should throw for empty file', () => {
      const filePath = writeRuleFile('empty.yml', '');
      expect(() => loadRuleSet(filePath)).toThrow('is empty');
    });

    it('should throw for missing version field', () => {
      const filePath = writeRuleFile('no-version.yml', `
rules:
  - domain: github.com
`);
      expect(() => loadRuleSet(filePath)).toThrow('missing required "version" field');
    });

    it('should throw for unsupported version', () => {
      const filePath = writeRuleFile('bad-version.yml', `
version: 2
rules:
  - domain: github.com
`);
      expect(() => loadRuleSet(filePath)).toThrow('Unsupported ruleset version 2');
    });

    it('should throw for missing rules field', () => {
      const filePath = writeRuleFile('no-rules.yml', `
version: 1
`);
      expect(() => loadRuleSet(filePath)).toThrow('missing required "rules" field');
    });

    it('should throw for non-array rules', () => {
      const filePath = writeRuleFile('bad-rules.yml', `
version: 1
rules: "not an array"
`);
      expect(() => loadRuleSet(filePath)).toThrow('"rules" field in');
    });

    it('should throw for rule without domain', () => {
      const filePath = writeRuleFile('no-domain.yml', `
version: 1
rules:
  - subdomains: true
`);
      expect(() => loadRuleSet(filePath)).toThrow('missing required "domain" string field');
    });

    it('should throw for rule with empty domain', () => {
      const filePath = writeRuleFile('empty-domain.yml', `
version: 1
rules:
  - domain: "  "
`);
      expect(() => loadRuleSet(filePath)).toThrow('empty "domain" field');
    });

    it('should throw for non-boolean subdomains', () => {
      const filePath = writeRuleFile('bad-subdomains.yml', `
version: 1
rules:
  - domain: github.com
    subdomains: "yes"
`);
      expect(() => loadRuleSet(filePath)).toThrow('"subdomains" must be a boolean');
    });

    it('should throw for non-object rule', () => {
      const filePath = writeRuleFile('string-rule.yml', `
version: 1
rules:
  - "github.com"
`);
      expect(() => loadRuleSet(filePath)).toThrow('must be an object');
    });

    it('should throw for non-object top level', () => {
      const filePath = writeRuleFile('array.yml', `
- github.com
- npmjs.org
`);
      expect(() => loadRuleSet(filePath)).toThrow('must contain a YAML object');
    });

    it('should handle an empty rules array', () => {
      const filePath = writeRuleFile('empty-rules.yml', `
version: 1
rules: []
`);
      const result = loadRuleSet(filePath);
      expect(result.rules).toHaveLength(0);
    });
  });

  describe('expandRule', () => {
    it('should return the domain for subdomains: true', () => {
      expect(expandRule({ domain: 'github.com', subdomains: true })).toEqual([
        'github.com',
      ]);
    });

    it('should return the domain for subdomains: false', () => {
      expect(expandRule({ domain: 'github.com', subdomains: false })).toEqual([
        'github.com',
      ]);
    });
  });

  describe('mergeRuleSets', () => {
    it('should merge multiple rulesets and deduplicate', () => {
      const ruleSet1: RuleSet = {
        version: 1,
        rules: [
          { domain: 'github.com', subdomains: true },
          { domain: 'npmjs.org', subdomains: true },
        ],
      };
      const ruleSet2: RuleSet = {
        version: 1,
        rules: [
          { domain: 'github.com', subdomains: true }, // duplicate
          { domain: 'pypi.org', subdomains: true },
        ],
      };

      const result = mergeRuleSets([ruleSet1, ruleSet2]);
      expect(result).toEqual(['github.com', 'npmjs.org', 'pypi.org']);
    });

    it('should handle empty rulesets', () => {
      expect(mergeRuleSets([])).toEqual([]);
    });

    it('should handle rulesets with empty rules', () => {
      const ruleSet: RuleSet = { version: 1, rules: [] };
      expect(mergeRuleSets([ruleSet])).toEqual([]);
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
