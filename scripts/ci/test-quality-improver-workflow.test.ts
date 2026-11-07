import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'test-quality-improver.md'), 'utf8');
const frontmatter = yaml.load(source.split('---')[1]) as Record<string, any>;
const lock = yaml.load(fs.readFileSync(
  path.join(workflowsDir, 'test-quality-improver.lock.yml'), 'utf8',
)) as Record<string, any>;
const handlerStep = lock.jobs.safe_outputs.steps.find(
  (step: any) => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG,
);
const handler = JSON.parse(handlerStep.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);

describe('test quality improver file protection', () => {
  it.each([
    ['source', frontmatter['safe-outputs']['create-pull-request']['allowed-files']],
    ['compiled handler', handler.create_pull_request.allowed_files],
  ])('allows direct-child and nested tests without allowing production files in %s', (_, allowedFiles) => {
    // gh-aw's matcher keeps the slash in **/, so direct children need separate patterns.
    expect(allowedFiles).toEqual([
      'src/*.test.ts',
      'src/**/*.test.ts',
      'src/*.test-utils.ts',
      'src/**/*.test-utils.ts',
      'scripts/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**',
      'containers/api-proxy/*.test.js',
      'containers/api-proxy/**/*.test.js',
      'containers/api-proxy/test-helpers/**',
      'containers/cli-proxy/*.test.js',
      'containers/cli-proxy/**/*.test.js',
      'docs/INTEGRATION-TESTS.md',
      'docs/test-analysis/**',
    ]);
  });

  it('keeps protected files blocked and PR creation bounded', () => {
    expect(frontmatter['safe-outputs']['create-pull-request']).toMatchObject({
      draft: true, max: 1, 'protected-files': 'blocked',
    });
    expect(handler.create_pull_request).toMatchObject({
      draft: true, max: 1, protected_files_policy: 'blocked',
    });
  });
});
