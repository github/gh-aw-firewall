import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const readyForCiLockFiles = [
  'build-test.lock.yml',
  'contribution-check.lock.yml',
  'smoke-claude.lock.yml',
  'smoke-chroot.lock.yml',
  'smoke-codex.lock.yml',
  'smoke-copilot-byok-aoai-apikey.lock.yml',
  'smoke-copilot-byok-aoai-entra.lock.yml',
  'smoke-copilot-byok.lock.yml',
  'smoke-copilot-pat.lock.yml',
  'smoke-copilot.lock.yml',
  'smoke-gemini.lock.yml',
  'smoke-otel-tracing.lock.yml',
  'smoke-services.lock.yml',
];

const activationGuard = "github.event.label.name == 'ready-for-aw'";

describe('ready-for-aw workflow gating', () => {
  it('grants ci-gate issues write permission and recognizes copilot reviewer logins', () => {
    const gateWorkflow = fs.readFileSync(path.join(workflowsDir, 'ci-gate.yml'), 'utf-8');

    expect(gateWorkflow).toContain('issues: write');
    expect(gateWorkflow).toContain('copilot-pull-request-reviewer');
    expect(gateWorkflow).toContain('copilot-pull-request-reviewer[bot]');
    expect(gateWorkflow).toContain("const LABEL = 'ready-for-aw'");
  });

  it.each(readyForCiLockFiles)('%s only activates for ready-for-aw on same-repo PRs', workflow => {
    const lock = fs.readFileSync(path.join(workflowsDir, workflow), 'utf-8');

    expect(lock).toContain(activationGuard);
  });

  it('security-guard.lock.yml uses label_command trigger for ready-for-aw', () => {
    const lock = fs.readFileSync(path.join(workflowsDir, 'security-guard.lock.yml'), 'utf-8');
    expect(lock).toContain('labeled');
    expect(lock).toContain('label_command');
  });

  it('security-guard.md references ready-for-aw label', () => {
    const md = fs.readFileSync(path.join(workflowsDir, 'security-guard.md'), 'utf-8');
    expect(md).toContain('ready-for-aw');
  });
});
