import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const lockFiles = fs.readdirSync(workflowsDir).filter(file => file.endsWith('.lock.yml'));

type EngineInstallSecurityRule = {
  packageName: string;
  expectedDescription: string;
};

const engineInstallSecurityRules: EngineInstallSecurityRule[] = [
  {
    packageName: '@anthropic-ai/claude-code',
    expectedDescription: 'Claude Code CLI installs must include --ignore-scripts',
  },
  {
    packageName: '@openai/codex',
    expectedDescription: 'Codex CLI installs must include --ignore-scripts',
  },
];

describe('workflow engine CLI install security', () => {
  it.each(engineInstallSecurityRules)('$expectedDescription', ({ packageName }) => {
    const installLines: string[] = [];

    for (const lockFile of lockFiles) {
      const workflowContent = fs.readFileSync(path.join(workflowsDir, lockFile), 'utf-8');
      for (const line of workflowContent.split('\n')) {
        if (line.includes('npm install') && line.includes(packageName)) {
          installLines.push(`${lockFile}: ${line.trim()}`);
        }
      }
    }

    expect(installLines.length).toBeGreaterThan(0);
    for (const installLine of installLines) {
      expect(installLine).toMatch(/npm install\b/);
      expect(installLine).toContain('--ignore-scripts');
      expect(installLine).toContain(' -g ');
    }
  });
});
