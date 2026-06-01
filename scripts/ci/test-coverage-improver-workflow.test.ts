import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'test-coverage-improver.md');
const lockPath = path.join(workflowsDir, 'test-coverage-improver.lock.yml');

describe('test coverage improver workflow token optimization config', () => {
  it('preselects target file and trims prompt/tool surface in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('cat:src/*.test.ts');
    expect(source).toContain('node *');
    expect(source).toContain('./node_modules/.bin/jest *');
    expect(source).toContain('./node_modules/.bin/eslint *');
    expect(source).toContain('Select target file and inject content');
    expect(source).toContain('TARGET_FILE=$TARGET');
    expect(source).toContain('SOURCE_CONTENT<<EOF');
    expect(source).toContain('TEST_CONTENT<<EOF');
    expect(source).toContain('## Turn Budget');
    expect(source).toContain('Complete this task in ≤ 10 tool calls.');
    expect(source).toContain('## Target File (pre-selected)');
    expect(source).toContain('${{ steps.target.outputs.TARGET_FILE }}');
    expect(source).toContain('${{ steps.target.outputs.SOURCE_CONTENT }}');
    expect(source).toContain('${{ steps.target.outputs.TEST_CONTENT }}');

    expect(source).not.toContain('cat:src/docker-manager.ts');
    expect(source).not.toContain('cat:src/cli.ts');
    expect(source).not.toContain('cat:src/host-iptables.ts');
    expect(source).not.toContain('cat:src/squid-config.ts');
    expect(source).not.toContain('cat:src/domain-patterns.ts');
    expect(source).not.toContain('cat:tests/integration/*docker*.test.ts');
    expect(source).not.toContain('cat:tests/integration/blocked-domains.test.ts');
    expect(source).not.toContain('ls:src');
    expect(source).not.toContain('ls:tests');
    expect(source).not.toContain('ls:coverage');
    expect(source).not.toContain('### Phase 1: Review Pre-Computed Coverage');
    expect(source).not.toContain('### Phase 2: Identify Security-Critical Gaps');
    expect(source).not.toContain('### Phase 3: Write Tests');
    expect(source).not.toContain('### Phase 4: Validate and Submit');
  });

  it('compiles reduced tool permissions and target injection into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain("shell(cat:src/*.test.ts)");
    expect(lock).toContain("shell(node:*)");
    expect(lock).toContain("shell(./node_modules/.bin/jest:*)");
    expect(lock).toContain("shell(./node_modules/.bin/eslint:*)");
    expect(lock).toContain('name: Select target file and inject content');
    expect(lock).toContain('TARGET_FILE=$TARGET');
    expect(lock).toContain('SOURCE_CONTENT<<EOF');
    expect(lock).toContain('TEST_CONTENT<<EOF');
    expect(lock).toContain('steps.target.outputs.TARGET_FILE');

    expect(lock).not.toContain("shell(cat:src/docker-manager.ts)");
    expect(lock).not.toContain("shell(cat:src/cli.ts)");
    expect(lock).not.toContain("shell(cat:src/host-iptables.ts)");
    expect(lock).not.toContain("shell(cat:src/squid-config.ts)");
    expect(lock).not.toContain("shell(cat:src/domain-patterns.ts)");
    expect(lock).not.toContain("shell(cat:tests/integration/*docker*.test.ts)");
    expect(lock).not.toContain("shell(cat:tests/integration/blocked-domains.test.ts)");
    expect(lock).not.toContain('shell(ls:src)');
    expect(lock).not.toContain('shell(ls:tests)');
    expect(lock).not.toContain('shell(ls:coverage)');
  });
});
