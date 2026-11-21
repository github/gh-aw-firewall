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

// gh-aw >= v1.3 disables install scripts via the step's env
// (NPM_CONFIG_IGNORE_SCRIPTS: 'true') instead of an --ignore-scripts flag.
function stepEnvDisablesInstallScripts(lines: string[], runIndex: number): boolean {
  const runIndent = lines[runIndex].search(/\S/);
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.search(/\S/);
    if (indent <= runIndent) break;
    if (/^\s*NPM_CONFIG_IGNORE_SCRIPTS:\s*['"]?true['"]?\s*$/i.test(line)) return true;
  }
  return false;
}

describe('workflow engine CLI install security', () => {
  it.each(engineInstallSecurityRules)(
    '$expectedDescription',
    ({ packageName, ignoreScriptsPolicy }) => {
      const installCommands: Array<{
        lockFile: string;
        command: string;
        stepEnvDisablesScripts: boolean;
      }> = [];

      for (const lockFile of lockFiles) {
        const workflowContent = fs.readFileSync(path.join(workflowsDir, lockFile), 'utf-8');
        const lines = workflowContent.split('\n');
        lines.forEach((line, index) => {
          const trimmedLine = line.trim();
          if (
            trimmedLine.startsWith('run:') &&
            trimmedLine.includes('npm install') &&
            trimmedLine.includes(packageName)
          ) {
            installCommands.push({
              lockFile,
              command: trimmedLine,
              stepEnvDisablesScripts: stepEnvDisablesInstallScripts(lines, index),
            });
          }
        });
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

      for (const { lockFile, command, stepEnvDisablesScripts } of installCommands) {
        if (ignoreScriptsPolicy === 'required') {
          if (stepEnvDisablesScripts) {
            expect(command).toMatch(globalInstallCommandRegex);
          } else {
            expect(command).toMatch(secureInstallCommandRegex);
          }
        } else {
          expect(command).toMatch(globalInstallCommandRegex);
          expect(command).not.toContain('--ignore-scripts');
          expect(stepEnvDisablesScripts).toBe(false);
        }
        expect(command).toContain(packageName);
        expect(lockFile).toMatch(/\.lock\.yml$/);
      }
    }
  );
});
