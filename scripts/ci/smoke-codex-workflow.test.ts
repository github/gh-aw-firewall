import * as fs from 'fs';
import * as path from 'path';
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
  it('gates every trigger on browser evidence before permission-blocked output relaxation', () => {
    for (const workflowPath of [smokeCodexSourcePath, smokeCodexLockPath]) {
      const workflow = fs.readFileSync(workflowPath, 'utf-8');
      type Step = { name: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: boolean };
      const parsed = yaml.load(workflowPath.endsWith('.md') ? workflow.split('---')[1] : workflow) as {
        steps?: Step[]; 'post-steps'?: Step[]; jobs?: { agent: { steps: Step[] } };
      };
      const steps = parsed.jobs?.agent?.steps ?? [...(parsed.steps ?? []), ...(parsed['post-steps'] ?? [])];
      expect(steps.find(step => step.name === 'Reset Playwright title check')?.run)
        .toMatch(/^rm -f \/tmp\/gh-aw\/agent\/codex-playwright-.+\/result.json$/);
      expect(steps.find(step => step.name === 'Validate Playwright title check')).toMatchObject({
        if: 'always()',
        env: { RESULT_FILE: '/tmp/gh-aw/agent/codex-playwright-${{ github.run_id }}/result.json' },
      });
      const validator = steps.find(step => step.name === 'Validate Playwright title check')!.run!;
      expect(validator).toContain("node <<'NODE'");
      expect(validator).toContain("JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'))");
      expect(validator).not.toContain('scripts/ci/');
      expect(validator).not.toContain('require(process.');
      expect(steps.find(step => step.name === 'Validate Playwright title check')?.['continue-on-error']).not.toBe(true);
      expect(workflow.indexOf('name: Validate Playwright title check'))
        .toBeLessThan(workflow.indexOf('name: Validate safe outputs were invoked'));
    }
    const source = fs.readFileSync(smokeCodexSourcePath, 'utf-8');
    expect(source).toContain('node .github/workflows/shared/check-codex-playwright.cjs run /tmp/gh-aw/agent/codex-playwright-');
    const lock = fs.readFileSync(smokeCodexLockPath, 'utf-8');
    expect(lock).toContain('GH_AW_AGENT_FOLDERS: ".agents .codex .github"');
    expect(lock.indexOf('name: Restore agent config folders from base branch'))
      .toBeLessThan(lock.indexOf('name: Execute Codex'));
    expect(source).toContain('If any required check fails, report overall FAIL and call `report_incomplete`');
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
