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
  sandbox?: {
    agent?: {
      version?: string;
    };
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

describe('Cloud Hypervisor smoke artifact bundles', () => {
  const workflowNames = [
    'smoke-cloud-hypervisor',
    'smoke-cloud-hypervisor-claude',
    'smoke-cloud-hypervisor-codex',
    'smoke-cloud-hypervisor-build-test',
    'smoke-playwright-cloud-hypervisor',
  ];

  it.each(workflowNames)('%s pins a bundle with virtiofsd 1.13.3', (name) => {
    const version = loadFrontmatter(path.join(workflowsDir, `${name}.md`))
      .sandbox?.agent?.version;
    if (!version) {
      throw new Error(`Missing sandbox.agent.version in ${name}.md`);
    }
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.slice(1).split('.').map(Number);

    // v0.28.31 is the first published bundle with the required virtiofsd.
    expect(major > 0 || minor > 28 || (minor === 28 && patch >= 31)).toBe(true);

    const lock = fs.readFileSync(path.join(workflowsDir, `${name}.lock.yml`), 'utf-8');
    expect(lock).toContain(`GH_AW_AWF_VERSION: ${version}`);
  });
});

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

    expect(frontmatter.tools?.bash).toEqual(['curl', 'printf', 'cat']);
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(printf)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(cat)'\\''");
  });
});
