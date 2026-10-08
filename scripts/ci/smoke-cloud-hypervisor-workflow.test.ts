import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as os from 'os';
import { execFileSync } from 'child_process';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowFiles = [
  path.join(workflowsDir, 'smoke-cloud-hypervisor.md'),
  path.join(workflowsDir, 'smoke-cloud-hypervisor.lock.yml'),
];

interface WorkflowFrontmatter {
  on?: {
    label_command?: {
      name: string[];
    };
  };
  engine?: {
    args?: string[];
  };
  tools?: {
    bash?: string[];
  };
  network?: {
    allowed?: string[];
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
        /^[ \t]*verify_token_usage:[ \t]*\r?\n(?:[ \t]*name:[^\r\n]*\r?\n)?[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result[ \t]*==[ \t]*'success'[ \t]*$/m,
      );
    }
  });

  it('explicitly allows the shell commands required by the smoke checks', () => {
    const frontmatter = loadFrontmatter(workflowFiles[0]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf-8');

    expect(frontmatter.tools?.bash).toEqual(['curl', 'printf', 'cat', 'jq']);
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(printf)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(cat)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(jq)'\\''");
  });

  it('approves only the probe URLs at the CLI while preserving firewall denial', () => {
    const frontmatter = loadFrontmatter(workflowFiles[0]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf-8');
    expect(frontmatter.engine?.args).toEqual([
      '--allow-url=https://github.com',
      '--allow-url=https://example.com',
    ]);
    expect(lock).toContain('--allow-url=https://github.com');
    expect(lock).toContain('--allow-url=https://example.com');
    expect(lock).not.toContain('--allow-all-urls');
    expect(lock).not.toContain('--allow-all-tools');
    expect(frontmatter.network?.allowed).toEqual(['defaults', 'github']);
    const workflow = fs.readFileSync(workflowFiles[0], 'utf-8');
    expect(workflow).toContain('Agent did not call add_comment on a pull_request trigger.');
    expect(workflow).toContain('runtime: cloud-hypervisor');
  });

  it('supports an isolated PR rerun without removing the existing shared trigger', () => {
    expect(loadFrontmatter(workflowFiles[0]).on?.label_command?.name).toEqual([
      'ready-for-aw', 'test-cloud-hypervisor-copilot',
    ]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf8');
    expect(lock).toContain("github.event.label.name == 'test-cloud-hypervisor-copilot'");
    expect(lock).toContain('Agent did not call add_comment on a pull_request trigger.');
  });

  it('encodes a real comment file using the narrowly allowed jq command', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-smoke-comment-'));
    const body = 'PASS: file "quotes" and $literal\nFAIL: network probe\n';
    const file = path.join(directory, 'comment.md');
    try {
      fs.writeFileSync(file, body);
      const output = execFileSync('jq', [
        '-Rs', '--argjson', 'item_number', '9445',
        '{item_number: $item_number, body: .}', file,
      ], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ item_number: 9445, body });
      expect(loadFrontmatter(workflowFiles[0]).tools?.bash).toContain('jq');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
