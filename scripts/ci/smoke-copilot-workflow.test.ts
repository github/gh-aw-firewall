import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

interface WorkflowFrontmatter {
  tools?: {
    bash?: unknown;
  };
}

function loadFrontmatter(file: string): WorkflowFrontmatter {
  const source = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`No frontmatter found in ${file}`);
  }
  return yaml.load(match[1]) as WorkflowFrontmatter;
}

const copilotSmokeWorkflows = [
  { name: 'smoke-copilot-byok-aoai-apikey', file: 'smoke-copilot-byok-aoai-apikey.md' },
  { name: 'smoke-copilot-byok-aoai-entra', file: 'smoke-copilot-byok-aoai-entra.md' },
  { name: 'smoke-copilot-byok', file: 'smoke-copilot-byok.md' },
  { name: 'smoke-copilot', file: 'smoke-copilot.md' },
  { name: 'smoke-copilot-network-isolation', file: 'smoke-copilot-network-isolation.md' },
];

describe('smoke copilot workflow output requirements', () => {
  for (const workflow of copilotSmokeWorkflows) {
    it(`${workflow.name}: requires noop fallback when no pull request context exists`, () => {
      const source = fs.readFileSync(path.join(workflowsDir, workflow.file), 'utf-8');

      expect(source).toContain('**If triggered by a pull request**');
      expect(source).toContain('If all tests pass on a pull request trigger:');
      expect(source).toContain(
        '**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`'
      );
      expect(source).toContain(
        'Do NOT attempt to add pull request comments or labels when there is no pull request.'
      );
    });
  }

  it('smoke-copilot-network-isolation: grants granular curl shell permission', () => {
    const frontmatter = loadFrontmatter('smoke-copilot-network-isolation.md');
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot-network-isolation.lock.yml'),
      'utf-8'
    );

    expect(frontmatter.tools?.bash).toEqual(expect.arrayContaining(['curl', 'echo']));
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(echo)'\\''");
  });
});
