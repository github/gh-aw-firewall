import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const validate = require('./validate-agent-regression-triage-outputs.cjs');

const repo = { owner: 'github', repo: 'gh-aw-firewall' };
const repository = `${repo.owner}/${repo.repo}`;
const runId = 123;
const issueNumber = 10;
const workflowSha = 'b'.repeat(40);
const snapshot = `AWF-REGRESSION-TRIAGE:${repository}:${runId}:0123456789abcdef`;

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-triage-validation-'));
  const inputPath = path.join(directory, 'regression-triage.json');
  const outputsPath = path.join(directory, 'safeoutputs.jsonl');
  fs.writeFileSync(inputPath, JSON.stringify({
    repository,
    reports: [{
      number: issueNumber, run_id: runId, attempt: 2, workflow_sha: workflowSha,
      disposition: 'triage', snapshot_marker: snapshot,
    }],
  }));
  fs.writeFileSync(outputsPath, JSON.stringify({
    type: 'add_comment', item_number: issueNumber, body: `Coverage table\n${snapshot}`,
  }));
  const workflow = {
    id: 77, path: '.github/workflows/daily-agent-runtime-regression.yml',
    name: 'Daily Agent Runtime Regression',
  };
  const actions = {
    getWorkflow: jest.fn().mockResolvedValue({ data: workflow }),
    getWorkflowRun: jest.fn().mockResolvedValue({ data: {
      workflow_id: workflow.id, path: workflow.path, status: 'completed', run_attempt: 2,
      head_sha: workflowSha, head_branch: 'main', event: 'schedule',
      repository: { full_name: repository }, head_repository: { full_name: repository },
    } }),
  };
  const issues = {
    get: jest.fn().mockResolvedValue({ data: {
      number: issueNumber, state: 'open',
      title: `Daily agent/runtime regression failed (run ${runId})`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `<!-- awf-agent-runtime-regression:${repository}:${runId} -->\n`,
    } }),
  };
  const options = {
    github: { rest: { actions, issues } },
    context: { repo },
    core: { info: jest.fn() },
    inputPath,
    outputsPath,
  };
  return { directory, options, actions, issues };
}

describe('regression triage safe-output validation', () => {
  let directory: string;

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('allows comments only for a collected open detector report with matching live provenance', async () => {
    const h = harness();
    directory = h.directory;
    await expect(validate(h.options)).resolves.toBe(true);
    expect(h.issues.get).toHaveBeenCalledWith({ ...repo, issue_number: issueNumber });
    expect(h.actions.getWorkflowRun).toHaveBeenCalledWith({ ...repo, run_id: runId });
    expect(h.options.core.info).toHaveBeenCalledWith(
      'Validated 1 safe-output comment target(s) against live detector provenance',
    );
  });

  it('rejects a target not present in the prepared report batch', async () => {
    const h = harness();
    directory = h.directory;
    fs.writeFileSync(h.options.outputsPath, JSON.stringify({
      type: 'add_comment', item_number: 999, body: snapshot,
    }));
    await expect(validate(h.options)).rejects.toThrow('does not match a collected source report');
    expect(h.issues.get).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'closed' },
    { user: { login: 'attacker', type: 'User' } },
    { pull_request: {} },
  ])('rejects untrusted or non-open detector targets: %j', async patch => {
    const h = harness();
    directory = h.directory;
    h.issues.get.mockResolvedValue({
      data: {
        number: issueNumber, state: 'open',
        title: `Daily agent/runtime regression failed (run ${runId})`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        body: `<!-- awf-agent-runtime-regression:${repository}:${runId} -->\n`,
        ...patch,
      },
    });
    await expect(validate(h.options)).rejects.toThrow('not a trusted open detector report');
  });

  it.each([
    { run_attempt: 1 },
    { head_branch: 'feature' },
    { event: 'pull_request' },
  ])('rejects changed or mismatched run provenance: %j', async patch => {
    const h = harness();
    directory = h.directory;
    const run = (await h.actions.getWorkflowRun()).data;
    h.actions.getWorkflowRun.mockResolvedValue({ data: { ...run, ...patch } });
    await expect(validate(h.options)).rejects.toThrow('no longer matches verified detector provenance');
  });

  it('rejects comments without the prepared visible snapshot marker', async () => {
    const h = harness();
    directory = h.directory;
    fs.writeFileSync(h.options.outputsPath, JSON.stringify({
      type: 'add_comment', item_number: issueNumber, body: 'No snapshot identity',
    }));
    await expect(validate(h.options)).rejects.toThrow('does not match a collected source report');
  });

  it('rejects reply/comment aliases that weaken source-report target validation', async () => {
    const h = harness();
    directory = h.directory;
    fs.writeFileSync(h.options.outputsPath, JSON.stringify({
      type: 'add_comment', item_number: issueNumber, pr_number: issueNumber,
      body: snapshot,
    }));
    await expect(validate(h.options)).rejects.toThrow('no unique positive issue number');
    fs.writeFileSync(h.options.outputsPath, JSON.stringify({
      type: 'add_comment', item_number: issueNumber, reply_to_id: '123', body: snapshot,
    }));
    await expect(validate(h.options)).rejects.toThrow('does not match a collected source report');
  });
});
