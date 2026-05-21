import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const repoRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(workflowsDir, 'test-coverage-improver.md');
const lockPath = path.join(workflowsDir, 'test-coverage-improver.lock.yml');
const integrationTestsDir = path.join(repoRoot, 'tests/integration');

describe('test coverage improver workflow token optimization config', () => {
  it('scopes bash read tools and prompt guidance in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toContain('cat:src/*.ts');
    expect(source).not.toContain('cat:tests/**');
    expect(source).not.toContain('cat:coverage/coverage-summary.json');
    expect(source).not.toContain('head:*');
    expect(source).not.toContain('tail:*');

    expect(source).toContain('cat:src/docker-manager.ts');
    expect(source).toContain('cat:src/cli.ts');
    expect(source).toContain('cat:src/host-iptables.ts');
    expect(source).toContain('cat:src/squid-config.ts');
    expect(source).toContain('cat:src/domain-patterns.ts');
    expect(source).toContain('cat:tests/integration/*docker*.test.ts');
    expect(source).toContain('cat:tests/integration/blocked-domains.test.ts');
    expect(source).not.toContain('Read top low-coverage source files');
    expect(source).not.toContain('${{ steps.target-files.outputs.TARGET_FILES }}');
    expect(source).not.toContain('coverage/coverage-summary.json` with the allowed `cat` tool');
    expect(source).toContain('Context budget:');
    expect(source).toContain('Do **not** run `npm run test` or `npm run lint` until after you have written new tests.');

    const integrationTests = fs.readdirSync(integrationTestsDir).filter(file => file.endsWith('.test.ts'));
    const dockerPatternMatches = integrationTests.filter(file => file.includes('docker'));
    expect(dockerPatternMatches.length).toBeGreaterThan(0);
    expect(integrationTests).toContain('blocked-domains.test.ts');
  });

  it('compiles scoped read permissions into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain("shell(cat:src/docker-manager.ts)");
    expect(lock).toContain("shell(cat:src/cli.ts)");
    expect(lock).toContain("shell(cat:src/host-iptables.ts)");
    expect(lock).toContain("shell(cat:src/squid-config.ts)");
    expect(lock).toContain("shell(cat:src/domain-patterns.ts)");
    expect(lock).toContain("shell(cat:tests/integration/*docker*.test.ts)");
    expect(lock).toContain("shell(cat:tests/integration/blocked-domains.test.ts)");
    expect(lock).not.toContain('name: Read top low-coverage source files');
    expect(lock).not.toContain('TARGET_FILES<<EOF');
    expect(lock).not.toContain('steps.target-files.outputs.TARGET_FILES');
    expect(lock).not.toContain("shell(cat:src/*.ts)");
    expect(lock).not.toContain("shell(cat:tests/**)");
    expect(lock).not.toContain("shell(cat:coverage/coverage-summary.json)");
  });
});
