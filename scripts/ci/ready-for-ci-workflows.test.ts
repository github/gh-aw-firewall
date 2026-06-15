import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const readyForCiLockFiles = [
  'build-test.lock.yml',
  'contribution-check.lock.yml',
  'security-guard.lock.yml',
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

const activationGuard = [
  "if: >",
  "      (github.event_name == 'pull_request' && github.event.label.name == 'ready-for-ci'",
  "      && github.event.pull_request.head.repo.id == github.repository_id)",
  "      || github.event_name != 'pull_request'",
].join('\n');

describe('ready-for-ci workflow gating', () => {
  it('grants ci-gate issues write permission and recognizes the copilot reviewer login', () => {
    const gateWorkflow = fs.readFileSync(path.join(workflowsDir, 'ci-gate.yml'), 'utf-8');

    expect(gateWorkflow).toContain('issues: write');
    expect(gateWorkflow).toContain("const copilotReviewers = new Set(['copilot', 'copilot[bot]', 'Copilot']);");
    expect(gateWorkflow).toContain('const isCopilotReviewer = login => copilotReviewers.has(login ?? \'\');');
  });

  it.each(readyForCiLockFiles)('%s only activates for ready-for-ci on same-repo PRs', workflow => {
    const lock = fs.readFileSync(path.join(workflowsDir, workflow), 'utf-8');

    expect(lock).toContain(activationGuard);
  });
});
