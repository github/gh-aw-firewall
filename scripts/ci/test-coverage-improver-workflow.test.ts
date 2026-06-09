import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'test-coverage-improver.md');
const lockPath = path.join(workflowsDir, 'test-coverage-improver.lock.yml');

describe('test coverage improver workflow token optimization config', () => {
  it('preselects target file and trims prompt/tool surface in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('toolsets: [repos]');
    expect(source).not.toContain('toolsets: [repos, pull_requests]');
    expect(source).toContain('COPILOT_MODEL: claude-haiku-4-5');
    expect(source).toContain('node:*');
    expect(source).toContain('./node_modules/.bin/jest:*');
    expect(source).toContain('./node_modules/.bin/eslint:*');
    expect(source).toContain('Select target file and inject content');
    expect(source).toContain('TARGET_FILE=$TARGET');
    expect(source).toContain('TARGET_TEST_FILE=$TEST_FILE');
    expect(source).toContain('SOURCE_CONTENT<<EOF');
    expect(source).toContain('TEST_CONTENT<<EOF');
    expect(source).toContain('Verify injected context');
    expect(source).toContain('TARGET_TEST_FILE: $TARGET_TEST_FILE');
    expect(source).toContain('## Turn Budget');
    expect(source).toContain('Complete this task in ≤ 6 tool calls.');
    expect(source).toContain('unless the injected section is unexpectedly empty');
    expect(source).toContain('./node_modules/.bin/jest --testPathPattern=<file> --no-coverage 2>&1 | tail -60');
    expect(source).toContain('./node_modules/.bin/eslint <file> --max-warnings=0');
    expect(source).toContain('## Target File (pre-selected)');
    expect(source).toContain('${{ steps.target.outputs.TARGET_FILE }}');
    expect(source).toContain('${{ steps.target.outputs.TARGET_TEST_FILE }}');
    expect(source).toContain('${{ steps.target.outputs.SOURCE_CONTENT }}');
    expect(source).toContain('${{ steps.target.outputs.TEST_CONTENT }}');
    expect(source).toContain('Do not glob-read `src/*.test.ts` for style reference.');
    expect(source).toContain('Run targeted Jest reruns only when fixing failures');
    expect(source).toContain('do not run full-suite `npm run test` or `npm run lint`');

    expect(source).not.toContain('cat:src/docker-manager.ts');
    expect(source).not.toContain('cat:src/cli.ts');
    expect(source).not.toContain('cat:src/host-iptables.ts');
    expect(source).not.toContain('cat:src/squid-config.ts');
    expect(source).not.toContain('cat:src/domain-patterns.ts');
    expect(source).not.toContain('cat:src/*.test.ts');
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

    expect(lock).toContain('COPILOT_MODEL: claude-haiku-4-5');
    expect(lock).toContain("shell(node:*)");
    expect(lock).toContain("shell(./node_modules/.bin/jest:*)");
    expect(lock).toContain("shell(./node_modules/.bin/eslint:*)");
    expect(lock).toContain('name: Select target file and inject content');
    expect(lock).toContain('TARGET_FILE=$TARGET');
    expect(lock).toContain('TARGET_TEST_FILE=$TEST_FILE');
    expect(lock).toContain('SOURCE_CONTENT<<EOF');
    expect(lock).toContain('TEST_CONTENT<<EOF');
    expect(lock).toContain('name: Verify injected context');
    expect(lock).toContain('steps.target.outputs.TARGET_FILE');
    expect(lock).toContain('steps.target.outputs.TARGET_TEST_FILE');
    expect(lock).toContain('TARGET_TEST_FILE: ${{ steps.target.outputs.TARGET_TEST_FILE }}');
    expect(lock).toContain('TARGET_TEST_FILE empty');
    expect(lock).toContain("COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || vars.GH_AW_DEFAULT_MODEL_COPILOT || 'claude-sonnet-4.6' }}");
    expect(lock).not.toContain('pull_requests');
    expect(lock).not.toContain("shell(cat:src/*.test.ts)");
    expect(lock).not.toContain("shell(npm run lint)");
    expect(lock).not.toContain("shell(npm run test)");
    expect(lock).toContain('github/gh-aw-actions/setup@9b1d730701c16b15673633e5696d01677fad9844 # v0.79.2');
    expect(lock).not.toContain('github/gh-aw-actions/setup@v0.79.2');
    expect(lock).toContain('ghcr.io/github/github-mcp-server:v1.1.2');

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
