import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'test-coverage-improver.md');
const lockPath = path.join(workflowsDir, 'test-coverage-improver.lock.yml');

describe('test coverage improver workflow token optimization config', () => {
  it('scopes bash read tools and prompt guidance in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toContain('cat:src/*.ts');
    expect(source).not.toContain('cat:tests/**');
    expect(source).not.toContain('cat:coverage/coverage-summary.json');
    expect(source).not.toContain('head:*');
    expect(source).not.toContain('tail:*');

    expect(source).toContain('cat:tests/integration/squid*.test.ts');
    expect(source).toContain('cat:tests/integration/docker*.test.ts');
    expect(source).toContain('Read top low-coverage source files');
    expect(source).toContain('${{ steps.target-files.outputs.TARGET_FILES }}');
    expect(source).toContain('Context budget:');
    expect(source).toContain('Do **not** run `npm run test` or `npm run lint` until after you have written new tests.');
  });

  it('compiles target file injection into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('name: Read top low-coverage source files');
    expect(lock).toContain('TARGET_FILES<<EOF');
    expect(lock).toContain('steps.target-files.outputs.TARGET_FILES');
    expect(lock).toContain("shell(cat:tests/integration/docker*.test.ts)");
    expect(lock).toContain("shell(cat:tests/integration/squid*.test.ts)");
    expect(lock).not.toContain("shell(cat:src/*.ts)");
    expect(lock).not.toContain("shell(cat:tests/**)");
    expect(lock).not.toContain("shell(cat:coverage/coverage-summary.json)");
  });
});
