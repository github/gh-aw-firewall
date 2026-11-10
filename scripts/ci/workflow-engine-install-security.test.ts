import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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
      const installCommands: Array<{
        lockFile: string;
        command: string;
        env?: Record<string, string>;
      }> = [];

      for (const lockFile of lockFiles) {
        const workflowContent = fs.readFileSync(path.join(workflowsDir, lockFile), 'utf-8');
        const workflow = yaml.load(workflowContent) as {
          jobs?: Record<string, {
            steps?: Array<{ run?: string; env?: Record<string, string> }>;
          }>;
        };
        for (const job of Object.values(workflow.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            for (const command of step.run?.split('\n') ?? []) {
              if (
                command.includes('npm install') &&
                command.includes(packageName) &&
                /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(command)
              ) {
                installCommands.push({ lockFile, command, env: step.env });
              }
            }
          }
        }
      }

      if (installCommands.length === 0) {
        throw new Error(
          `No npm install lines found for ${packageName} in .lock.yml workflows; this regression test expects at least one engine install entry.`
        );
      }
      const globalInstallCommandRegex =
        /npm install\b(?=.*(?:^|\s)(?:-g|--global)(?:\s|$)).*/;
      const secureInstallCommandRegex =
        /npm install\b(?=.*--ignore-scripts)(?=.*(?:^|\s)(?:-g|--global)(?:\s|$)).*/;

      for (const { lockFile, command, env } of installCommands) {
        if (ignoreScriptsPolicy === 'required') {
          const scriptsDisabled =
            secureInstallCommandRegex.test(command) ||
            env?.NPM_CONFIG_IGNORE_SCRIPTS === 'true';
          expect(scriptsDisabled).toBe(true);
          expect(command).toMatch(globalInstallCommandRegex);
        } else {
          expect(command).toMatch(globalInstallCommandRegex);
          expect(command).not.toContain('--ignore-scripts');
          expect(env?.NPM_CONFIG_IGNORE_SCRIPTS).not.toBe('true');
        }
        expect(command).toContain(packageName);
        expect(lockFile).toMatch(/\.lock\.yml$/);
      }
    }
  );
});
