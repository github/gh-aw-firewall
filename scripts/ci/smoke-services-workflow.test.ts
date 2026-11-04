import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-services.md');
const lockPath = path.join(workflowsDir, 'smoke-services.lock.yml');

describe('Smoke Services workflow token optimization', () => {
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const workflow = yaml.load(source.split(/^---$/m)[1]) as {
    steps: { name: string; run: string }[];
    'post-steps'?: { name: string; run: string }[];
  };
  const connectivityStep = workflow.steps.find(
    step => step.name === 'Require sandbox service connectivity',
  )!;

  it('runs the independent sandbox connectivity gate before agent execution', () => {
    const lock = yaml.load(fs.readFileSync(lockPath, 'utf-8')) as {
      jobs: Record<string, { steps?: { name: string; run?: string }[] }>;
    };
    const steps = Object.values(lock.jobs).flatMap(job => job.steps ?? []);
    const connectivityStepIndex = steps.findIndex(step => step.name === connectivityStep.name);
    const agentStepIndex = steps.findIndex(step => step.name === 'Execute GitHub Copilot CLI');
    expect(connectivityStepIndex).toBeGreaterThanOrEqual(0);
    expect(connectivityStepIndex).toBeLessThan(agentStepIndex);
    expect(steps[connectivityStepIndex]?.run).toBe(connectivityStep.run);
    expect(workflow['post-steps']?.some(step => step.name === connectivityStep.name)).toBe(false);
    expect(connectivityStep.run).toContain('--allow-host-service-ports 5432,6379');
    expect(connectivityStep.run).toContain('--image-registry awf-smoke');
    expect(connectivityStep.run).not.toContain('--env-all');
  });

  it.each([
    ['healthy services', 'PONG', '0', '0', '1', '0', 0],
    ['Redis refused', '', '1', '0', '1', '0', 1],
    ['Redis unexpected reply', 'ERR', '0', '0', '1', '0', 1],
    ['Redis command failure despite output', 'PONG', '1', '0', '1', '0', 1],
    ['Postgres not ready', 'PONG', '0', '1', '1', '0', 1],
    ['Postgres query refused', 'PONG', '0', '0', '', '1', 1],
    ['Postgres command failure despite output', 'PONG', '0', '0', '1', '1', 1],
    ['Postgres unexpected result', 'PONG', '0', '0', '2', '0', 1],
  ])('enforces a nonzero workflow step exit for %s', (
    _name, redisReply, redisStatus, readyStatus, queryReply, queryStatus, expectedStatus,
  ) => {
    const result = spawnSync('bash', ['-euc', `
      sudo() {
        while [ "$1" != -- ]; do shift; done
        shift
        "$@"
      }
      timeout() { shift; "$@"; }
      redis-cli() { printf '%s\\n' "$REDIS_REPLY"; return "$REDIS_STATUS"; }
      pg_isready() { return "$READY_STATUS"; }
      psql() { printf '%s\\n' "$QUERY_REPLY"; return "$QUERY_STATUS"; }
      export -f timeout redis-cli pg_isready psql
      ${connectivityStep.run}
    `], {
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        AWF_SMOKE_IMAGE_TAG: 'test',
        REDIS_REPLY: String(redisReply),
        REDIS_STATUS: String(redisStatus),
        READY_STATUS: String(readyStatus),
        QUERY_REPLY: String(queryReply),
        QUERY_STATUS: String(queryStatus),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expectedStatus);
  });

  it('disables GitHub MCP and specifies ordered safe-output instructions', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const frontmatter = source.split(/^---$/m)[1];
    const prompt = source.split(/^---$/m)[2];

    expect(frontmatter).toContain('github: false');
    expect(frontmatter).toContain('bash:\n    - "*"');
    expect(prompt).toContain('item_number` from the triggering event');
    expect(prompt).toContain('${{ github.event.pull_request.number || inputs.item_number }}');
    expect(prompt).toContain('If a target is present, call `add_comment` exactly once');
    expect(prompt.indexOf('add_comment')).toBeLessThan(prompt.indexOf('add_labels'));
    expect(prompt).toContain('Do not call `noop` after these outputs.');
  });

  it('uses noop for scheduled runs and manual dispatches without a target', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const prompt = source.split(/^---$/m)[2];

    expect(prompt).toContain('If no target is present (scheduled runs or manual dispatches without `item_number`)');
    expect(prompt).toContain('call `noop` exactly once with a brief check summary and overall PASS or FAIL');
    expect(prompt).toContain('Do not call `add_comment` or `add_labels`.');
    expect(prompt).not.toContain('Do not call `noop`.');
  });

  it('compiles without GitHub MCP tool injection while retaining safe outputs', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).not.toContain('ghcr.io/github/github-mcp-server');
    expect(lock).not.toContain('GITHUB_TOOLSETS');
    expect(lock).not.toContain('github_mcp_tools_with_safeoutputs_prompt.md');
    expect(lock).not.toContain('"github": {');
    expect(lock).toContain('"mcp_servers":[{"name":"safeoutputs"');
    expect(lock).toContain('"add_comment","add_labels"');
  });
});
