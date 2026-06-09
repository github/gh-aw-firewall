import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeClaudeSourcePath = path.join(workflowsDir, 'smoke-claude.md');
const smokeClaudeLockPath = path.join(workflowsDir, 'smoke-claude.lock.yml');

describe('smoke claude workflow optimization config', () => {
  it('uses pre-step GitHub check and stricter turn budget in source workflow', () => {
    const source = fs.readFileSync(smokeClaudeSourcePath, 'utf-8');

    expect(source).toContain('max-turns: 2');
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
    expect(source).toContain('`max-turns: 2` is a hard cap for safety.');
    expect(source).toContain('github: false');
    expect(source).toContain('## Expected Commands');
    expect(source).toContain('source /tmp/gh-aw/agent/workflow-context.env');
    expect(source).toContain('safeoutputs add_comment . < /tmp/gh-aw/agent/result.json');
    expect(source).toContain('safeoutputs add_labels . < /tmp/gh-aw/agent/labels.json');
    // add_labels is conditional on TOTAL=PASS — must not be called unconditionally
    expect(source).toContain('if [ "$TOTAL" = "PASS" ]');
    // Results evaluated dynamically from context file, not hard-coded
    expect(source).toContain("echo \"$GH_CHECK\" | grep -q '✅'");
    // Explicit guard against direct MCP tool calls that caused CI probe failures
    expect(source).toContain('Do NOT call the `mcp__safeoutputs` MCP tools directly');
    expect(source).toContain('After calling safeoutputs, stop immediately.');
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

  it('compiles the workflow without playwright tools and with max-turns 2', () => {
    const lock = fs.readFileSync(smokeClaudeLockPath, 'utf-8');

    expect(lock).toContain('--max-turns 5');
    expect(lock).toContain('Check GitHub.com reachability');
    expect(lock).toContain('playwright_check=✅ PASS');
    expect(lock).toContain('Export workflow context');
    expect(lock).toContain('<< ENVEOF');
    expect(lock).not.toContain("<< 'ENVEOF'");
    expect(lock).toContain('Report turn usage');
    expect(lock).toContain('target: 1, hard cap: 2');
    expect(lock).toMatch(/github\/gh-aw-actions\/setup@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
    expect(lock).not.toContain('mcp__playwright__browser_navigate');
    expect(lock).not.toContain('playwright_prompt.md');
    expect(lock).not.toContain('mcr.microsoft.com/playwright/mcp');
    expect(lock).not.toContain('Show final Claude Code config');
  });
});
