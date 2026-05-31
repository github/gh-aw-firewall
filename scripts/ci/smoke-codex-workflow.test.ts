import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeCodexSourcePath = path.join(workflowsDir, 'smoke-codex.md');

describe('smoke codex workflow output requirements', () => {
  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**, call `add_comment`');
    expect(source).toContain('If all tests pass on a pull request trigger:');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`');
    expect(source).toContain('Do NOT attempt to add pull request comments or labels when there is no pull request.');
  });
});
