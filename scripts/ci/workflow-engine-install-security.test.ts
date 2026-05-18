import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const lockFiles = fs.readdirSync(workflowsDir).filter(file => file.endsWith('.lock.yml'));

type EngineInstallSecurityRule = {
  packageName: string;
  expectedDescription: string;
  ignoreScriptsPolicy: 'required' | 'forbidden';
};

const engineInstallSecurityRules: EngineInstallSecurityRule[] = [
  {
    packageName: '@openai/codex',
    expectedDescription: 'Codex CLI installs must include --ignore-scripts',
    ignoreScriptsPolicy: 'required',
  },
  {
    packageName: '@anthropic-ai/claude-code',
    expectedDescription: 'Claude Code installs must not include --ignore-scripts',
    ignoreScriptsPolicy: 'forbidden',
  },
];

describe('workflow engine CLI install security', () => {
  it.each(engineInstallSecurityRules)(
    '$expectedDescription',
    ({ packageName, ignoreScriptsPolicy }) => {
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
      const globalInstallCommandRegex =
        /run:\s+npm install\b(?=.*(?:^|\s)(?:-g|--global)(?:\s|$)).*/;
      const secureInstallCommandRegex =
        /run:\s+npm install\b(?=.*--ignore-scripts)(?=.*(?:^|\s)(?:-g|--global)(?:\s|$)).*/;

      for (const { lockFile, command } of installCommands) {
        if (ignoreScriptsPolicy === 'required') {
          expect(command).toMatch(secureInstallCommandRegex);
        } else {
          expect(command).toMatch(globalInstallCommandRegex);
          expect(command).not.toContain('--ignore-scripts');
        }
        expect(command).toContain(packageName);
        expect(lockFile).toMatch(/\.lock\.yml$/);
      }
    }
  );
});
