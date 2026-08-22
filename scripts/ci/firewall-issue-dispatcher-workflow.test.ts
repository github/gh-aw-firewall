import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'firewall-issue-dispatcher.md');
const lockPath = path.join(workflowsDir, 'firewall-issue-dispatcher.lock.yml');

describe('firewall issue dispatcher workflow', () => {
  it('uses temporary IDs for cross-repository tracking issue links', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(source).toContain('require-temporary-id: true');
    expect(lock).toContain('\\"require_temporary_id\\":true');
    expect(source).toContain('🔗 AWF tracking issue: #aw_track1');
    expect(source).toContain('safe-output processor will resolve it');
    expect(source).not.toContain(
      'https://github.com/github/gh-aw-firewall/issues/{NUMBER}',
    );
    expect(source).not.toContain('/issues/#aw_');
  });
});
