import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { parseProbe, probeCommand, selectHarness } from '../../src/model-information-contract/harness-observation';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const driver = require('./cloud-hypervisor-harness-observation.cjs') as {
  cases: Array<{ name: string; harness: string; mode: string; blocked?: boolean; cancel?: boolean }>;
  expected(test: Record<string, unknown>): {
    binary: string; version: string; reason?: string; floor?: string;
  };
  cleanEnvironment(directory: string): Record<string, string>;
  artifactArguments(directory: string): { args: string[]; digests: Record<string, string> };
  waitForSignalExit(signal: string | undefined, report: { status: string }, probeTimedOut: boolean): Promise<never>;
};
const fixtureRoot = path.resolve(__dirname, '../../tests/fixtures/harness-observation/cloud-hypervisor');
const workflowFile = path.resolve(__dirname, '../../.github/workflows/test-cloud-hypervisor.yml');
const driverFile = path.resolve(__dirname, 'cloud-hypervisor-harness-observation.cjs');

describe('portable Cloud Hypervisor acceptance fixtures (not KVM evidence)', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ch-fixture-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function runFixture(harness: string, mode: string, version: string, command = false) {
    const binary = `${directory}/${harness}`;
    fs.copyFileSync(`${fixtureRoot}/executable.sh`, binary);
    fs.chmodSync(binary, 0o755);
    const selection = selectHarness(binary)!;
    const result = spawnSync('/bin/sh', ['-lc', command ? `${binary} --fixture` : probeCommand(selection)], {
      encoding: 'utf8', timeout: 2000,
      env: {
        ...process.env, FIXTURE_MODE: mode, FIXTURE_VERSION: version,
        FIXTURE_DIRECTORY: directory, FIXTURE_ENV: 'controlled-ch-environment',
        AWF_RUNTIME: 'portable-fixture-not-guest',
      },
    });
    expect(result.error).toBeUndefined();
    return {
      result,
      report: parseProbe({ environment: 'portable-not-guest', ...selection }, {
        stdout: result.stdout, exitCode: result.status!,
      }),
    };
  }

  it.each([
    ['copilot', 'GitHub Copilot CLI 1.2.3', '1.2.3'],
    ['claude', '2.1.3 (Claude Code)', '2.1.3'],
    ['codex', 'codex-cli 0.89.0', '0.89.0'],
  ])('executes canonical %s fixtures and discards informational metadata', (harness, raw, version) => {
    const probe = runFixture(harness, 'valid', raw);
    expect(probe.report).toMatchObject({
      status: 'observed', version, resolvedBinary: `${directory}/${harness}`,
    });
    expect(JSON.stringify(probe.report)).not.toContain('discard-this-ch');
    expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
    const command = runFixture(harness, 'valid', raw, true);
    expect(command.result.status).toBe(23);
    expect(command.result.stdout).toBe('fixture-ch-command-output\n');
    expect(command.result.stderr).toBe('fixture-ch-command-stderr\n');
    expect(fs.readFileSync(`${directory}/probe-context`, 'utf8'))
      .toBe(fs.readFileSync(`${directory}/command-context`, 'utf8'));
  });

  it.each([
    ['malformed', 'probe_output_invalid'], ['failed', 'probe_failed'],
    ['overflow', 'probe_output_limit'], ['over-boundary', 'probe_output_limit'],
  ])('produces the actual %s failure shape without retaining raw output', (mode, reason) => {
    const { report } = runFixture('copilot', mode, 'GitHub Copilot CLI 1.2.3');
    expect(report).toMatchObject({ status: 'unavailable', reason });
    expect(JSON.stringify(report)).not.toContain('discard-this-ch');
  });

  it('distinguishes exactly 4096 bytes from 4097, including the resolved path and final newline', () => {
    for (const [mode, bytes, status] of [
      ['boundary', 4096, 'observed'], ['over-boundary', 4097, 'unavailable'],
    ] as const) {
      const { result, report } = runFixture('copilot', mode, 'GitHub Copilot CLI 1.2.3');
      expect(Buffer.byteLength(result.stdout)).toBe(bytes);
      expect(report.status).toBe(status);
    }
  });

  it('refuses the credential sentinel without printing it or recording a successful guest marker', () => {
    const binary = `${directory}/copilot`;
    fs.copyFileSync(`${fixtureRoot}/executable.sh`, binary);
    fs.chmodSync(binary, 0o755);
    const result = spawnSync('/bin/sh', [binary, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'awf-ch-fixture-secret-must-not-leak' },
    });
    expect(result.status).toBe(90);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(`${directory}/probe-context`)).toBe(false);
  });

  it('includes admission, bounded failures, legacy-unverified execution, and probe cancellation', () => {
    expect(driver.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'copilot-admit', floor: '1.2.0' }),
      expect.objectContaining({ name: 'copilot-incompatible', floor: '99.0.0', blocked: true }),
      expect.objectContaining({ name: 'copilot-unverified-legacy', mode: 'malformed' }),
      expect.objectContaining({ mode: 'cancel', cancel: true }),
    ]));
    for (const mode of ['missing', 'malformed', 'failed', 'overflow', 'over-boundary', 'timeout']) {
      const test = driver.cases.find(test => test.mode === mode)!;
      expect(test.blocked).toBe(true);
      expect(driver.expected(test).reason).toMatch(/^binary_missing$|^probe_/);
    }
    expect(driver.expected({ harness: 'codex', relative: true, mode: 'valid' }).binary).toBe('./bin/codex');
  });

  it('keeps cancelled workflow continuation pending until signal cleanup exits', () => {
    const cleanup = `${directory}/cleanup`;
    const resumed = `${directory}/resumed`;
    const script = `
      const fs = require('node:fs');
      const { waitForSignalExit } = require(${JSON.stringify(driverFile)});
      let signal;
      process.once('SIGTERM', () => {
        signal = 'SIGTERM';
        fs.writeFileSync(${JSON.stringify(cleanup)}, 'started');
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(cleanup)}, 'complete');
          process.exit(143);
        }, 25);
      });
      setInterval(() => {}, 1000);
      (async () => {
        process.kill(process.pid, 'SIGTERM');
        await new Promise(resolve => process.once('SIGTERM', resolve));
        await waitForSignalExit(signal, { status: 'unavailable' }, false);
        fs.writeFileSync(${JSON.stringify(resumed)}, 'continued');
      })();
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 2000 });
    expect(result.status).toBe(143);
    expect(fs.readFileSync(cleanup, 'utf8')).toBe('complete');
    expect(fs.existsSync(resumed)).toBe(false);
    expect(() => driver.waitForSignalExit('SIGTERM', { status: 'unavailable' }, true)).toThrow();
  });

  it('does not forward ambient credentials or preload options to the CLI', () => {
    const environment = driver.cleanEnvironment(directory);
    expect(environment.GITHUB_WORKSPACE).toBe(`${directory}/workspace`);
    expect(environment.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS).toBe('1');
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'COPILOT_MODEL']) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it('requires explicit test-only preload enablement before instrumenting compiled code', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { install } = require(`${fixtureRoot}/preload.cjs`);
    expect(install).toThrow('test preload requires explicit opt-in');
  });

  it.each(['observed', 'unavailable'])(
    'exercises real request/routing consumers with %s portable report fixtures, not a mounted sidecar',
    status => {
      // These redirects are intentionally confined to a child process. The live
      // sidecar consumer uses neither a path redirect nor simulated ownership.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { checkProxy } = require(`${fixtureRoot}/proxy-check.cjs`);
      const context = { environment: 'cloud-hypervisor:portable-fixture', name: 'copilot-cli', binary: 'copilot' };
      const report = status === 'observed'
        ? { ...context, status, version: '1.2.3', resolvedBinary: '/workspace/bin/copilot' }
        : { ...context, status, reason: 'probe_output_invalid' };
      const filename = `${directory}/report.json`;
      fs.writeFileSync(filename, JSON.stringify(report), { mode: 0o644 });
      const proxyRoot = path.resolve(__dirname, '../../containers/api-proxy');
      const script = `
        const Module = require('node:module');
        const originalResolve = Module._resolveFilename;
        Module._resolveFilename = function(name, ...args) {
          return originalResolve.call(this,
            name.startsWith('/app/') ? ${JSON.stringify(proxyRoot)} + name.slice(4) : name, ...args);
        };
        const fs = require('node:fs');
        const open = fs.openSync;
        const stat = fs.fstatSync;
        let reportFd;
        fs.openSync = function(name, ...args) {
          if (name !== '/var/log/api-proxy/harness-observation.json') return open(name, ...args);
          reportFd = open(${JSON.stringify(filename)}, ...args);
          return reportFd;
        };
        fs.fstatSync = function(fd) {
          const result = stat(fd);
          if (fd === reportFd) result.uid = 0;
          return result;
        };
        (${checkProxy.toString()})(${JSON.stringify(report)}).then(value => {
          process.stdout.write(JSON.stringify(value));
        }).catch(error => { console.error(error); process.exitCode = 1; });
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8', timeout: 10000,
        env: {
          ...process.env, AWF_HARNESS_ENVIRONMENT: context.environment,
          AWF_SELECTED_HARNESS: context.name, AWF_HARNESS_BINARY: context.binary,
        },
      });
      expect(JSON.parse(output)).toMatchObject({
        requestPin: true, routingPin: status === 'observed', runIsolation: true, harnessIsolation: true,
      });
    },
  );

  it('requires every artifact digest and never silently substitutes a host executable', () => {
    const files = ['cloud-hypervisor', 'virtiofsd', 'vmlinux.bin', 'rootfs.ext4', 'awf-supervisor'];
    for (const file of files) fs.writeFileSync(`${directory}/${file}`, 'fixture');
    fs.writeFileSync(`${directory}/SHA256SUMS`, files.map(file => `${'a'.repeat(64)}  ${file}\n`).join(''));
    expect(driver.artifactArguments(directory).args).toEqual(expect.arrayContaining([
      '--cloud-hypervisor-binary', `${directory}/cloud-hypervisor`,
      '--cloud-hypervisor-virtiofsd-sha256', 'a'.repeat(64),
    ]));
    fs.writeFileSync(`${directory}/SHA256SUMS`, `${'a'.repeat(64)}  cloud-hypervisor\n`);
    expect(() => driver.artifactArguments(directory)).toThrow('missing vmlinux.bin digest');
  });

  it('refuses unsupported local execution rather than declaring a skipped job a pass', () => {
    const result = spawnSync(process.execPath, [driverFile, directory], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, RUNNER_ENVIRONMENT: 'self-hosted', AWF_CH_HARNESS_ARTIFACTS: directory },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cloud Hypervisor harness acceptance failed');
    expect(fs.existsSync(`${directory}/results.json`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${directory}/failure.json`, 'utf8')))
      .toMatchObject({ passed: false, liveAcceptance: false, phase: 'host-eligibility' });
  });

  it('wires separately named evidence into the existing gated KVM lifecycle, without dispatching', () => {
    const workflow = yaml.load(fs.readFileSync(workflowFile, 'utf8')) as {
      on: { pull_request: { paths: string[] } };
      jobs: Record<string, {
        if?: string; needs?: string; 'runs-on'?: string;
        steps: Array<{ name?: string; run?: string; if?: string; with?: Record<string, string> }>;
      }>;
    };
    const job = workflow.jobs['live-kvm'];
    expect(job.needs).toBe('build-test-artifacts');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.if).toContain('cloud-hypervisor-kvm');
    expect(workflow.on.pull_request.paths).toContain('scripts/ci/cloud-hypervisor-harness-observation*');
    const step = job.steps.find(step => step.name === 'Run provider-free live guest harness observations')!;
    expect(step.run).toContain('timeout --kill-after=20s 1800s');
    expect(step.run).toContain('node scripts/ci/cloud-hypervisor-harness-observation.cjs');
    expect(step.run).toContain('"$RUNNER_TEMP/cloud-hypervisor-test-x86_64"');
    expect(step.run).not.toMatch(/workflow run|continue-on-error|\|\| true/);
    expect(step.run).toContain('"AWF_CH_HARNESS_ARTIFACTS=$PWD/artifacts/cloud-hypervisor-harness-observation-live"');
    expect(job.steps.find(step => step.with?.name === 'cloud-hypervisor-harness-observation-live'))
      .toMatchObject({ if: 'always()', with: { path: 'artifacts/cloud-hypervisor-harness-observation-live/*.json' } });
    expect(job.steps.find(step => step.with?.name === 'cloud-hypervisor-harness-deterministic'))
      .toMatchObject({ if: 'always()' });
    execFileSync('sh', ['-n', `${fixtureRoot}/executable.sh`]);
    for (const file of [driverFile, `${fixtureRoot}/preload.cjs`, `${fixtureRoot}/proxy-check.cjs`]) {
      execFileSync(process.execPath, ['--check', file]);
    }
  });

  it('keeps the existing KVM label provider-free and distinct from every label-triggered inference gate', () => {
    const workflows = path.resolve(__dirname, '../../.github/workflows');
    type LabelWorkflow = {
      name?: string;
      on?: {
        pull_request?: { types?: string[] };
        workflow_run?: { workflows?: string[] };
      };
      jobs?: Record<string, { if?: string; needs?: string | string[] }>;
    };
    const normalized = (expression = '') => expression.replace(/\s+/g, ' ').trim();
    const needs = (job: { needs?: string | string[] }) =>
      typeof job.needs === 'string' ? [job.needs] : job.needs || [];
    const label = 'cloud-hypervisor-kvm';
    const labelOwners = fs.readdirSync(workflows).filter(name => name.endsWith('.yml') &&
      fs.readFileSync(path.join(workflows, name), 'utf8').includes(`'${label}'`));
    expect(labelOwners).toEqual(['test-cloud-hypervisor.yml']);
    const primary = fs.readFileSync(workflowFile, 'utf8');
    expect(primary).not.toContain('secrets.');
    const primaryDoc = yaml.load(primary) as LabelWorkflow;
    expect(normalized(primaryDoc.jobs!['live-kvm'].if)).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.run_live_kvm) || " +
      "(github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'cloud-hypervisor-kvm'))",
    );

    let checked = 0;
    for (const filename of fs.readdirSync(workflows).filter(name => name.endsWith('.lock.yml'))) {
      const doc = yaml.load(fs.readFileSync(path.join(workflows, filename), 'utf8')) as LabelWorkflow;
      if (!doc.on?.pull_request?.types?.includes('labeled') || !doc.jobs?.agent) continue;
      checked++;
      const agent = doc.jobs.agent;
      expect(needs(agent)).toContain('activation');
      if (filename === 'security-guard.lock.yml') {
        expect(normalized(agent.if)).toBe(
          "((needs.check_security_relevance.outputs.security_files_changed != '0') && " +
          "((github.event_name == 'pull_request') && github.event.label.name == 'ready-for-aw' || " +
          "!(github.event_name == 'pull_request'))) && " +
          "(needs.activation.outputs.daily_ai_credits_exceeded != 'true')",
        );
        continue;
      }
      // Require the complete known event-selector shape, not just absence of
      // this label's spelling: an unconditional labeled agent must fail too.
      expect(normalized(agent.if)).toBe("needs.activation.outputs.daily_ai_credits_exceeded != 'true'");
      const activation = doc.jobs.activation;
      const labels = [...normalized(activation.if).matchAll(/github\.event\.label\.name == '([^']+)'/g)]
        .map(match => match[1]);
      expect(labels.length).toBeGreaterThan(0);
      expect(labels).not.toContain(label);
      const alternatives = labels.map(value => `github.event.label.name == '${value}'`).join(' || ');
      const eventGate = "(github.event_name == 'pull_request') && " +
        (labels.length > 1 ? `(${alternatives})` : alternatives) +
        " || !(github.event_name == 'pull_request')";
      if (needs(activation).includes('pre_activation')) {
        expect(normalized(activation.if))
          .toBe(`needs.pre_activation.outputs.activated == 'true' && (${eventGate})`);
        expect(normalized(doc.jobs.pre_activation.if)).toBe(eventGate);
      } else {
        expect(normalized(activation.if)).toBe(eventGate);
      }
    }
    expect(checked).toBeGreaterThan(0);

    const enclave = yaml.load(fs.readFileSync(path.join(workflows, 'test-cloud-hypervisor-enclaves.yml'), 'utf8')) as LabelWorkflow;
    expect(normalized(enclave.jobs!['live-kvm'].if)).toBe(
      "always() && !cancelled() && github.event_name == 'workflow_dispatch' && " +
      "inputs.run_live_kvm && needs.deterministic.result == 'success' && " +
      "((inputs.artifact_mode == 'candidate' && needs.candidate-artifacts.result == 'success') || " +
      "(inputs.artifact_mode != 'candidate' && needs.candidate-artifacts.result == 'skipped'))",
    );
    expect(primaryDoc.name).toBe('Cloud Hypervisor Preview Integration');
    expect(enclave.name).toBe('Cloud Hypervisor Enclave Conformance');
    for (const filename of fs.readdirSync(workflows).filter(name => name.endsWith('.yml'))) {
      const source = fs.readFileSync(path.join(workflows, filename), 'utf8');
      if (!source.includes('workflow_run:')) continue;
      const watcher = (yaml.load(source) as LabelWorkflow).on?.workflow_run;
      if (!watcher) continue;
      expect(watcher.workflows?.length).toBeGreaterThan(0);
      expect(watcher.workflows).not.toContain(primaryDoc.name);
      expect(watcher.workflows).not.toContain(enclave.name);
      // A new broad completion watcher requires review of its downstream
      // inference/credential path, even if it never names this PR label.
      expect(watcher.workflows!.some(name => /[*?[\]]/.test(name))).toBe(false);
    }
    const smoke = fs.readFileSync(path.resolve(__dirname, 'cloud-hypervisor-live-smoke.sh'), 'utf8');
    expect(smoke).toContain('export OPENAI_API_KEY="$SECRET_SENTINEL"');
    expect(smoke).not.toMatch(/\b(COPILOT_GITHUB_TOKEN|ANTHROPIC_API_KEY|COPILOT_PROVIDER_API_KEY|GEMINI_API_KEY)\b/);
    expect(smoke).not.toMatch(/\b(copilot|claude|codex)\s+(?:-p|exec|--model)\b/);
  });
});
