import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowLocks = [
  'red-team-benchmark.lock.yml',
  'secret-digger-claude.lock.yml',
  'smoke-claude.lock.yml',
  'smoke-docker-sbx-claude.lock.yml',
  'smoke-gvisor-claude.lock.yml',
];

describe('Anthropic auth token workflow protection', () => {
  it.each(workflowLocks)('%s excludes and redacts ANTHROPIC_AUTH_TOKEN', (workflowLock) => {
    const lock = fs.readFileSync(path.join(workflowsDir, workflowLock), 'utf-8');

    expect(lock).toContain('--exclude-env ANTHROPIC_AUTH_TOKEN');
    expect(lock).toContain('GH_AW_SECRET_NAMES: \'ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN');
    expect(lock).toContain('SECRET_ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}');
  });
});
