import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const workflowFiles = [
  path.join(workflowsDir, 'smoke-cloud-hypervisor.md'),
  path.join(workflowsDir, 'smoke-cloud-hypervisor.lock.yml'),
];

describe('Smoke Cloud Hypervisor token-usage verification', () => {
  it('runs only after the agent job succeeds', () => {
    for (const workflowFile of workflowFiles) {
      const workflow = fs.readFileSync(workflowFile, 'utf-8');

      expect(workflow).toMatch(
        /^[ \t]*verify_token_usage:[ \t]*\r?\n[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result[ \t]*==[ \t]*'success'[ \t]*$/m,
      );
    }
  });
});
