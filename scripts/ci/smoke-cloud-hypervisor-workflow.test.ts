import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowFiles = [
  path.join(workflowsDir, 'smoke-cloud-hypervisor.md'),
  path.join(workflowsDir, 'smoke-cloud-hypervisor.lock.yml'),
];

interface WorkflowFrontmatter {
  model?: string;
  concurrency?: {
    'job-discriminator'?: string;
  };
  on?: {
    label_command?: {
      name: string[];
    };
  };
  steps?: Array<{
    env?: Record<string, string>;
    name?: string;
    run?: string;
  }>;
  engine?: {
    id?: string;
    version?: string;
    args?: string[];
  };
  tools?: {
    bash?: string[];
    github?: boolean | {
      mode?: string;
      toolsets?: string[];
    };
  };
  network?: {
    allowed?: string[];
  };
  'safe-outputs'?: {
    'add-comment'?: { max?: number; target?: string; 'hide-older-comments'?: boolean };
    'add-labels'?: { max?: number; allowed?: string[] };
    noop?: { max?: number; 'report-as-issue'?: boolean };
  };
  'post-steps'?: Array<{ name?: string; run?: string }>;
  sandbox?: {
    agent?: {
      version?: string;
      config?: {
        filesystem?: {
          'allow-write'?: string[];
        };
      };
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

describe('Copilot Cloud Hypervisor smoke compatibility', () => {
  const workflowNames = [
    'smoke-cloud-hypervisor',
    'smoke-cloud-hypervisor-build-test',
    'smoke-playwright-cloud-hypervisor',
  ];

  it.each(workflowNames)('%s uses compiler-managed Copilot with writable model metadata', (name) => {
    const sourcePath = path.join(workflowsDir, `${name}.md`);
    const lockPath = path.join(workflowsDir, `${name}.lock.yml`);
    const frontmatter = loadFrontmatter(sourcePath);
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(frontmatter.engine?.id).toBe('copilot');
    expect(frontmatter.engine?.version).toBeUndefined();
    expect(lock.split('\n', 1)[0]).toContain('"copilot":"1.0.98"');
    expect(frontmatter.sandbox?.agent?.config?.filesystem?.['allow-write'])
      .toEqual(['/tmp/gh-aw/aw_info.json']);
    expect(lock).toContain(
      '\\"filesystem\\":{\\"allowWrite\\":[\\"/tmp/gh-aw/aw_info.json\\",',
    );
    const preparation = lock.split('\n').find(line =>
      line.includes('mkdir -p "${GITHUB_WORKSPACE}/.awf-home"'));
    expect(preparation).toBeDefined();
    expect(preparation).not.toContain('"/tmp/gh-aw/aw_info.json"');
  });

  it('approves build-test probe URLs without allowing the blocked domain through AWF', () => {
    const name = 'smoke-cloud-hypervisor-build-test';
    const frontmatter = loadFrontmatter(path.join(workflowsDir, `${name}.md`));
    const lock = fs.readFileSync(path.join(workflowsDir, `${name}.lock.yml`), 'utf-8');

    expect(frontmatter.engine?.args).toEqual([
      '--allow-url=https://github.com',
      '--allow-url=https://example.com',
    ]);
    expect(frontmatter.concurrency?.['job-discriminator']).toBe('${{ github.run_id }}');
    expect(frontmatter.tools?.bash).toEqual(['*']);
    expect(frontmatter.network?.allowed).toContain('github');
    expect(frontmatter.network?.allowed).not.toContain('example.com');
    expect(frontmatter.network?.allowed).not.toContain('*');
    const launch = lock.split('\n').find(line => line.includes('copilot_harness.cjs'));
    expect(launch).toBeDefined();
    expect(launch).toContain('--allow-tool shell');
    expect(launch).toContain('--allow-url=https://github.com');
    expect(launch).toContain('--allow-url=https://example.com');
    expect(lock).not.toContain('--allow-all-urls');
    expect(lock).not.toContain('--allow-all-tools');
    expect(lock).toContain('GH_AW_INFO_AGENT_RUNTIME: "cloud-hypervisor"');
    expect(lock).toContain('Build test results not found:');
    expect(lock).toContain('network_isolation:');
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

  it('precomputes the merged PR check and keeps the agent tool surface small', () => {
    const frontmatter = loadFrontmatter(workflowFiles[0]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf-8');

    expect(frontmatter.model).toBe('gpt-5.4-mini');
    expect(frontmatter.tools?.github).toBe(false);
    expect(frontmatter.steps).toEqual([
      {
        name: 'Pre-compute merged PR check',
        env: { GH_TOKEN: '${{ github.token }}' },
        run: expect.stringContaining(
          'gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 1 --json number,title',
        ),
      },
    ]);
    expect(lock).toContain('COPILOT_MODEL: gpt-5.4-mini');
    expect(lock).not.toContain('"list_pull_requests"');

    const prompt = fs.readFileSync(workflowFiles[0], 'utf-8');
    expect(prompt).toContain('read `/tmp/gh-aw/agent/merged-pr.json` with one');
    expect(prompt).toContain('`cat` command.');
    expect(prompt).toContain('Make exactly one bash invocation for all four checks, the summary, and safe');
    expect(prompt).toContain("MERGED_PR_JSON=$(cat /tmp/gh-aw/agent/merged-pr.json 2>/dev/null || :)");
    expect(prompt).toContain("jq -e 'type == \"array\" and length > 0'");
    expect(prompt).toContain(
      'if [ "$MERGED_PR_RESULT" != PASS ] || [ "$GITHUB_RESULT" != PASS ] || [ "$FILE_RESULT" != PASS ] || [ "$BLOCKED_RESULT" != PASS ]; then OVERALL_RESULT=FAIL; fi',
    );
    expect(prompt).toContain('cat <<\'EOF\'');
    expect(prompt).toContain('/tmp/gh-aw/agent/comment-body.md');
    expect(prompt).toContain('Use the existing summary file');
    expect(prompt).toContain('without rewriting it');
  });

  describe('Cloud Hypervisor smoke safe-output contract', () => {
    const source = fs.readFileSync(workflowFiles[0], 'utf8');
    const frontmatter = loadFrontmatter(workflowFiles[0]);

    it('bounds comments, labels and noops and fixes the comment target', () => {
      expect(frontmatter['safe-outputs']?.['add-comment']).toEqual({
        max: 1, target: 'triggering', 'hide-older-comments': true,
      });
      expect(frontmatter['safe-outputs']?.['add-labels']).toEqual({
        max: 1, allowed: ['smoke-cloud-hypervisor'],
      });
      expect(frontmatter['safe-outputs']?.noop).toEqual({ max: 1, 'report-as-issue': false });
      expect(frontmatter.concurrency?.['job-discriminator']).toBe('${{ github.run_id }}');

      const lock = fs.readFileSync(workflowFiles[1], 'utf8');
      expect(lock).toContain('\\"target\\":\\"triggering\\"');
      expect(lock).toContain('\\"add_labels\\":{\\"allowed\\":[\\"smoke-cloud-hypervisor\\"],\\"max\\":1}');
      expect(lock).toContain('\\"noop\\":{\\"max\\":1,');
      expect(lock).toContain('GH_AW_NOOP_REPORT_AS_ISSUE: "false"');
    });

    it.each([
      ['pull_request', '200', '', ['add_comment', 'add_labels'], 'PASS', 0],
      ['pull_request', '503', '', ['add_comment'], 'FAIL', 0],
      ['workflow_dispatch', '200', '', ['noop'], 'PASS', 0],
      ['workflow_dispatch', '503', '', ['noop'], 'FAIL', 0],
      ['pull_request', '200', 'add_comment', ['add_comment'], 'PASS', 9],
      ['pull_request', '200', 'add_labels', ['add_comment', 'add_labels'], 'PASS', 9],
      ['workflow_dispatch', '200', 'noop', ['noop'], 'PASS', 9],
    ])('reports %s HTTP%s with %s failure as %j', (event, http, failedTool, expectedTypes, overall, status) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-smoke-outputs-'));
      try {
        const blocks = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)];
        expect(blocks).toHaveLength(1);
        const command = blocks[0][1]
          .split('/tmp/gh-aw/agent').join(directory)
          .split('${{ github.event_name }}').join(event)
          .split('${{ github.event.pull_request.number }}').join(event === 'pull_request' ? '10240' : '');
        fs.writeFileSync(path.join(directory, 'merged-pr.json'), '[{"number":1,"title":"fixture"}]');
        const records = path.join(directory, 'outputs.jsonl');
        const mocks = `
          curl() {
            local url arg
            for arg in "$@"; do url="$arg"; done
            case "$url" in
              https://github.com) printf '%s' "$PROBE_HTTP" ;;
              https://example.com) printf '000'; return 56 ;;
              *) return 2 ;;
            esac
          }
          safeoutputs() {
            [ "$#" = 2 ] && [ "$2" = . ] || return 2
            jq -c --arg type "$1" '. + {type: $type}' >> "$CALLS_FILE" || return
            if [ "$1" = "$FAILED_SAFE_OUTPUT" ]; then return 9; fi
          }
        `;
        const result = spawnSync('bash', ['-c', mocks + command], {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env, GITHUB_RUN_ID: 'fixture', PROBE_HTTP: http,
            FAILED_SAFE_OUTPUT: failedTool, CALLS_FILE: records,
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(status);
        const calls = fs.readFileSync(records, 'utf8').trim().split('\n')
          .map(line => JSON.parse(line) as {
            type: string; item_number?: number; body?: string; message?: string; labels?: string[];
          });
        expect(calls.map(call => call.type)).toEqual(expectedTypes);
        const summary = fs.readFileSync(path.join(directory, 'comment-body.md'), 'utf8');
        expect(summary).toContain(`Overall: ${overall}`);
        expect(calls[0]).toEqual(event === 'pull_request'
          ? { type: 'add_comment', item_number: 10240, body: summary }
          : { type: 'noop', message: summary });
        if (calls.length === 2) {
          expect(calls[1]).toEqual({
            type: 'add_labels', item_number: 10240, labels: ['smoke-cloud-hypervisor'],
          });
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it.each([
      ['label only', { type: 'add_labels', item_number: 10240, labels: ['smoke-cloud-hypervisor'] }, 1],
      ['comment name in message', { type: 'noop', message: '"add_comment"' }, 1],
      ['real comment', { type: 'add_comment', item_number: 10240, body: 'Overall: PASS' }, 0],
    ])('validates actual output types: %s', (_name, record, status) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-smoke-validator-'));
      try {
        const outputs = path.join(directory, 'outputs.jsonl');
        fs.writeFileSync(outputs, JSON.stringify(record) + '\n');
        const validator = frontmatter['post-steps']?.find(step =>
          step.name === 'Validate safe outputs were invoked')?.run;
        if (!validator) throw new Error('Missing safe-output validator');
        const result = spawnSync('bash', ['-e', '-c', validator], {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', OUTPUTS_FILE: outputs },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(status);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it('allows all shell commands required by the smoke checks', () => {
    const frontmatter = loadFrontmatter(workflowFiles[0]);
    const lock = fs.readFileSync(workflowFiles[1], 'utf-8');

    expect(frontmatter.tools?.bash).toEqual(['*']);
    expect(lock).toContain('--allow-tool shell');
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
      expect(loadFrontmatter(workflowFiles[0]).tools?.bash).toEqual(['*']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
