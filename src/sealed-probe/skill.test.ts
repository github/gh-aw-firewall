import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_SKILL_PATH, resolveSealedProbePaths } from './paths';
import { generateSealedProbeSkill, writeSealedProbeSkill } from './skill';

describe('generateSealedProbeSkill', () => {
  const skill = generateSealedProbeSkill({
    repos: ['octo/alpha', 'octo/beta'],
    timeoutSeconds: 45,
    maxInvocations: 9,
  });

  it('carries skill frontmatter so the document is self-describing', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: sealed-probe');
    expect(skill).toContain('description:');
  });

  it('lists exactly the configured repositories', () => {
    expect(skill).toContain('- `octo/alpha`');
    expect(skill).toContain('- `octo/beta`');
    expect(skill).toContain('Any other repository is rejected.');
  });

  it('documents the fixed CLI contract and its refusals', () => {
    expect(skill).toContain('--repo owner/repo');
    expect(skill).toContain('--outcome');
    expect(skill).toContain('exactly one `--repo`');
    expect(skill).toContain('You cannot choose the image, command, interpreter,');
  });

  it('documents the script contract against /probe/repo and /probe/out', () => {
    expect(skill).toContain('/probe/repo');
    expect(skill).toContain('/probe/out');
    expect(skill).toContain('standard library only');
  });

  it('states the configured budget and the two-bit capacity', () => {
    expect(skill).toContain('at most 45 second(s)');
    expect(skill).toContain('At most 9 invocation(s)');
    expect(skill).toContain('at most 2 bits');
  });

  it('warns that all failures are indistinguishable', () => {
    expect(skill).toContain('{"result":"ERROR"}');
    expect(skill).toContain('indistinguishable from each other by design');
  });

  it('never suggests the agent can read the repository directly', () => {
    expect(skill).toContain('no network, no credentials, no host access');
  });
});

describe('writeSealedProbeSkill', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-skill-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the skill into the AWF-owned agent artifact directory only', () => {
    const paths = resolveSealedProbePaths(workDir);
    const containerPath = writeSealedProbeSkill(paths, {
      repos: ['octo/alpha'],
      timeoutSeconds: 30,
      maxInvocations: 32,
    });

    expect(containerPath).toBe(AGENT_SKILL_PATH);
    expect(paths.skillPath.startsWith(workDir)).toBe(true);
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
