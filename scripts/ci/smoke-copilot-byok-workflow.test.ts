import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const byokSourcePath = path.join(workflowsDir, 'smoke-copilot-byok.md');
const byokLockPaths = [
  path.join(workflowsDir, 'smoke-copilot-byok.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-apikey.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.lock.yml'),
];
const entraLockPath = path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.lock.yml');

describe('smoke copilot BYOK workflow model selection', () => {
  it('pins the direct BYOK source workflow to claude-haiku-4.5', () => {
    const source = fs.readFileSync(byokSourcePath, 'utf-8');

    expect(source).toContain('COPILOT_MODEL: claude-haiku-4.5');
  });

  describe.each(['entra', 'apikey'])('AOAI %s smoke token optimization', (auth) => {
    const source = fs.readFileSync(
      path.join(workflowsDir, `smoke-copilot-byok-aoai-${auth}.md`), 'utf-8',
    );
    const [, frontmatter, prompt] = source.split(/^---\s*$/m);
    const workflow = yaml.load(frontmatter) as {
      tools: { bash: boolean; github: { allowed: string[] } };
      steps: { name: string; run: string }[];
    };
    const lock = fs.readFileSync(
      path.join(workflowsDir, `smoke-copilot-byok-aoai-${auth}.lock.yml`), 'utf-8',
    );
    const compiled = yaml.load(lock) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };

    it('allows only the single-shot GitHub check and disables shell access', () => {
      expect(workflow.tools.bash).toBe(false);
      expect(workflow.tools.github.allowed).toEqual(['list_pull_requests']);
      expect(prompt).toContain('Call `github-list_pull_requests` exactly once');
      expect(prompt).toContain('`perPage: 2`, `state: closed`');
      expect(prompt).toContain('Do NOT call any other GitHub tool and do NOT retry on any error');
      expect(prompt).toContain('❌ otherwise. Do not call `missing_tool`; continue to Output.');
      expect(lock).toContain('github(list_pull_requests)');
      expect(lock).not.toContain('--allow-tool shell');
      expect(lock).not.toContain("--allow-tool '\\''shell(github:*)'\\''");
    });

    it('reads only one context file and keeps precomputation in the agent job', () => {
      expect(prompt.match(/\/tmp\/gh-aw\/agent\/[a-z.-]+/g)).toEqual([
        '/tmp/gh-aw/agent/smoke-context.txt',
      ]);
      expect(prompt).toContain('once; do not read other files or run shell commands');
      expect(prompt).toContain('✅ if `file_verified=true`, ❌ otherwise');
      expect(prompt).not.toContain('steps.smoke-data.outputs');
      expect(prompt).toContain('`add_comment` safe-output exactly once with `item_number`');
      const step = compiled.jobs.agent.steps.find(s => s.name === 'Pre-compute BYOK smoke test data');
      expect(step?.run?.trimEnd()).toBe(workflow.steps[0].run.trimEnd());
      expect(compiled.jobs.activation.steps.some(s => s.name === step?.name)).toBe(false);
    });

    it.each([
      { event: 'pull_request', prFailure: false, mismatch: false, httpCode: '200' },
      { event: 'schedule', prFailure: false, mismatch: false, httpCode: '301' },
      { event: 'workflow_dispatch', prFailure: true, mismatch: false, httpCode: '503' },
      { event: 'pull_request', prFailure: false, mismatch: true, httpCode: '200' },
    ])('writes accurate context for %j', ({ event, prFailure, mismatch, httpCode }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoai-smoke-'));
      try {
        const eventPath = path.join(dir, 'event.json');
        fs.writeFileSync(eventPath, JSON.stringify({
          pull_request: { user: { login: 'author' }, assignees: [{ login: 'reviewer' }] },
        }));
        const script = workflow.steps[0].run.split('/tmp/gh-aw/agent').join(dir);
        const result = spawnSync('bash', ['-e', '-c', `
          gh() { ${prFailure ? 'return 1' : "printf '%s\\n' 'PR #1: Example (by @author)'"}; }
          curl() { printf '%s' '${httpCode}'; }
          ${mismatch ? "cat() { printf '%s' 'mismatched content'; }" : ''}
          ${script}
        `], {
          encoding: 'utf-8',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'github/gh-aw-firewall',
            GITHUB_EVENT_NAME: event,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_RUN_ID: '123',
            PR_NUMBER: event === 'pull_request' ? '42' : '',
          },
        });
        expect(result.status).toBe(0);
        const context = fs.readFileSync(path.join(dir, 'smoke-context.txt'), 'utf-8');
        expect(context).toContain('repository=github/gh-aw-firewall\n');
        expect(context).toContain(`event=${event}\n`);
        expect(context).toContain(`http_code=${httpCode}\n`);
        expect(context).toContain(`file_verified=${!mismatch}\n`);
        expect(context).toContain(`pr_data_verified=${!prFailure}\n`);
        expect(context).toContain(prFailure ? '(PR fetch failed)' : 'PR #1: Example');
        expect(context).toContain(`item_number=${event === 'pull_request' ? '42' : ''}\n`);
        expect(context).toContain(`pr_author=${event === 'pull_request' ? 'author' : ''}\n`);
        expect(context).toContain(`pr_assignees=${event === 'pull_request' ? 'reviewer' : ''}\n`);
        expect(fs.readdirSync(dir).filter(f => f.startsWith('smoke-'))).toHaveLength(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it.each(byokLockPaths)('sets workflow-level COPILOT_MODEL env in %s', (lockPath) => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    // The compiled lock file should define COPILOT_MODEL at the workflow env level
    // (pinned model from the source .md) and use vars-based selection in the agent job
    expect(lock).toMatch(/^\s+COPILOT_MODEL:\s*(?:claude-haiku-4\.5|o4-mini-aw)\s*$/m);
    expect(lock).not.toMatch(/COPILOT_MODEL:\s*\$\{\{\s*vars\.GH_AW_MODEL_AGENT_COPILOT\s*\|\|\s*env\.COPILOT_MODEL\s*\}\}\s*/);
  });

  it('excludes Azure OIDC identifiers from the Entra agent environment', () => {
    const lock = fs.readFileSync(entraLockPath, 'utf-8');
    expect(lock).toContain('--exclude-env AWF_AUTH_AZURE_CLIENT_ID');
    expect(lock).toContain('--exclude-env AWF_AUTH_AZURE_TENANT_ID');

    const compilerOutput = lock
      .replace(' --exclude-env AWF_AUTH_AZURE_CLIENT_ID', '')
      .replace(' --exclude-env AWF_AUTH_AZURE_TENANT_ID', '');
    const { content: postprocessedLock } = applyGeneralWorkflowPatches(
      compilerOutput,
      entraLockPath
    );

    expect(postprocessedLock).toContain('--exclude-env AWF_AUTH_AZURE_CLIENT_ID');
    expect(postprocessedLock).toContain('--exclude-env AWF_AUTH_AZURE_TENANT_ID');
    expect(postprocessedLock).toMatch(
      /--exclude-env ACTIONS_ID_TOKEN_REQUEST_URL --exclude-env AWF_AUTH_AZURE_CLIENT_ID --exclude-env AWF_AUTH_AZURE_TENANT_ID/
    );
  });
});
