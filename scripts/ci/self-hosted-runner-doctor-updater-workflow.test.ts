import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.lock.yml');

function preparationScript(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const document = filePath === sourcePath ? content.split('---')[1] : content;
  const workflow = yaml.load(document) as {
    jobs: { prepare_candidates: { steps: { id?: string; run?: string }[] } };
  };
  const script = workflow.jobs.prepare_candidates.steps.find((step) => step.id === 'prepare')?.run;
  if (!script) {
    throw new Error(`Missing runner doctor preparation script in ${filePath}`);
  }
  return script;
}

describe('runner doctor updater workflow config', () => {
  it.each([sourcePath, lockPath])('keeps every search within the Boolean limit in %s', (filePath) => {
    const queries = preparationScript(filePath).match(/queries=\([\s\S]*?\n\)/)?.[0];
    expect(queries).toBeDefined();
    const result = spawnSync('bash', ['-c', `${queries}\nprintf '%s\\n' "\${queries[@]}"`], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    const searches = result.stdout.trim().split('\n');
    const terms: string[] = [];
    for (const search of searches) {
      expect((search.match(/\b(?:AND|OR|NOT)\b/g) ?? []).length).toBeLessThanOrEqual(5);
      const queryTerms = [...search.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      expect(queryTerms.length).toBeGreaterThan(0);
      expect(queryTerms.length).toBeLessThanOrEqual(6);
      expect(search).toBe(queryTerms.map((term) => `"${term}"`).join(' OR '));
      terms.push(...queryTerms);
    }
    expect(terms).toEqual([
      'ARC', 'DinD', 'self-hosted', 'GHES', 'GHEC', 'ghe.com',
      'DOCKER_HOST', 'docker-host-path-prefix', 'chroot', 'musl', 'Alpine', 'IPv6',
      'corporate proxy', 'cache_peer', 'GH_HOST', 'resolv.conf', 'toolcache', '_tool',
      'one-shot-token', 'capsh', 'passwd',
    ]);
  });

  it('preserves source/lock searches, filters, pagination, and candidate deduplication', () => {
    const sourceScript = preparationScript(sourcePath);
    expect(preparationScript(lockPath)).toBe(sourceScript);
    const searchScript = sourceScript.slice(
      sourceScript.indexOf('CANDIDATE_RESULTS='),
      sourceScript.indexOf('rm "$CANDIDATE_RESULTS"')
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-doctor-search-'));
    try {
      const result = spawnSync('bash', ['-c', `
        set -euo pipefail
        gh() {
          printf '%s\\n' "$@" >> "$CONTEXT_DIR/search-args.txt"
          printf '%s\\n' '{"number":7,"title":"Closed issue","state":"closed","is_pull_request":false}'
          printf '%s\\n' '{"number":3,"title":"Open PR","state":"open","is_pull_request":true}'
        }
        ${searchScript.replace(
          'CANDIDATE_RESULTS=/tmp/gh-aw/candidate-results.jsonl',
          'CANDIDATE_RESULTS="$CONTEXT_DIR/candidate-results.jsonl"'
        )}
      `], {
        encoding: 'utf-8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          CONTEXT_DIR: directory,
          GITHUB_REPOSITORY: 'github/gh-aw-firewall',
          SINCE: '2026-11-05',
        },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const args = fs.readFileSync(path.join(directory, 'search-args.txt'), 'utf-8').trim().split('\n');
      const queries = args.filter((arg) => arg.startsWith('q='));
      expect(queries).toHaveLength(5);
      for (const query of queries) {
        expect(query).toMatch(/^q=repo:github\/gh-aw-firewall updated:>=2026-11-05 \(.+\)$/);
      }
      for (const argument of ['--method', 'GET', '--paginate', 'search/issues', 'per_page=100']) {
        expect(args.filter((arg) => arg === argument)).toHaveLength(queries.length);
      }
      expect(args.filter((arg) => arg ===
        '.items[] | {number, title, url, state, updated_at, is_pull_request: has("pull_request")}'
      )).toHaveLength(queries.length);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'candidates.json'), 'utf-8'))).toEqual([
        { number: 3, title: 'Open PR', state: 'open', is_pull_request: true },
        { number: 7, title: 'Closed issue', state: 'closed', is_pull_request: false },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prepares compact runner-doctor context and gates the agent on candidates', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Runner Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('- shared/diagnosis-maintenance.md');
    expect(source).not.toContain('- shared/self-hosted-failure-modes.md');
    expect(source).toContain("if: needs.prepare_candidates.outputs.has_candidates == 'true'");
    expect(source).toContain('docs/diagnostics/findings/runner/*.json');
    expect(source).toContain('candidate-results.jsonl');
    expect(source).toContain('covered.txt');
    expect(source).toContain('next-ids.txt');
    expect(source).toContain('toolsets: [issues, pull_requests]');
    expect(source).not.toContain('cache-memory: true');
    expect(source).toContain('grep -n "#<ISSUE_OR_PR_NUMBER>"');
    expect(source).not.toContain('cat .github/workflows/shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor Update"');
    expect(source).toContain('label:runner-doctor');
    expect(source).toContain('for attempt in 1 2 3; do');
    expect(source).toContain('if npm ci; then');
    expect(source).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(source).toContain('id: awf');
    expect(source).not.toContain('runtime: cloud-hypervisor');
  });

  it('compiles the schedule, scan window, safe outputs, and knowledge-base references into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('schedule:');
    expect(lock).toContain('cron:');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Runner Doctor Update');
    const resolvedImports = lock.split('# Resolved workflow manifest:')[1]?.split('# Secrets used:')[0];
    expect(resolvedImports).toContain('shared/diagnosis-maintenance.md');
    expect(resolvedImports).not.toContain('shared/self-hosted-failure-modes.md');
    expect(lock).toContain('Prepare runner doctor context');
    expect(lock).toContain('Upload runner doctor context');
    expect(lock).toContain('Download prepared runner doctor context');
    expect(lock).toContain('candidate-results.jsonl');
    expect(lock).toContain('for attempt in 1 2 3; do');
    expect(lock).toContain('if npm ci; then');
    expect(lock).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(lock).toContain('GH_AW_INFO_AGENT_RUNTIME: ""');
    expect(lock).not.toContain('--container-runtime cloud-hypervisor');
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@[a-f0-9]{40}/);
    expect(lock).toMatch(/needs\.prepare_candidates\.outputs\.has_candidates == 'true'/);
    const manifestLine = lock.split('\n').find((line) => line.startsWith('# gh-aw-manifest: '));
    expect(manifestLine).toBeDefined();
    const manifest = JSON.parse(manifestLine!.slice('# gh-aw-manifest: '.length)) as {
      mcp_servers: { name: string; tools: string[] }[];
    };
    const githubTools = manifest.mcp_servers.find((server) => server.name === 'github')?.tools;
    expect(githubTools).toEqual(expect.arrayContaining(['issue_read', 'pull_request_read']));
    expect(githubTools).not.toContain('get_commit');
    expect(githubTools).not.toContain('search_code');
  });

  it('retries a failed install and stops after three failed attempts', () => {
    const lock = yaml.load(fs.readFileSync(lockPath, 'utf-8')) as {
      jobs: { agent: { steps: { name: string; run?: string }[] } };
    };
    const install = lock.jobs.agent.steps.find(
      (step) => step.name === 'Install root dependencies for diagnostics tooling'
    )?.run;
    expect(install).toBeDefined();

    for (const [succeedOn, expectedStatus, expectedAttempts] of [[2, 0, '2'], [4, 1, '3']] as const) {
      const result = spawnSync('bash', ['-c',
        `attempt_count=0
         trap 'echo "$attempt_count"' EXIT
         npm() { attempt_count=$((attempt_count + 1)); [ "$attempt_count" -eq ${succeedOn} ]; }
         sleep() { :; }
         ${install}`,
      ], { encoding: 'utf-8' });
      expect(result.status).toBe(expectedStatus);
      expect(result.stdout.trim()).toBe(expectedAttempts);
    }
  });
});
