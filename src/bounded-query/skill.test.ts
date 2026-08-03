import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_SKILL_PATH, resolveBoundedQueryPaths } from './paths';
import { generateBoundedQuerySkill, writeBoundedQuerySkill } from './skill';

describe('generateBoundedQuerySkill', () => {
  const skill = generateBoundedQuerySkill({
    repos: [
      { repo: 'octo/alpha', sensitivity: 'internal' },
      { repo: 'octo/beta', sensitivity: 'confidential' },
      { repo: 'octo/gamma', sensitivity: 'public' },
      { repo: 'octo/delta', sensitivity: 'sealed' },
    ],
    timeoutSeconds: 45,
    maxInvocations: 9,
  });

  it('carries skill frontmatter so the document is self-describing', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: bounded-query');
    expect(skill).toContain('description:');
  });

  it('lists exactly the configured repositories with their sensitivity and run budget', () => {
    expect(skill).toContain('- `octo/alpha` — 64 bits/run (`internal`)');
    expect(skill).toContain('- `octo/beta` — 8 bits/run (`confidential`)');
    expect(skill).toContain('- `octo/gamma` — unmetered (`public`)');
    expect(skill).toContain('- `octo/delta` — 0 bits/run (`sealed` — never runs a script)');
    expect(skill).toContain('Any other repository is rejected.');
  });

  it('documents the fixed v2 CLI contract and its refusals', () => {
    expect(skill).toContain('--repo owner/repo');
    expect(skill).toContain('--schema');
    expect(skill).toContain('exactly one `--repo`');
    expect(skill).toContain('exactly one `--schema`');
    expect(skill).toMatch(/You cannot choose the image, command,\s+interpreter,/);
  });

  it('documents every finite schema construct', () => {
    for (const kind of ['const', 'boolean', 'enum', 'integer', 'object', 'tuple', 'array', 'union']) {
      expect(skill).toContain(`\`${kind}\``);
    }
    expect(skill).toContain('not** general\nJSON Schema');
  });

  it('documents the script contract against /query/repo and /query/out', () => {
    expect(skill).toContain('/query/repo');
    expect(skill).toContain('/query/out');
    expect(skill).toContain('standard library only');
  });

  it('states the configured operational budget and the per-invocation bit charge formula', () => {
    expect(skill).toContain('at most 45 second(s)');
    expect(skill).toContain('At most 9 invocation(s)');
    expect(skill).toContain('1 (ok/error) + ceil(log2(schema cardinality)) + 3 (timing)');
  });

  it('documents the canonical error and that failures are indistinguishable', () => {
    expect(skill).toContain('{"status":"error"}');
    expect(skill).toMatch(/indistinguishable from\s+each other by design/);
  });

  it('never suggests the agent can read the repository directly', () => {
    expect(skill).toContain('no network, no credentials, no host access');
  });
});

describe('writeBoundedQuerySkill', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-skill-'));
  });

  afterEach(() => {
    const paths = resolveBoundedQueryPaths(workDir);
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the skill into the AWF-owned agent artifact directory only', () => {
    const paths = resolveBoundedQueryPaths(workDir);
    const containerPath = writeBoundedQuerySkill(paths, {
      repos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
      timeoutSeconds: 30,
      maxInvocations: 32,
    });

    expect(containerPath).toBe(AGENT_SKILL_PATH);
    expect(paths.skillPath.startsWith(paths.ingressRoot)).toBe(true);
    expect(paths.skillPath.startsWith(workDir)).toBe(false);
    // Open with O_NOFOLLOW to avoid TOCTOU between stat and read.
    const fd = fs.openSync(paths.skillPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      expect(stat.mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(fd, 'utf8')).toContain('octo/alpha');
    } finally {
      fs.closeSync(fd);
    }
  });
});
