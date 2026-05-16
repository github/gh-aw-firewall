import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const lockFiles = fs.readdirSync(workflowsDir).filter(file => file.endsWith('.lock.yml'));

describe('workflow gh-aw extension installs', () => {
  it('uses the resilient gh-aw installer in every lock workflow', () => {
    const workflowsWithLegacyInstall: string[] = [];

    for (const lockFile of lockFiles) {
      const workflowContent = fs.readFileSync(path.join(workflowsDir, lockFile), 'utf-8');
      if (!workflowContent.includes('name: Install gh-aw extension')) {
        continue;
      }

      expect(workflowContent).toMatch(/install-gh-aw\.sh/);
      expect(workflowContent).toMatch(/-type f -executable/);
      expect(workflowContent).toMatch(/Failed to find gh-aw binary for MCP server/);

      if (
        workflowContent.includes('gh extension install github/gh-aw') ||
        workflowContent.includes('gh extension upgrade gh-aw || true')
      ) {
        workflowsWithLegacyInstall.push(lockFile);
      }
    }

    expect(workflowsWithLegacyInstall).toEqual([]);
  });
});
