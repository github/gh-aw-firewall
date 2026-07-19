import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const metadataPrefix = '# gh-aw-metadata: ';

function getClaudeWorkflowLocks(): string[] {
  return fs.readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.lock.yml'))
    .filter((file) => {
      const workflowPath = path.join(workflowsDir, file);
      const [metadataLine = ''] = fs.readFileSync(workflowPath, 'utf-8').split(/\r?\n/, 1);

      if (!metadataLine.startsWith(metadataPrefix)) {
        return false;
      }

      const metadata = JSON.parse(metadataLine.slice(metadataPrefix.length)) as { agent_id?: string };
      return metadata.agent_id === 'claude';
    })
    .sort();
}

describe('Anthropic auth token workflow protection', () => {
  const workflowLocks = getClaudeWorkflowLocks();

  it('discovers Claude lock workflows from gh-aw metadata', () => {
    expect(workflowLocks.length).toBeGreaterThan(0);
  });

  it.each(workflowLocks)('%s excludes and redacts ANTHROPIC_AUTH_TOKEN', (workflowLock) => {
    const lock = fs.readFileSync(path.join(workflowsDir, workflowLock), 'utf-8');

    expect(lock).toContain('--exclude-env ANTHROPIC_AUTH_TOKEN');
    expect(lock).toContain('GH_AW_SECRET_NAMES: \'ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN');
    expect(lock).toContain('SECRET_ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}');
  });
});
