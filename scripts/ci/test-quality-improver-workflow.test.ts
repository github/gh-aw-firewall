import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';

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

  describe('test quality improver dependency preparation', () => {
    const stepName = 'Prepare locked root test dependencies';
    const sourceStep = frontmatter.steps.find(
      (step: { name: string }) => step.name === stepName,
    ) as { run: string };

    it('prepares root dependencies before launching the agent', () => {
      const steps = lock.jobs.agent.steps as { name?: string; run?: string }[];
      const index = steps.findIndex(step => step.name === stepName);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(steps[index].run?.trimEnd()).toBe(sourceStep.run.trimEnd());
      expect(steps.slice(index + 1).some(step => step.run?.includes('copilot_harness'))).toBe(true);
      expect(steps.some(step => step.name === 'Install awf dependencies')).toBe(false);
      expect(source).toContain('do not reinstall them inside the agent sandbox');
    });

    it.each([0, 1])('preserves locked packages and restores the lockfile when npm exits %s', (exitCode) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-quality-dependencies-'));
      try {
        const original = JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'fixture', version: '1.0.0' },
            'node_modules/example': {
              version: '1.2.3',
              resolved: 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/example/-/example-1.2.3.tgz',
              integrity: 'sha512-fixture',
            },
            'node_modules/@scope/example': {
              version: '2.0.0',
              resolved: 'https://ms-feed-12.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/@scope/example/-/example-2.0.0.tgz',
              integrity: 'sha512-scoped-fixture',
            },
            'node_modules/public': {
              version: '3.0.0',
              resolved: 'https://registry.npmjs.org/public/-/public-3.0.0.tgz',
            },
            'node_modules/custom': {
              version: '4.0.0',
              resolved: 'https://example.com/custom.tgz',
            },
          },
        }, null, 2) + '\n';
        fs.writeFileSync(path.join(dir, 'package-lock.json'), original);
        fs.writeFileSync(path.join(dir, 'npm'), `#!/usr/bin/env node
  const fs = require('fs');
  fs.copyFileSync('package-lock.json', 'installed-lock.json');
  fs.writeFileSync('npm-args.json', JSON.stringify(process.argv.slice(2)));
  process.exit(${exitCode});
  `, { mode: 0o755 });

        const result = spawnSync('bash', ['-c', sourceStep.run], {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir },
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(exitCode);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'installed-lock.json'), 'utf8'))).toEqual({
          ...JSON.parse(original),
          packages: {
            ...JSON.parse(original).packages,
            'node_modules/example': {
              version: '1.2.3',
              resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
              integrity: 'sha512-fixture',
            },
            'node_modules/@scope/example': {
              version: '2.0.0',
              resolved: 'https://registry.npmjs.org/@scope/example/-/example-2.0.0.tgz',
              integrity: 'sha512-scoped-fixture',
            },
          },
        });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'npm-args.json'), 'utf8'))).toEqual([
          'ci', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund',
        ]);
        expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe(original);
        expect(fs.readdirSync(dir).filter(file => file.startsWith('test-quality-package-lock.'))).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
