import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeClaudeSourcePath = path.join(workflowsDir, 'smoke-claude.md');
const smokeClaudeLockPath = path.join(workflowsDir, 'smoke-claude.lock.yml');

describe('smoke claude workflow optimization config', () => {
  it('uses pre-step GitHub check and stricter turn budget in source workflow', () => {
    const source = fs.readFileSync(smokeClaudeSourcePath, 'utf-8');

    expect(source).toContain('max-turns: 5');
    expect(source).toContain('Check GitHub.com reachability');
    expect(source).toContain('/tmp/gh-aw/agent/smoke-context.txt');
    expect(source).toContain('curl -fsSL --max-time 15 https://github.com');
    expect(source).not.toContain("grep -oP '(?<=<title>)[^<]+'");
    expect(source).toContain('> "$CONTEXT_FILE"');
    expect(source).toContain('**IMPORTANT — Complete in 1 pass:**');
    expect(source).toContain("Use the `safeoutputs` CLI (`add_comment`, `add_labels`, `noop`) with real arguments.");
    expect(source).toContain('Do not use pipe-to-stdin for safeoutputs JSON payloads.');
    expect(source).toContain('Never call `add_comment` or `add_labels` with empty arguments');
    expect(source).not.toContain('tools:\n  playwright:');
    expect(source).not.toContain('    - playwright');
    expect(source).not.toContain('Ensure playwright log directory is writable');
  });

  it('compiles the workflow without playwright tools and with max-turns 5', () => {
    const lock = fs.readFileSync(smokeClaudeLockPath, 'utf-8');

    expect(lock).toContain('--max-turns 5');
    expect(lock).toContain('Check GitHub.com reachability');
    expect(lock).toContain('playwright_check=✅ PASS');
    expect(lock).toContain(
      'github/gh-aw-actions/setup@efa55847f72aadb03490d955263ff911bf758700 # v0.74.8'
    );
    expect(lock).not.toContain('github/gh-aw-actions/setup@v0.74.8');
    expect(lock).not.toContain('mcp__playwright__browser_navigate');
    expect(lock).not.toContain('playwright_prompt.md');
    expect(lock).not.toContain('mcr.microsoft.com/playwright/mcp');
  });
});
