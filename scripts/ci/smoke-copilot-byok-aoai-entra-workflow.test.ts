import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowSourcePath = path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.md');

describe('smoke copilot byok aoai entra workflow output requirements', () => {
  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(workflowSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**, call `add_comment` to post a **very brief** comment');
    expect(source).toContain('If all tests pass on a pull request trigger, call `add_labels` to add the label `smoke-copilot-byok-aoai-entra`');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`');
    expect(source).toContain('Do NOT attempt to add pull request comments or labels when there is no pull request.');
  });
});
