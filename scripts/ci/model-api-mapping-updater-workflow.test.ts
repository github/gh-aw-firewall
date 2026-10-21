import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'model-api-mapping-updater.md'), 'utf8');
const lockText = fs.readFileSync(path.join(workflowsDir, 'model-api-mapping-updater.lock.yml'), 'utf8');
const frontmatter = yaml.load(source.split('---')[1]) as Record<string, any>;
const lock = yaml.load(lockText) as Record<string, any>;

describe('scheduled canonical model source maintenance', () => {
  it('runs daily and manually with serialized runs and a read-only agent token', () => {
    expect(frontmatter.on).toEqual({ schedule: 'daily', workflow_dispatch: null });
    expect(lock.on.workflow_dispatch).toBeDefined();
    expect(lock.on.schedule).toHaveLength(1);
    expect(lock.on.schedule[0].cron.split(' ').slice(2)).toEqual(['*', '*', '*']);
    expect(frontmatter.concurrency).toEqual({
      group: 'model-source-maintenance', 'cancel-in-progress': false,
    });
    expect(frontmatter.permissions).toEqual({
      'copilot-requests': 'write', contents: 'read', 'pull-requests': 'read',
    });
    expect(lock.jobs.agent.permissions.contents).toBe('read');
    expect(lock.jobs.agent.permissions['pull-requests']).not.toBe('write');
    expect(frontmatter.sandbox.agent.id).toBe('awf');
    expect(frontmatter.tools.edit).toBeNull();
  });

  it('limits authoring to canonical inputs, reports and every generated projection', () => {
    const outputs = frontmatter['safe-outputs'];
    const create = outputs['create-pull-request'];
    const push = outputs['push-to-pull-request-branch'];
    const { projections } = require('../model-information/maintain.cjs');
    expect(create).toMatchObject({
      draft: false, max: 1, 'auto-merge': false, 'auto-close-issue': false,
      'preserve-branch-name': true, 'allowed-branches': ['automation/model-source-maintenance-*'],
      'base-branch': 'main', 'fallback-as-issue': false,
    });
    expect(push).toMatchObject({
      target: '*', 'required-title-prefix': '[models] ', 'fallback-as-pull-request': false,
    });
    expect(push['allowed-files']).toEqual(create['allowed-files']);
    for (const file of projections) {
      expect(create['allowed-files'].some((pattern: string) =>
        pattern === file || (pattern === 'shared/model-information/*.generated.json' &&
          /^shared\/model-information\/[^/]+\.generated\.json$/.test(file)))).toBe(true);
    }
    expect(create['allowed-files']).not.toContain('**/*');
    expect(create['allowed-files']).not.toContain('scripts/**');
    expect(outputs['merge-pull-request']).toBeUndefined();
    expect(outputs['create-issue']).toBeUndefined();
    expect(create['github-token-for-extra-empty-commit']).toBe('none');
  });

  it('fetches evidence, reuses one PR branch, validates before safe-output writes', () => {
    const steps = frontmatter.steps as { name: string; run?: string; if?: string }[];
    const prepare = steps.find(step => step.name === 'Select the single open maintenance PR')!.run!;
    expect(prepare).toContain('select-pr');
    expect(prepare).toContain('existing-pr.json');
    expect(prepare).toContain('git checkout -B model-source-maintenance FETCH_HEAD');
    expect(prepare).toContain('git rev-parse HEAD');
    expect(steps.some(step => step.run?.includes('maintain.cjs capture'))).toBe(true);
    expect(frontmatter['post-steps'].at(-1).run).toBe('node scripts/model-information/maintain.cjs verify');
    expect(frontmatter['post-steps'][0].run).toContain('npm test -- --runInBand');
    const agentSteps = lock.jobs.agent.steps;
    const verifyIndex = agentSteps.findIndex((step: any) =>
      step.name === 'Verify source ownership, evidence, complete projections and no-op');
    expect(verifyIndex).toBeGreaterThan(0);
    expect(agentSteps[verifyIndex]['continue-on-error']).not.toBe(true);
    const outputSteps = lock.jobs.safe_outputs.steps;
    const guardIndex = outputSteps.findIndex((step: any) =>
      step.name === 'Block writes after failed source or post-agent validation');
    const processorIndex = outputSteps.findIndex((step: any) => step.id === 'process_safe_outputs');
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(processorIndex);
    expect(outputSteps[guardIndex]).toMatchObject({
      run: 'test "$AGENT_RESULT" = success',
      env: { AGENT_RESULT: '${{ needs.agent.result }}' },
    });
    expect(outputSteps[processorIndex].if).toBeUndefined();
    expect(lockText).toContain('maintain.cjs verify');
    expect(source).toContain('npm run models:generate');
    expect(source).toContain('npm run models:check');
    expect(source).toContain('npm test -- --runInBand');
    expect(source).toContain('report_incomplete');
    expect(source).toContain('Missing pages/models alone');
    expect(source).toContain('Do not activate');
  });

  it('compiles authoring and no-op tools but not merge or publication', () => {
    const manifestLine = lockText.split('\n').find(line => line.startsWith('# gh-aw-manifest: '))!;
    const manifest = JSON.parse(manifestLine.slice('# gh-aw-manifest: '.length));
    const safeTools = manifest.mcp_servers.find((server: any) => server.name === 'safeoutputs').tools;
    expect(safeTools).toEqual(expect.arrayContaining([
      'noop', 'report_incomplete', 'create_pull_request', 'push_to_pull_request_branch',
    ]));
    expect(safeTools).not.toContain('merge_pull_request');
    expect(safeTools).not.toContain('create_release');
    expect(safeTools).not.toContain('create_issue');
    expect(lockText).not.toContain('GH_AW_CI_TRIGGER_TOKEN');
    expect(lockText.split('\n')[0]).toContain('"compiler_version":"v0.92.6"');
  });
});
