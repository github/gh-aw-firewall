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
    const installCommands: Array<{ lockFile: string; command: string }> = [];

    for (const lockFile of lockFiles) {
      const workflowContent = fs.readFileSync(path.join(workflowsDir, lockFile), 'utf-8');
      for (const line of workflowContent.split('\n')) {
        const trimmedLine = line.trim();
        if (
          trimmedLine.startsWith('run:') &&
          trimmedLine.includes('npm install') &&
          trimmedLine.includes(packageName)
        ) {
          installCommands.push({ lockFile, command: trimmedLine });
        }
      }
    }

    if (installCommands.length === 0) {
      throw new Error(
        `No npm install lines found for ${packageName} in .lock.yml workflows; this regression test expects at least one engine install entry.`
      );
    }
    const secureInstallCommandRegex =
      /run:\s+npm install\b(?=.*--ignore-scripts)(?=.*(?:^|\s)(?:-g|--global)(?:\s|$)).*/;

    for (const { lockFile, command } of installCommands) {
      expect(command).toMatch(secureInstallCommandRegex);
      expect(command).toContain(packageName);
      expect(lockFile).toMatch(/\.lock\.yml$/);
    }
  });
});
