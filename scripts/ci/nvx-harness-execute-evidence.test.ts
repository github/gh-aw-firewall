import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { load } from 'js-yaml';
import {
  collectNvxHarnessExecuteEvidence, NVX_HARNESS_FIXTURE_ROOT,
} from './nvx-harness-execute-evidence';
import type { Inputs } from './nvx-manager-live-evidence';

type Execute = NonNullable<Parameters<typeof collectNvxHarnessExecuteEvidence>[1]>;
const inputs: Inputs = {
  artifacts: '/artifacts', layer: '/layer', bridge: 'awfnvxbr0',
  signerWorkflow: 'github/gh-aw-firewall/.github/workflows/nvx-phase-3b-live-kvm.yml',
  evidence: '/evidence',
};

function fakeExecute(): jest.MockedFunction<Execute> {
  let index = 0;
  return jest.fn<ReturnType<Execute>, Parameters<Execute>>(async (_inputs, options) => {
    const timeout = options.name === 'execution-timeout';
    const cancelled = options.name === 'execution-cancel';
    const failed = options.name === 'failed-version';
    const command = options.name === 'command-exit';
    const output = options.name === 'claude-version' ? '1.2.3 (Claude Code)' :
      options.name === 'codex-version' ? 'codex-cli 1.2.3' :
      options.name === 'malformed-version' ? 'not-a-version' :
      options.name === 'oversized-version' ? 'x'.repeat(5000) :
      command ? 'NVX-FIXTURE-COMMAND\nNVX-FIXTURE-COMMAND-STDERR' :
      failed ? 'NVX-FIXTURE-VERSION-FAILED' : '1.2.3';
    return {
      runId: (++index).toString(16).padStart(32, '0'),
      result: {
        exitCode: timeout ? 124 : cancelled ? 130 : failed ? 7 : command ? 23 : 0,
        category: timeout ? 'timeout' : cancelled ? 'cancelled' : failed || command ? 'guest-exit' : 'success',
        signal: timeout || cancelled ? 'SIGTERM' : null,
        timedOut: timeout,
        outcome: undefined,
      },
      output: {
        stdout: `NVX-SANDBOX-READY: pid=1 layers=1\n` +
          `NVX-FIXTURE-CONTEXT: uid=65534 gid=65534 cwd=/\r\n` +
          'NVX-FIXTURE-ENV: path=/usr/sbin:/usr/bin:/sbin:/bin home=/home/nobody user=nobody logname=nobody\n' +
          `${output}\n` +
          'NVX-SANDBOX-EXIT: status=0\n',
        stderr: '',
      },
      residue: [],
    };
  });
}

