import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'mount-docs-maintainer.md'), 'utf8');
const lock = fs.readFileSync(path.join(workflowsDir, 'mount-docs-maintainer.lock.yml'), 'utf8');
const frontmatter = yaml.load(source.split('---')[1]);

const allowedFiles = [
  'README.md',
  'docs/mount-policy.md',
  'docs/selective-mounting.md',
  'docs/chroot-mode.md',
  'docs/arc-dind.md',
  'docs/sbx-integration.md',
  'docs/gvisor-integration.md',
  'docs/cloud-hypervisor-foundation.md',
  'docs/architecture.md',
  'docs/sandbox-design.md',
  'docs/environment.md',
  'docs/usage.md',
  'docs/awf-config-spec.md',
];

describe('mount documentation maintainer workflow', () => {
  it('audits main daily, supports manual runs, and waits for its previous PR', () => {
    expect(frontmatter).toMatchObject({
      on: {
        schedule: 'daily',
        workflow_dispatch: null,
        'skip-if-match': {
          query: 'is:pr is:open in:title "[mount-docs]"',
          max: 1,
        },
      },
      checkout: { ref: 'main' },
      permissions: {
        contents: 'read',
        'pull-requests': 'read',
        'copilot-requests': 'write',
      },
      network: { allowed: [] },
      'safe-outputs': {
        'report-incomplete': { 'create-issue': false },
        'create-pull-request': {
          'title-prefix': '[mount-docs] ',
          'base-branch': 'main',
          draft: true,
          max: 1,
          'allowed-files': allowedFiles,
        },
      },
    });
  });

  it('compiles a daily schedule and read-only agent with the same main checkout', () => {
    expect(yaml.load(lock)).toMatchObject({
      on: {
        schedule: [{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }],
        workflow_dispatch: expect.any(Object),
      },
      jobs: {
        agent: {
          permissions: {
            contents: 'read',
            'pull-requests': 'read',
            'copilot-requests': 'write',
          },
          steps: expect.arrayContaining([
            expect.objectContaining({ with: expect.objectContaining({ ref: 'main' }) }),
          ]),
        },
      },
    });
    expect(lock).toContain('GH_AW_SKIP_QUERY: "is:pr is:open in:title \\"[mount-docs]\\""');
    expect(lock).toContain('\\"base_branch\\":\\"main\\"');
    expect(lock).toContain('\\"draft\\":true');
    expect(lock).toContain('\\"allowed_files\\":');
    for (const file of allowedFiles) {
      expect(lock).toContain(`\\"${file}\\"`);
      expect(fs.existsSync(path.resolve(workflowsDir, '../..', file))).toBe(true);
    }
    expect(lock).toContain('install_awf_binary.sh');
    expect(lock).not.toContain('--build-local');
  });

  it('requires production evidence, a full-state audit, and explicit no-op behavior', () => {
    for (const evidence of [
      'src/config/sandbox-mount-policy.json',
      'src/services/agent-volumes/',
      'containers/agent/entrypoint.sh',
      'src/sbx-manager.ts',
      'src/cloud-hypervisor/exports.ts',
      'src/cloud-hypervisor/enclave-export-plan.ts',
      'src/microvm/workspace.ts',
    ]) {
      expect(source).toContain(evidence);
      expect(fs.existsSync(path.resolve(workflowsDir, '../..', evidence))).toBe(true);
    }
    expect(source).toContain('Audit the current state on every run, not just recent commits');
    expect(source).toContain('Trace production callers');
    expect(source).toContain('git diff --check');
    expect(source).toContain('call `noop`');
    expect(source).toContain('evidence is insufficient');
  });
});
