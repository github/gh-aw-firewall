import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'export-audit.md');
const lockPath = path.join(workflowsDir, 'export-audit.lock.yml');
const scriptPath = path.resolve(__dirname, 'export-audit-analysis.sh');

describe('export audit workflow optimization config', () => {
  it('applies weekly schedule, turn cap, and condensed prompt in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Rec 1: trigger changed to weekly schedule
    expect(source).toContain("cron: '0 9 * * 1'");
    expect(source).not.toContain('push:');

    // Rec 2: max-turns reduced
    expect(source).toContain('max-turns: 6');
    expect(source).toContain('HARD LIMIT: You have at most 6 turns total.');
    expect(source).not.toContain('max-turns: 12');

    // Rec 3: condensed prompt — key instructions still present
    expect(source).toContain('/tmp/gh-aw/agent/export-audit-context.md');
    expect(source).toContain('used_outside_defining_file=0_files');
    expect(source).toContain('use `VERIFIED_UNUSED` directly as pre-confirmed evidence');
    expect(source).toContain('If `VERIFIED_UNUSED` is empty, fall back to the normal verification flow');
    expect(source).toContain('Verify at most **3 candidates total** (not 5)');
    expect(source).toContain('Run **exactly 1 bash command**');
    expect(source).toContain('grep -vE "test|index"');
    expect(source).toContain('Total bash commands for verification: maximum 3');
    expect(source).toContain('Read `/tmp/gh-aw/agent/export-audit-context.md` first.');

    // Rec 5: consolidated single step replaces 9 steps
    expect(source).toContain('Run export audit analysis');
    expect(source).toContain('scripts/ci/export-audit-analysis.sh');
    expect(source).not.toContain('Build export audit context');
    expect(source).not.toContain('Pre-verify unused exports (top 10)');
    expect(source).not.toContain('id: verified_unused');
    expect(source).not.toContain('printf \'%s\\n\' "$GH_AW_STEPS_TS_ERRORS_OUTPUTS_TS_ERRORS"');
    expect(source).not.toContain('TypeScript build output:\n```\n${{ steps.ts-errors.outputs.TS_ERRORS }}');
    expect(source).not.toContain('To control token usage, limit verification to the **top 5 candidates** by score.');
    expect(source).not.toContain('Run at most 2 bash commands to confirm');
    expect(source).not.toContain('### Recommended Fix');
  });

  it('export-audit-analysis.sh contains reduced head limits and analysis logic', () => {
    const script = fs.readFileSync(scriptPath, 'utf-8');

    // Rec 4: reduced head limits
    expect(script).toContain('head -30');      // exports: was head -80
    expect(script).toContain('head -15');      // unused: was head -40
    expect(script).toContain('head -10');      // naming: was head -20
    expect(script).toContain('head -8');       // test files: max 8 files
    expect(script).toContain('head -3');       // test imports: 3 lines/file
    expect(script).not.toContain('head -80');

    // Pre-verify logic preserved
    expect(script).toContain("^UNUSED: [^[:space:]]+ \\([^)]*\\)$");
    expect(script).toContain('used_outside_defining_file=${count}_files');
  });

  it('compiles schedule trigger, reduced max-turns, and consolidated step into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    // Rec 1: schedule trigger
    expect(lock).toContain('schedule:');
    expect(lock).toMatch(/cron: ['"]0 9 \* \* 1['"]/);
    expect(lock).not.toContain('push:');

    // Rec 2: reduced max-turns
    expect(lock).toContain('--max-turns 6');
    expect(lock).not.toContain('--max-turns 12');

    // Rec 5: consolidated step
    expect(lock).toContain('Run export audit analysis');
    expect(lock).toContain('export-audit-analysis.sh');
    expect(lock).toContain('/tmp/gh-aw/agent/export-audit-context.md');
    expect(lock).not.toContain('Build export audit context');
    expect(lock).not.toContain('GH_AW_STEPS_TS_ERRORS_OUTPUTS_TS_ERRORS');
    expect(lock).not.toContain('Pre-verify unused exports (top 10)');
    expect(lock).not.toContain('TypeScript build output:\n```');

    expect(lock).toMatch(/ghcr\.io\/github\/github-mcp-server:v1\.1\.0(?:@sha256:[a-f0-9]+)?/);
  });
});
