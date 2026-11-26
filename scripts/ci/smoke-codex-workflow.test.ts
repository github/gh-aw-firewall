import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeCodexSourcePath = path.join(workflowsDir, 'smoke-codex.md');
const smokeCodexLockPath = path.join(workflowsDir, 'smoke-codex.lock.yml');

describe('smoke codex token-usage verification', () => {
  it('runs only after the agent succeeds in both source and compiled workflow', () => {
    for (const workflowPath of [smokeCodexSourcePath, smokeCodexLockPath]) {
      const workflow = fs.readFileSync(workflowPath, 'utf-8');

      expect(workflow).toMatch(
        /^[ \t]*verify_token_usage:[ \t]*\r?\n(?:[ \t]*name:[^\r\n]*\r?\n)?[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result == 'success'[ \t]*$/m,
      );
      expect(workflow).toContain(
        'check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine codex',
      );
    }
  });
});

describe('smoke codex workflow output requirements', () => {
  it('uses a separate trusted AWF job and gates the agent on its outcome', () => {
    for (const workflowPath of [smokeCodexSourcePath, smokeCodexLockPath]) {
      const source = fs.readFileSync(workflowPath, 'utf-8');
      type Step = { name: string; id?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean };
      type Job = { needs: string | string[]; if: string; steps: Step[]; permissions?: Record<string, string> };
      const { jobs } = yaml.load(workflowPath.endsWith('.md') ? source.split('---')[1] : source) as {
        jobs: Record<string, Job>;
      };
      const browser = jobs.verify_playwright;
      expect(browser.needs).toBe('activation');
      expect(browser.permissions).toEqual({ contents: 'read' });
      expect(browser.steps.find(step => step.name === 'Checkout trusted browser check')?.with).toEqual({
        ref: '${{ github.event.pull_request.base.sha || github.workflow_sha }}',
        'persist-credentials': false,
      });
      expect(browser.steps.find(step => step.name === 'Checkout pinned browser check')).toEqual(
        expect.objectContaining({
          if: "steps.browser_check_source.outputs.bootstrap == 'true'",
          with: {
            repository: 'github/gh-aw-firewall',
            ref: '6d417bd1558331f1c4bff44660630f9a2198b3ca',
            path: '.codex-browser-bootstrap',
            'sparse-checkout': '.github/workflows/shared/check-codex-playwright.cjs',
            'sparse-checkout-cone-mode': false,
            'persist-credentials': false,
          },
        }),
      );
      const provision = browser.steps.find(step => step.name === 'Provision Playwright Chromium')!;
      expect(provision.env?.BROWSER_CHECK_PATH).toBe('${{ steps.browser_check_source.outputs.path }}');
      expect(provision.run).toContain('cp "$BROWSER_CHECK_PATH" "$tools/"');
      const check = browser.steps.find(step => step.name === 'Check GitHub title through AWF')!;
      expect(check.run).toContain('node dist/cli.js --build-local --allow-domains github.com,githubassets.com');
      expect(check.run).toContain('--mount "$tools:$tools:ro"');
      expect(check.run).toContain('node "$tools/check-codex-playwright.cjs"');
      expect(check.if).toBeUndefined();
      expect(check['continue-on-error']).not.toBe(true);
      expect([jobs.agent.needs].flat()).toContain('verify_playwright');
      expect(jobs.agent.if).toContain("needs.verify_playwright.result == 'success'");
      expect(source).not.toContain('codex-playwright-${{ github.run_id }}');
      expect(source).not.toContain('RESULT_FILE: /tmp/gh-aw/agent/');
    }
  });

  it.each([true, false])('selects the base helper when present=%s, otherwise the pinned bootstrap', basePresent => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');
    const { jobs } = yaml.load(source.split('---')[1]) as {
      jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
    };
    const script = jobs.verify_playwright.steps.find(step => step.id === 'browser_check_source')!.run!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-browser-source-'));
    try {
      if (basePresent) {
        const helper = path.join(dir, '.github/workflows/shared/check-codex-playwright.cjs');
        fs.mkdirSync(path.dirname(helper), { recursive: true });
        fs.writeFileSync(helper, 'base');
      }
      const output = path.join(dir, 'output');
      execFileSync('bash', ['-e', '-c', script], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      expect(fs.readFileSync(output, 'utf-8')).toBe(basePresent
        ? 'path=.github/workflows/shared/check-codex-playwright.cjs\nbootstrap=false\n'
        : 'path=.codex-browser-bootstrap/.github/workflows/shared/check-codex-playwright.cjs\nbootstrap=true\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips success publication when the browser blocks the agent but keeps failure reporting', () => {
    const lock = yaml.load(fs.readFileSync(smokeCodexLockPath, 'utf-8')) as {
      jobs: Record<string, { needs: string[]; if: string; steps: { name: string }[] }>;
    };
    expect(lock.jobs.safe_outputs.needs).toContain('agent');
    expect(lock.jobs.safe_outputs.if).toContain("needs.agent.result != 'skipped'");
    expect(lock.jobs.conclusion.needs).toContain('verify_playwright');
    expect(lock.jobs.conclusion.if).toContain("needs.verify_playwright.result == 'failure'");
    expect(lock.jobs.conclusion.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Record incomplete' }),
      expect.objectContaining({ name: 'Report failed jobs' }),
    ]));
  });

  it('pins Playwright CLI to a version available outside the npm release cooldown', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');

    expect(source).toContain('playwright:\n    version: "0.1.21"');
    expect(lock).toContain('npm install -g @playwright/cli@0.1.21');
  });

  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**, call `add_comment`');
    expect(source).toContain('If all tests pass on a pull request trigger:');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`');
    expect(source).toContain('Do NOT attempt to add pull request comments or labels when there is no pull request.');
  });

  it('uses inline safe-output arguments in a login shell for comments', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain(`/bin/bash -lc 'safeoutputs add_comment "$1"' --`);
    expect(source).toContain('Do not build comment payloads with `jq`');
    expect(source).toContain('retry from a non-login shell');
  });
});

describe('smoke codex discussion comment configuration', () => {
  it('enables discussion targeting for add-comment in the workflow source', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    const addCommentBlock = source.match(/ {4}add-comment:\n(?: {6}.+\n)+/);
    expect(addCommentBlock).not.toBeNull();
    expect(addCommentBlock![0]).toContain('discussions: true');
    expect(addCommentBlock![0]).toContain('target: "*"');
  });

  it('uses item_number when commenting on a discussion', () => {
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');

    expect(source).toContain('`item_number: <extracted_number>`');
    expect(source).not.toContain('discussion_number');
  });

  it('grants discussions write permission in the compiled lock file', () => {
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');

    expect(lock).toContain('discussions: write');
    expect(lock).toContain('\\"add_comment\\":{\\"discussions\\":true');
  });
});
