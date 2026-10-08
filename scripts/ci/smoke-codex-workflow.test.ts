import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeCodexSourcePath = path.join(workflowsDir, 'smoke-codex.md');
const smokeCodexLockPath = path.join(workflowsDir, 'smoke-codex.lock.yml');

describe('smoke codex token-usage verification', () => {
  it('runs only after the agent succeeds in both source and compiled workflow', () => {
    for (const workflowPath of [smokeCodexSourcePath, smokeCodexLockPath]) {
      const workflow = fs.readFileSync(workflowPath, 'utf-8');

      expect(workflow).toMatch(
        /^[ \t]*verify_token_usage:[ \t]*\r?\n(?:[ \t]+name:[^\r\n]*\r?\n)?[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result == 'success'[ \t]*$/m,
      );
      expect(workflow).toContain(
        'check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine codex',
      );
    }
  });
});

describe('smoke codex workflow output requirements', () => {
  it('pins Playwright CLI to a version available outside the npm release cooldown', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');

    expect(source).toContain('playwright:\n    version: "0.1.21"');
    expect(lock).toContain('npm install -g @playwright/cli@0.1.21');
  });

  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**, call `add_comment`');
    expect(source).toContain('If all tests pass on a pull request trigger:');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`');
    expect(source).toContain('Do NOT attempt to add pull request comments or labels when there is no pull request.');
  });

  it('uses inline safe-output arguments in a login shell for comments', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain(`/bin/bash -lc 'safeoutputs add_comment "$1"' --`);
    expect(source).toContain('Do not build comment payloads with `jq`');
    expect(source).toContain('retry from a non-login shell');
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

  it('uses item_number when commenting on a discussion', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('`item_number: <extracted_number>`');
    expect(source).not.toContain('discussion_number');
  });

  it('grants discussions write permission in the compiled lock file', () => {
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');

    expect(lock).toContain('discussions: write');
    expect(lock).toContain('\\"add_comment\\":{\\"discussions\\":true');
  });
});
