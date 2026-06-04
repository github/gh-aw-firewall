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
    expect(source).toContain('Export workflow context');
    expect(source).toContain('/tmp/gh-aw/agent/workflow-context.env');
    expect(source).toContain('<< ENVEOF');
    expect(source).not.toContain("<< 'ENVEOF'");
    expect(source).toContain('**CRITICAL — Single Response Execution:**');
    expect(source).toContain('`max-turns: 5` is a hard cap for safety.');
    expect(source).toContain('## Expected Commands');
    expect(source).toContain('source /tmp/gh-aw/agent/workflow-context.env');
    expect(source).toContain('safeoutputs add_comment . < /tmp/gh-aw/agent/result.json');
    expect(source).toContain("Use the `safeoutputs` CLI (`add_comment`, `add_labels`, `noop`) with real arguments.");
    expect(source).toContain('Do not use pipe-to-stdin for safeoutputs JSON payloads.');
    expect(source).toContain('Never call `add_comment` or `add_labels` with empty arguments');
    expect(source).toContain('Report turn usage');
    expect(source).toContain('GH_AW_TURN_COUNT');
    expect(source).not.toContain('Show final Claude Code config');
    expect(source).not.toContain('tools:\n  playwright:');
    expect(source).not.toContain('    - playwright');
    expect(source).not.toContain('Ensure playwright log directory is writable');
  });

  it('compiles the workflow without playwright tools and with max-turns 5', () => {
    const lock = fs.readFileSync(smokeClaudeLockPath, 'utf-8');

    expect(lock).toContain('--max-turns 5');
    expect(lock).toContain('Check GitHub.com reachability');
    expect(lock).toContain('playwright_check=✅ PASS');
    expect(lock).toContain('Export workflow context');
    expect(lock).toContain('<< ENVEOF');
    expect(lock).not.toContain("<< 'ENVEOF'");
    expect(lock).toContain('Report turn usage');
    expect(lock).toContain('target: 1, hard cap: 2');
    expect(lock).toContain(
      'github/gh-aw-actions/setup@3ea13c02d765410340d533515cb31a7eef2baaf0 # v0.77.5'
    );
    expect(lock).not.toContain('mcp__playwright__browser_navigate');
    expect(lock).not.toContain('playwright_prompt.md');
    expect(lock).not.toContain('mcr.microsoft.com/playwright/mcp');
    expect(lock).not.toContain('Show final Claude Code config');
  });
});
