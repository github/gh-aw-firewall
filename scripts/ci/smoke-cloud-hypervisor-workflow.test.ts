import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowFiles = [
  path.join(workflowsDir, 'smoke-cloud-hypervisor.md'),
  path.join(workflowsDir, 'smoke-cloud-hypervisor.lock.yml'),
];

interface WorkflowFrontmatter {
  tools?: {
    bash?: string[];
  };
}

function loadFrontmatter(workflowFile: string): WorkflowFrontmatter {
  const source = fs.readFileSync(workflowFile, 'utf-8');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`No frontmatter found in ${workflowFile}`);
  }
  return yaml.load(match[1]) as WorkflowFrontmatter;
}

describe('Smoke Cloud Hypervisor token-usage verification', () => {
  it('runs only after the agent job succeeds', () => {
    for (const workflowFile of workflowFiles) {
      const workflow = fs.readFileSync(workflowFile, 'utf-8');

      expect(workflow).toMatch(
        /^[ \t]*verify_token_usage:[ \t]*\r?\n[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result[ \t]*==[ \t]*'success'[ \t]*$/m,
      );
    }
  });

  it('explicitly allows the shell commands required by the smoke checks', () => {
    const frontmatter = loadFrontmatter(workflowFiles[0]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf-8');

    expect(frontmatter.tools?.bash).toEqual(expect.arrayContaining(['curl', 'printf', 'cat']));
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(printf)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(cat)'\\''");
  });
});
