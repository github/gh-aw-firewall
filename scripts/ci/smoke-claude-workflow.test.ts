import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeClaudeSourcePath = path.join(workflowsDir, 'smoke-claude.md');
const smokeClaudeLockPath = path.join(workflowsDir, 'smoke-claude.lock.yml');

describe('smoke claude workflow optimization config', () => {
  it('uses pre-computed result step and minimal turn budget in source workflow', () => {
    const source = fs.readFileSync(smokeClaudeSourcePath, 'utf-8');

    expect(source).toContain('max-turns: 8');
    expect(source).toContain('Check GitHub.com reachability');
    expect(source).toContain('/tmp/gh-aw/agent/smoke-context.txt');
    expect(source).toContain('curl -fsSL --max-time 15 https://github.com');
    expect(source).not.toContain("grep -oP '(?<=<title>)[^<]+'");
    expect(source).toContain('> "$CONTEXT_FILE"');
    expect(source).toContain('Compute final smoke result');
    expect(source).toContain('/tmp/gh-aw/agent/final-result.json');
    expect(source).toContain("echo \"$GH_CHECK\" | grep -q '✅'");
    expect(source).not.toContain('Export workflow context');
    expect(source).not.toContain('workflow-context.env');
    expect(source).toContain('github: false');
    expect(source).not.toContain('bash:\n    - "*"');
    expect(source).toContain('After calling safeoutputs, stop immediately.');
    expect(source).toContain('Never call `add_comment` or `add_labels` with empty arguments or as a schema probe.');
    expect(source).toContain('Pass arguments inline as a single JSON object');
    expect(source).toContain('Report turn usage');
    expect(source).toContain('GH_AW_TURN_COUNT');
    expect(source).not.toContain('Show final Claude Code config');
    expect(source).not.toContain('tools:\n  playwright:');
    expect(source).not.toContain('    - playwright');
    expect(source).not.toContain('Ensure playwright log directory is writable');
    // Old bash-script-in-prompt patterns removed
    expect(source).not.toContain('source /tmp/gh-aw/agent/workflow-context.env');
    expect(source).not.toContain('safeoutputs add_comment . < /tmp/gh-aw/agent/result.json');
    expect(source).not.toContain('safeoutputs add_labels . < /tmp/gh-aw/agent/labels.json');
  });

  it('compiles the workflow without playwright tools and with max-turns 8', () => {
    const lock = fs.readFileSync(smokeClaudeLockPath, 'utf-8');

    expect(lock).toContain('--max-turns 8');
    expect(lock).toContain('Check GitHub.com reachability');
    expect(lock).toContain('playwright_check=✅ PASS');
    expect(lock).toContain('Compute final smoke result');
    expect(lock).toContain('final-result.json');
    expect(lock).not.toContain('Export workflow context');
    expect(lock).not.toContain('<< ENVEOF');
    expect(lock).toContain('Report turn usage');
    expect(lock).toContain('target: 1');
    expect(lock).toMatch(/github\/gh-aw-actions\/setup@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
    expect(lock).not.toContain('mcp__playwright__browser_navigate');
    expect(lock).not.toContain('playwright_prompt.md');
    expect(lock).not.toContain('mcr.microsoft.com/playwright/mcp');
    expect(lock).not.toContain('Show final Claude Code config');
  });
});
