import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-docker-sbx.md');
const lockPath = path.join(workflowsDir, 'smoke-docker-sbx.lock.yml');

describe('smoke docker-sbx workflow output targeting', () => {
  it('explicitly targets the pull request in the source prompt', () => {
    const workflow = fs.readFileSync(sourcePath, 'utf8');

    expect(workflow).toContain('item_number: ${{ github.event.pull_request.number }}');
    expect(workflow).toContain('Do not rely on implicit triggering context');
  });

  it('propagates the pull request number in the compiled workflow', () => {
    const workflow = fs.readFileSync(lockPath, 'utf8');

    expect(workflow).toContain(
      'GH_AW_GITHUB_EVENT_PULL_REQUEST_NUMBER: ${{ github.event.pull_request.number || inputs.item_number }}',
    );
  });
});
