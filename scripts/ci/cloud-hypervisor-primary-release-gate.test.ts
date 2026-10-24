const { REQUIRED_PATHS, verifyPrimaryReleaseCheckout } = require('./cloud-hypervisor-primary-release-gate');

const commit = 'a'.repeat(40);
const acceptance = 'b'.repeat(40);
const tag = 'v1.2.3';

function fixture() {
  const environment = {
    GITHUB_REPOSITORY: 'github/gh-aw-firewall',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: tag,
    GITHUB_REF: `refs/tags/${tag}`,
    GITHUB_WORKFLOW_REF: `github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml@refs/tags/${tag}`,
    GITHUB_SHA: commit,
    GITHUB_WORKFLOW_SHA: commit,
    AWF_ACCEPTANCE_COMMIT: acceptance,
  };
  const git = jest.fn((...args: string[]) => {
    if (args[0] === 'rev-parse') return commit;
    if (args.join(' ') === `merge-base --is-ancestor ${acceptance} ${commit}`) return '';
    if (args[0] === 'cat-file' && REQUIRED_PATHS.some((file: string) => args[2] === `${acceptance}:${file}`)) return '';
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  });
  const readJson = jest.fn((file: string): Record<string, string> => {
    if (file === 'package.json') return { version: tag.slice(1) };
    if (file === 'src/cloud-hypervisor/artifact-compatibility.json') return { releaseTag: tag };
    throw new Error(`Unexpected JSON file: ${file}`);
  });
  return { environment, git, readJson };
}

describe('primary release checkout admission', () => {
  it('binds native dispatch to package, compatibility tag, source and reviewed harness ancestry', () => {
    const f = fixture();
    expect(verifyPrimaryReleaseCheckout(f.environment, f)).toEqual({ tag, commit });
    expect(f.git).toHaveBeenCalledWith('merge-base', '--is-ancestor', acceptance, commit);
    for (const file of REQUIRED_PATHS) {
      expect(f.git).toHaveBeenCalledWith('cat-file', '-e', `${acceptance}:${file}`);
      expect(fs.existsSync(path.join(__dirname, '../..', file))).toBe(true);
    }
  });

  it.each([
    ['GITHUB_REPOSITORY', 'attacker/fork'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REF_TYPE', 'branch'],
    ['GITHUB_REF_NAME', '--help'],
    ['GITHUB_REF', 'refs/heads/main'],
    ['GITHUB_WORKFLOW_REF', 'github/gh-aw-firewall/.github/workflows/other.yml@refs/tags/v1.2.3'],
    ['AWF_ACCEPTANCE_COMMIT', ''],
    ['AWF_ACCEPTANCE_COMMIT', '--help'],
  ])('rejects invalid %s before git access', (key, value) => {
    const f = fixture();
    expect(() => verifyPrimaryReleaseCheckout({ ...f.environment, [key]: value }, f)).toThrow();
    expect(f.git).not.toHaveBeenCalled();
    expect(f.readJson).not.toHaveBeenCalled();
  });

  it.each(['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA'])('rejects mismatched %s', key => {
    const f = fixture();
    expect(() => verifyPrimaryReleaseCheckout({ ...f.environment, [key]: acceptance }, f)).toThrow(/identities/);
  });

  it.each(['package.json', 'src/cloud-hypervisor/artifact-compatibility.json'])(
    'rejects mismatched %s', file => {
      const f = fixture();
      const original = f.readJson.getMockImplementation()!;
      f.readJson.mockImplementation(name => name === file ? {} : original(name));
      expect(() => verifyPrimaryReleaseCheckout(f.environment, f)).toThrow(/identities/);
    },
  );

  it.each(['HEAD', `refs/tags/${tag}^{commit}`])('rejects mismatched revision %s', revision => {
    const f = fixture();
    const original = f.git.getMockImplementation()!;
    f.git.mockImplementation((...args) => args[0] === 'rev-parse' && args[1] === revision
      ? acceptance : original(...args));
    expect(() => verifyPrimaryReleaseCheckout(f.environment, f)).toThrow(/identities/);
  });

  it.each(['merge-base', 'cat-file'])('fails closed on missing ancestry or harness (%s)', command => {
    const f = fixture();
    const original = f.git.getMockImplementation()!;
    f.git.mockImplementation((...args) => {
      if (args[0] === command) throw new Error('git rejected identity');
      return original(...args);
    });
    expect(() => verifyPrimaryReleaseCheckout(f.environment, f)).toThrow('git rejected identity');
  });
});
import * as fs from 'fs';
import * as path from 'path';