describe('NVX existing execute evidence (deterministic, not live KVM)', () => {
  it('uses direct fixture entrypoints and existing arguments without guest wrappers, mounts or environment injection', async () => {
    const execute = fakeExecute();
    const evidence = await collectNvxHarnessExecuteEvidence(inputs, execute);
    expect(execute).toHaveBeenCalledTimes(9);
    expect(execute).toHaveBeenNthCalledWith(1, inputs, {
      name: 'copilot-version', entrypoint: `${NVX_HARNESS_FIXTURE_ROOT}/valid/copilot`,
      args: ['--version'], timeoutMs: 120_000,
    });
    expect(execute).toHaveBeenNthCalledWith(7, inputs, {
      name: 'command-exit', entrypoint: `${NVX_HARNESS_FIXTURE_ROOT}/valid/copilot`,
      args: ['--fixture-command'], timeoutMs: 120_000,
    });
    expect(execute).toHaveBeenNthCalledWith(8, inputs, {
      name: 'execution-timeout', entrypoint: `${NVX_HARNESS_FIXTURE_ROOT}/timeout/copilot`,
      args: ['--version'], timeoutMs: 10_000,
    });
    expect(execute).toHaveBeenNthCalledWith(9, inputs, {
      name: 'execution-cancel', entrypoint: `${NVX_HARNESS_FIXTURE_ROOT}/timeout/copilot`,
      args: ['--version'], timeoutMs: 120_000, abortAfterMs: 10_000,
    });
    expect(evidence).toMatchObject({
      canonicalObservation: 'not-produced',
      environmentEquivalence: 'not-established between disposable guests',
      productionAdmission: expect.stringContaining('runtime_probe_unsupported'),
      outputSurface: expect.stringContaining('not isolated harness stdout/stderr'),
    });
    expect(evidence.executions[5].execution.output.stdout).toContain('x'.repeat(5000));
  });

  it.each(['outcome', 'context', 'environment', 'output', 'residue', 'duplicate-run'] as const)(
    'rejects misleading %s evidence rather than counting a marker as acceptance', async failure => {
      const execute = fakeExecute();
      const run = execute.getMockImplementation()!;
      execute.mockImplementation(async (...args) => {
        const value = await run(...args);
        if (failure === 'outcome') value.result.category = 'vmm-failure';
        if (failure === 'context') value.output.stdout = value.output.stdout.replace('uid=65534', 'uid=0');
        if (failure === 'environment') value.output.stdout = value.output.stdout.replace('home=/home/nobody', 'home=/root');
        if (failure === 'output') value.output.stdout = 'NVX-FIXTURE-CONTEXT: uid=65534 gid=65534 cwd=/\n';
        if (failure === 'residue') value.residue.push('/run/still-present');
        if (failure === 'duplicate-run') value.runId = 'a'.repeat(32);
        return value;
      });
      await expect(collectNvxHarnessExecuteEvidence(inputs, execute)).rejects.toThrow(/NVX/);
    },
  );

  it('does not continue to another execution after a startup, outcome or cleanup exception', async () => {
    const execute = fakeExecute().mockRejectedValueOnce(new Error('NVX cleanup failed'));
    await expect(collectNvxHarnessExecuteEvidence(inputs, execute)).rejects.toThrow('NVX cleanup failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  async function workflowDefinition() {
    const source = await fs.readFile(path.join(__dirname, '../../.github/workflows/nvx-phase-3b-live-kvm.yml'), 'utf8');
    return load(source) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
      jobs: Record<string, {
        if: string; needs?: string; permissions: Record<string, string>; 'runs-on': string;
        steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }>;
      }>;
    };
  }

  it('isolates both opt-in directions: fixtures never select full inference, and full never selects fixture execution', async () => {
    const workflow = await workflowDefinition();
    const fixture = workflow.jobs['harness-execute-evidence'];
    const full = workflow.jobs['live-kvm-evidence'];
    expect(fixture.if.replace(/\s+/g, ' ').trim()).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.suite == 'fixtures') || " +
      "(github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'nvx-harness-execute'))",
    );
    expect(full.if.replace(/\s+/g, ' ').trim()).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.suite == 'full') || " +
      "(github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'nvx-live-kvm'))",
    );
    expect(workflow.on.workflow_dispatch.inputs.suite).toEqual({
      description: 'Evidence suite (full includes provider inference)',
      type: 'choice', required: true, default: 'full', options: ['full', 'fixtures'],
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(fixture.permissions).toEqual({ contents: 'read' });
    expect(full.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    const fullRuns = full.steps.map(({ run }) => run ?? '').join('\n');
    expect(fullRuns).toContain('scripts/ci/nvx-manager-live-evidence.ts');
    expect(fullRuns).not.toContain('scripts/ci/nvx-harness-execute-evidence.ts');
  });

  it('reuses attested artifacts and signer identity without granting provider permissions to provisioning', async () => {
    const workflow = await workflowDefinition();
    const build = workflow.jobs['build-attested-artifacts'];
    const fixture = workflow.jobs['harness-execute-evidence'];
    expect(build.if.replace(/\s+/g, ' ').trim()).toBe(
      "github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && " +
      "(contains(github.event.pull_request.labels.*.name, 'nvx-live-kvm') || " +
      "contains(github.event.pull_request.labels.*.name, 'nvx-harness-execute')))",
    );
    expect(build.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' });
    expect(fixture.needs).toBe('build-attested-artifacts');
    expect(fixture['runs-on']).toBe('ubuntu-24.04');
    expect(fixture.steps.find(({ uses }) => uses?.startsWith('actions/download-artifact@'))?.with)
      .toEqual({ name: 'nvx-attested-artifacts', path: '${{ runner.temp }}/nvx-attested-artifacts' });
    expect(fixture.steps.find(({ name }) => name === 'Run existing execute with provider-free fixture distro')?.env)
      .toMatchObject({
        ALPINE_IMAGE: 'alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f',
        SIGNER_WORKFLOW: 'github/gh-aw-firewall/.github/workflows/nvx-phase-3b-live-kvm.yml',
      });
    const provision = fixture.steps.map(({ run }) => run ?? '').join('\n');
    expect(provision).toContain('acl bubblewrap e2fsprogs erofs-utils iproute2 iptables jq nftables python3 uidmap');
    expect(provision).toContain('sudo chown -R root:root "$artifact_dir"');
    expect(provision).toContain('sudo docker network create --driver bridge --subnet 172.30.0.0/24');
    expect(provision).toContain('trap cleanup EXIT');
    expect(provision).toContain('sudo docker network rm awf-nvx-harness || status=1');
    expect(provision).toContain('node_modules/.bin/tsx');
    expect(provision).not.toMatch(/COPILOT_GITHUB_TOKEN|secrets\.|copilot-requests|@github\/copilot|npm pack|run-copilot-proof|api-proxy|squid|docker (?:run|compose)|scripts\/ci\/nvx-manager-live-evidence\.ts/);
    expect(JSON.stringify(fixture)).not.toMatch(/COPILOT_GITHUB_TOKEN|secrets\.|copilot-requests/);
    expect(fixture.steps.find(({ name }) => name === 'Upload fixture execute evidence')?.with)
      .toMatchObject({ name: 'nvx-harness-execute-evidence', path: '${{ runner.temp }}/nvx-harness-execute-evidence/' });
  });

  it('wires direct fixtures and automatic validation with an exact revision and valid shell syntax', async () => {
    const workflow = await workflowDefinition();
    const job = workflow.jobs['harness-execute-evidence'];
    const step = job.steps.find(({ run }) => run?.includes('scripts/ci/nvx-harness-execute-evidence.ts'));
    expect(step?.run).toContain('AWF_NVX_EVIDENCE_REVISION=$(git rev-parse HEAD)');
    expect(step?.run).toContain('install -m 0755 tests/fixtures/harness-observation/nvx-executable.sh "$target"');
    expect(step?.run).toContain('$layer_root/usr/local/awf-harness-fixtures/$fixture');
    expect(step?.run).toContain('"$PWD/node_modules/.bin/tsx" scripts/ci/nvx-harness-execute-evidence.ts');
    expect(job.steps.find(({ name }) => name === 'Validate fixture runner and existing execute interfaces')?.run)
      .toContain('scripts/ci/nvx-harness-execute-evidence.test.ts');
    for (const { steps } of Object.values(workflow.jobs)) {
      for (const { run } of steps) {
        if (run) execFileSync('/bin/bash', ['-n'], { input: run });
      }
    }
  });

  describe('provider-free fixture executable (local shell, not a guest)', () => {
    let directory: string;
    beforeEach(async () => {
      directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvx-execute-fixture-')));
    });
    afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    async function fixture(mode: string, harness = 'copilot'): Promise<string> {
      const target = path.join(directory, mode, harness);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(__dirname, '../../tests/fixtures/harness-observation/nvx-executable.sh'), target);
      await fs.chmod(target, 0o755);
      return target;
    }

    it.each([
      ['copilot', '1.2.3'], ['claude', '1.2.3 (Claude Code)'], ['codex', 'codex-cli 1.2.3'],
    ])('emits %s fixture version without calling a host/provider harness', async (harness, version) => {
      const executable = await fixture('valid', harness);
      const output = execFileSync(executable, ['--version'], { encoding: 'utf8', cwd: directory });
      expect(output.split('\n')).toContain(version);
      expect(output).toContain(`cwd=${directory}`);
      expect(output).toContain(`path=${process.env.PATH} home=${process.env.HOME}`);
    });

    it('preserves nonzero command and version exits and recovers both writes', async () => {
      const command = spawnSync(await fixture('valid'), ['--fixture-command'], { encoding: 'utf8' });
      expect(command.status).toBe(23);
      expect(command.stdout).toContain('NVX-FIXTURE-COMMAND\n');
      expect(command.stderr).toBe('NVX-FIXTURE-COMMAND-STDERR\n');
      const failure = spawnSync(await fixture('failed'), ['--version'], { encoding: 'utf8' });
      expect(failure.status).toBe(7);
      expect(failure.stderr).toBe('NVX-FIXTURE-VERSION-FAILED\n');
    });

    it('does not truncate malformed or oversized fixture data into a version', async () => {
      const malformed = execFileSync(await fixture('malformed'), ['--version'], { encoding: 'utf8' });
      expect(malformed.split('\n')).toContain('not-a-version');
      const overflow = execFileSync(await fixture('overflow'), ['--version'], { encoding: 'utf8' });
      expect(overflow.split('\n')).toContain('x'.repeat(5000));
    });
  });
});
