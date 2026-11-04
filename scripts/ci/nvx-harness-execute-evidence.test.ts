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

  it('wires direct provider-free fixtures into the existing opt-in KVM workflow with an exact revision', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../.github/workflows/nvx-phase-3b-live-kvm.yml'), 'utf8');
    const workflow = load(source) as {
      jobs: Record<string, { if: string; steps: Array<{ name?: string; run?: string }> }>;
    };
    const job = workflow.jobs['live-kvm-evidence'];
    expect(job.if).toContain("'nvx-live-kvm'");
    const step = job.steps.find(({ run }) => run?.includes('scripts/ci/nvx-harness-execute-evidence.ts'));
    expect(step?.run).toContain('AWF_NVX_EVIDENCE_REVISION=$(git rev-parse HEAD)');
    expect(step?.run).toContain('install -m 0755 tests/fixtures/harness-observation/nvx-executable.sh "$target"');
    expect(step?.run).toContain('$layer_root/usr/local/awf-harness-fixtures/$fixture');
    expect(step?.run).toContain('"$PWD/node_modules/.bin/tsx" scripts/ci/nvx-harness-execute-evidence.ts');
    expect(job.steps.find(({ name }) => name === 'Run focused NVX Phase 3d tests')?.run)
      .toContain('scripts/ci/nvx-harness-execute-evidence.test.ts');
    for (const { run } of job.steps) {
      if (run) execFileSync('/bin/bash', ['-n'], { input: run });
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
