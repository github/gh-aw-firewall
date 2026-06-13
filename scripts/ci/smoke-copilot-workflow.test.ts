import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const copilotSmokeWorkflows = [
  { name: 'smoke-copilot-byok-aoai-apikey', file: 'smoke-copilot-byok-aoai-apikey.md' },
  { name: 'smoke-copilot-byok-aoai-entra', file: 'smoke-copilot-byok-aoai-entra.md' },
  { name: 'smoke-copilot-byok', file: 'smoke-copilot-byok.md' },
  { name: 'smoke-copilot', file: 'smoke-copilot.md' },
  { name: 'smoke-copilot-pat', file: 'smoke-copilot-pat.md' },
];

describe('smoke copilot workflow output requirements', () => {
  for (const workflow of copilotSmokeWorkflows) {
    it(`${workflow.name}: requires noop fallback when no pull request context exists`, () => {
      const source = fs.readFileSync(path.join(workflowsDir, workflow.file), 'utf-8');

      expect(source).toContain('**If triggered by a pull request**, call `add_comment`');
      expect(source).toContain('If all tests pass on a pull request trigger:');
      expect(source).toContain(
        '**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`'
      );
      expect(source).toContain(
        'Do NOT attempt to add pull request comments or labels when there is no pull request.'
      );
    });
  }
});
