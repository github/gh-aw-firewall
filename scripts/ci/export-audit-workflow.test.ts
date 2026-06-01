import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'export-audit.md');
const lockPath = path.join(workflowsDir, 'export-audit.lock.yml');

describe('export audit workflow optimization config', () => {
  it('applies turn cap and strict verification constraints in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 12');
    expect(source).toContain('Pre-verify unused exports (top 10)');
    expect(source).toContain('Build export audit context');
    expect(source).toContain('/tmp/gh-aw/agent/export-audit-context.md');
    expect(source).toContain('id: verified_unused');
    expect(source).toContain('printf \'%s\\n\' "$GH_AW_STEPS_TS_ERRORS_OUTPUTS_TS_ERRORS"');
    expect(source).toContain('Use `VERIFIED_UNUSED` directly as pre-confirmed evidence');
    expect(source).toContain('used_outside_defining_file=0_files');
    expect(source).toContain("^UNUSED: [^[:space:]]+ \\([^)]*\\)$");
    expect(source).toContain('If `VERIFIED_UNUSED` is empty, fall back to the normal verification flow');
    expect(source).toContain('Verify at most **3 candidates total** (not 5)');
    expect(source).toContain('Run **exactly 1 bash command**');
    expect(source).toContain('grep -vE "test|index"');
    expect(source).toContain('Total bash commands for verification: maximum 3');
    expect(source).toContain('Read `/tmp/gh-aw/agent/export-audit-context.md` first.');
    expect(source).not.toContain('${{ steps.ts-errors.outputs.TS_ERRORS }}');
    expect(source).not.toContain('To control token usage, limit verification to the **top 5 candidates** by score.');
    expect(source).not.toContain('Run at most 2 bash commands to confirm');
    expect(source).not.toContain('### Recommended Fix');
  });

  it('compiles max-turns and pre-verification output into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('--max-turns 12');
    expect(lock).toContain('Build export audit context');
    expect(lock).toContain('/tmp/gh-aw/agent/export-audit-context.md');
    expect(lock).toContain('GH_AW_STEPS_TS_ERRORS_OUTPUTS_TS_ERRORS');
    expect(lock).toContain('Pre-verify unused exports (top 10)');
    expect(lock).toContain('used_outside_defining_file=${count}_files');
    expect(lock).toContain("^UNUSED: [^[:space:]]+ \\([^)]*\\)$");
    expect(lock).not.toContain('${{ steps.ts-errors.outputs.TS_ERRORS }}');
  });
});
