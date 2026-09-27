import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const copilotSmokeWorkflows = [
  { name: 'smoke-copilot-byok-aoai-apikey', file: 'smoke-copilot-byok-aoai-apikey.md' },
  { name: 'smoke-copilot-byok-aoai-entra', file: 'smoke-copilot-byok-aoai-entra.md' },
  { name: 'smoke-copilot-byok', file: 'smoke-copilot-byok.md' },
  { name: 'smoke-copilot', file: 'smoke-copilot.md' },
  { name: 'smoke-copilot-network-isolation', file: 'smoke-copilot-network-isolation.md' },
];

describe('smoke copilot workflow output requirements', () => {
  for (const workflow of copilotSmokeWorkflows) {
    it(`${workflow.name}: requires noop fallback when no pull request context exists`, () => {
      const source = fs.readFileSync(path.join(workflowsDir, workflow.file), 'utf-8');

      expect(source).toContain('**If triggered by a pull request**');
      expect(source).toContain('If all tests pass on a pull request trigger:');
      expect(source).toContain(
        '**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`'
      );
      expect(source).toContain(
        'Do NOT attempt to add pull request comments or labels when there is no pull request.'
      );
    });
  }

  it('smoke-copilot-network-isolation: grants granular curl shell permission', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot-network-isolation.md'),
      'utf-8'
    );
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot-network-isolation.lock.yml'),
      'utf-8'
    );

    expect(source).toContain('    - curl');
    expect(source).toContain('    - echo');
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(echo)'\\''");
  });
});
