import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const installCommand =
  'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.101 ' +
  '--checksums-sha256 018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be --cooldown-days 3';
const retryWorkflows = ['copilot-token-optimizer', 'dependency-security-monitor'];
const compilerInstallStep =
  '      - name: Install GitHub Copilot CLI\n' +
  `        run: ${installCommand}\n`;

describe.each(retryWorkflows)('%s workflow', workflow => {
  const lockPath = path.join(workflowsDir, `${workflow}.lock.yml`);
  it('pins the CLI install and reviewed checksum instead of resolving mutable compatibility defaults', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, `${workflow}.md`),
      'utf-8',
    );
    const frontmatter = yaml.load(source.split('---')[1]) as {
      engine: { id: string; version: string; 'checksums-sha256': string };
    };
    const lock = fs.readFileSync(
      lockPath,
      'utf-8',
    );
    const compiled = yaml.load(lock) as {
      jobs: { agent: { steps: Array<{ name?: string; run?: string; 'timeout-minutes'?: number }> } };
    };
    const installStep = compiled.jobs.agent.steps.find(
      step => step.name === 'Install GitHub Copilot CLI',
    );
    const metadata = JSON.parse(lock.split('\n')[0].slice('# gh-aw-metadata: '.length));

    expect(frontmatter.engine).toEqual({
      id: 'copilot',
      version: '1.0.101',
      'checksums-sha256': '018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be',
    });
    expect(metadata.engine_versions.copilot).toBe(frontmatter.engine.version);
    expect(installStep?.run).toContain(`90s ${installCommand} || install_status=$?`);
    expect(installStep?.['timeout-minutes']).toBe(7);
    expect(lock).toContain(applyGeneralWorkflowPatches(compilerInstallStep, lockPath).content);
  });

  it('adds retries idempotently without changing unrelated workflows', () => {
    const patched = applyGeneralWorkflowPatches(compilerInstallStep, lockPath).content;
    expect(patched).toContain('for attempt in 1 2 3; do');
    expect(applyGeneralWorkflowPatches(patched, lockPath).content).toBe(patched);
    expect(applyGeneralWorkflowPatches(
      compilerInstallStep,
      path.join(workflowsDir, 'copilot-token-usage-analyzer.lock.yml'),
    ).content).toBe(compilerInstallStep);
  });
});

describe.each(retryWorkflows)('%s installer execution', workflow => {
  let tempDir: string;
  const patched = applyGeneralWorkflowPatches(
    compilerInstallStep, path.join(workflowsDir, `${workflow}.lock.yml`),
  ).content;
  const [step] = yaml.load(patched) as Array<{ run: string }>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-retry-'));
    fs.mkdirSync(path.join(tempDir, 'gh-aw/actions'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'bin'));
    fs.writeFileSync(path.join(tempDir, 'gh-aw/actions/install_copilot_cli.sh'), [
      '#!/bin/bash',
      'count=0',
      'if [ -f "$RUNNER_TEMP/attempts" ]; then count=$(wc -l < "$RUNNER_TEMP/attempts"); fi',
      'printf "%s\\n" "$*" >> "$RUNNER_TEMP/attempts"',
      'read -r -a statuses <<< "$TEST_STATUSES"',
      'exit "${statuses[$count]:-1}"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, 'bin/sleep'), [
      '#!/bin/bash',
      'printf "%s\\n" "$*" >> "$RUNNER_TEMP/delays"',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(tempDir, 'bin/timeout'), [
      '#!/bin/bash',
      'while [[ "$1" == -* ]]; do shift; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ['0', 0, 1, []],
    ['22 0', 0, 2, ['30']],
    ['28 22 0', 0, 3, ['30', '60']],
    ['22 22 22', 22, 3, ['30', '60']],
    ['1 0', 1, 1, []],
    ['127 0', 127, 1, []],
    ['124 0', 124, 1, []],
  ])('handles installer statuses %s without bypassing failures', (statuses, exitCode, attempts, delays) => {
    const result = spawnSync('/bin/bash', ['-e', '-c', step.run], {
      env: {
        PATH: `${tempDir}/bin:/usr/bin:/bin`,
        RUNNER_TEMP: tempDir,
        TEST_STATUSES: String(statuses),
      },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    const calls = fs.readFileSync(path.join(tempDir, 'attempts'), 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(Number(attempts));
    expect(new Set(calls)).toEqual(new Set([
      installCommand.slice(installCommand.indexOf(' 1.0.101') + 1),
    ]));
    const delaysFile = path.join(tempDir, 'delays');
    expect(fs.existsSync(delaysFile)
      ? fs.readFileSync(delaysFile, 'utf-8').trim().split('\n')
      : []).toEqual(delays);
  });
});
