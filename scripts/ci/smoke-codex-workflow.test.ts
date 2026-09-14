import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeCodexSourcePath = path.join(workflowsDir, 'smoke-codex.md');
const smokeCodexLockPath = path.join(workflowsDir, 'smoke-codex.lock.yml');

describe('smoke codex workflow output requirements', () => {
  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**, call `add_comment`');
    expect(source).toContain('If all tests pass on a pull request trigger:');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`');
    expect(source).toContain('Do NOT attempt to add pull request comments or labels when there is no pull request.');
  });
});

describe('smoke codex discussion comment configuration', () => {
  it('enables discussion targeting for add-comment in the workflow source', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    const addCommentBlock = source.match(/ {4}add-comment:\n(?: {6}.+\n)+/);
    expect(addCommentBlock).not.toBeNull();
    expect(addCommentBlock![0]).toContain('discussions: true');
    expect(addCommentBlock![0]).toContain('target: "*"');
  });

  it('grants discussions write permission in the compiled lock file', () => {
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');

    expect(lock).toContain('discussions: write');
    expect(lock).toContain('\\"add_comment\\":{\\"discussions\\":true');
  });
});
