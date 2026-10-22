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
      target: '${{ needs.select_maintenance_pr.outputs.number }}',
      'required-title-prefix': 'chore: refresh canonical model sources',
      'fallback-as-pull-request': false,
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

  it('preserves trusted evidence and validators, reuses the selected branch, and gates safe outputs', () => {
    const steps = frontmatter.steps as { name: string; run?: string; if?: string }[];
    const preserve = steps.find(step => step.name === 'Preserve trusted validators and main baseline')!.run!;
    expect(preserve).toContain('TRUSTED_REVIEW_BASE');
    expect(preserve).toContain('git archive');
    expect(preserve).toContain('RUNNER_TEMP/model-maintenance-trusted');
    const prepare = steps.find(step => step.name === 'Check out the selected maintenance PR')!.run!;
    expect(prepare).toContain('existing-pr.json');
    expect(prepare).toContain('refs/remotes/origin/$SELECTED_PR_HEAD');
    expect(prepare).toContain('git checkout -B "$SELECTED_PR_HEAD"');
    expect(prepare).toContain('TRUSTED_MAINTENANCE_BASE');
    expect(prepare).toContain('git rev-parse HEAD');
    expect(steps.some(step => step.run?.includes('maintain.cjs capture'))).toBe(true);
    const capture = steps.find(step => step.name === 'Capture approved official sources and governed catalogue');
    expect(capture?.run).toContain('$RUNNER_TEMP/model-maintenance-trusted/code/scripts/model-information/maintain.cjs');
    expect(fs.readFileSync(path.resolve(__dirname, '../model-information/maintain.cjs'), 'utf8'))
      .toContain('TRUSTED_CAPTURES_JSON');
    const regression = frontmatter['post-steps'][0].run as string;
    expect(regression).toContain('while IFS= read -r file');
    expect(regression).toContain('TRUSTED_VALIDATION_DIR/$file');
    expect(regression).toContain('mktemp "$parent/.awf-trusted.XXXXXX"');
    expect(regression).toContain('mv -f -- "$staging" "$destination"');
    expect(regression).toContain('TRUSTED_VALIDATION_FILES');
    expect(regression).toContain('cd "$GITHUB_WORKSPACE"');
    expect(regression).toContain('npm ci --ignore-scripts');
    expect(regression).toContain('npm test -- --runInBand');
    expect(regression).toContain('npm --prefix containers/api-proxy ci --ignore-scripts');
    expect(regression).toContain('models-dev-catalog.test.js ai-credits-pricing-reference.test.js');
    const trustedVerify = frontmatter['post-steps'][1].run as string;
    expect(trustedVerify).toContain('cd "$GITHUB_WORKSPACE"');
    expect(trustedVerify).toContain('verify-committed /tmp/gh-aw/model-maintenance "$GITHUB_WORKSPACE"');
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

  it('binds both the agent and privileged push processor to the trusted selected PR number', () => {
    const selection = frontmatter.jobs.select_maintenance_pr;
    expect(selection.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(selection.outputs).toEqual({
      number: '${{ steps.select.outputs.number }}', head: '${{ steps.select.outputs.head }}',
    });
    const select = selection.steps.find((step: { id?: string }) => step.id === 'select');
    expect(select.run).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(select.run).not.toContain('--base main');
    expect(select.run).toContain('maintain.cjs select-pr');
    expect(select.run).toContain('.number // 0');
    expect(select.run).toContain('>> "$GITHUB_OUTPUT"');
    expect(frontmatter.jobs.agent.needs).toContain('select_maintenance_pr');
    expect(frontmatter['safe-outputs'].needs).toContain('select_maintenance_pr');
    expect(lock.jobs.agent.needs).toContain('select_maintenance_pr');
    expect(lock.jobs.safe_outputs.needs).toContain('select_maintenance_pr');
    const steps = lock.jobs.agent.steps as { env?: Record<string, string> }[];
    const toolConfig = JSON.parse(steps.find(step => step.env?.GH_AW_SAFE_OUTPUTS_CONFIG)!.env!.GH_AW_SAFE_OUTPUTS_CONFIG);
    const outputSteps = lock.jobs.safe_outputs.steps as { id?: string; env?: Record<string, string> }[];
    const handlerConfig = JSON.parse(outputSteps.find(step => step.id === 'process_safe_outputs')!
      .env!.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
    for (const config of [toolConfig, handlerConfig]) {
      expect(config.push_to_pull_request_branch.target).toBe('${{ needs.select_maintenance_pr.outputs.number }}');
      expect(config.push_to_pull_request_branch.title_prefix).toBe('chore: refresh canonical model sources');
    }
  });

  it('grants only required script invocations, not unrestricted interpreters or package runners', () => {
    expect(frontmatter.tools.bash).toEqual([
      'cat', 'jq', 'sha256sum', 'git show:*', 'git diff:*',
      'node scripts/model-information/maintain.cjs refresh-import',
      'node scripts/model-information/maintain.cjs report',
      'node scripts/model-information/maintain.cjs verify',
      'npm run models:generate', 'npm run models:check',
      'npm test -- --runInBand scripts/model-information/ scripts/ci/model-api-mapping-updater-workflow.test.ts src/copilot-model-catalog-sync.test.ts src/model-information-contract.test.ts',
      'npm --prefix containers/api-proxy test -- --runInBand models-dev-catalog.test.js ai-credits-pricing-reference.test.js',
    ]);
    for (const tool of ['shell(node)', 'shell(npm:*)', 'shell(npx:*)', 'shell(git:*)']) {
      expect(lockText).not.toContain(tool);
    }
    expect(lockText).toContain('shell(node scripts/model-information/maintain.cjs refresh-import)');
    expect(lockText).toContain('shell(npm run models:generate)');
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

  it('creates maintenance PR titles accepted by the existing repository title gate', () => {
    const titleWorkflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'pr-title.yml'), 'utf8')) as {
      jobs: Record<string, {
        steps: { uses?: string; with: { types: string; scopes: string; subjectPattern: string } }[];
      }>;
    };
    const gate = titleWorkflow.jobs['pr-title'].steps.find(step =>
      step.uses?.startsWith('amannn/action-semantic-pull-request@'))?.with;
    if (!gate) throw new Error('Missing repository PR title gate');
    const { maintenanceTitle } = require('../model-information/maintain.cjs');
    const match = maintenanceTitle.match(/^([a-z]+)(?:\(([^)]+)\))?: (.+)$/)!;
    expect(match).not.toBeNull();
    expect(gate.types.split(/\s+/)).toContain(match[1]);
    if (match[2]) expect(gate.scopes.split(/\s+/)).toContain(match[2]);
    expect(match[3]).toMatch(new RegExp(gate.subjectPattern));
    expect(maintenanceTitle).toBe(
      `${frontmatter['safe-outputs']['create-pull-request']['title-prefix']}refresh canonical model sources`,
    );
    expect(frontmatter['safe-outputs']['push-to-pull-request-branch']['required-title-prefix'])
      .toBe(maintenanceTitle);
  });
});
