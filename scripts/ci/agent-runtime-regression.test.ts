import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../src/constants/placeholders';
import {
  NVX_AGENT_REGRESSION_SIGNER_WORKFLOW,
  NVX_COMMIT,
  NVX_OPENVMM_COMMIT,
  NVX_RELEASE_TAG,
} from '../../src/nvx/artifact-manifest';

const root = path.resolve(__dirname, '../..');
const workflowFile = path.join(root, '.github/workflows/daily-agent-runtime-regression.yml');
const hostScript = path.join(__dirname, 'run-agent-runtime-regression.sh');
const guestScript = path.join(__dirname, 'run-agent-regression-guest.sh');
const agents = ['copilot', 'codex', 'claude'];
const runtimes = ['docker', 'cloud-hypervisor', 'nvx'];
const copilotCredentialNames = ['COPILOT_GITHUB_TOKEN', 'COPILOT_TOKEN', 'COPILOT_PROVIDER_API_KEY'];

interface Step {
  name: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  steps: Step[];
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  strategy?: {
    'fail-fast': boolean;
    matrix: { agent: string[]; runtime: string[] };
  };
}

interface Workflow {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
  env: Record<string, string>;
}

const workflow = yaml.load(fs.readFileSync(workflowFile, 'utf8')) as Workflow;

function step(job: string, name: string): Step {
  const found = workflow.jobs[job].steps.find(entry => entry.name === name);
  if (!found) throw new Error(`Missing ${job} step: ${name}`);
  return found;
}

describe('daily agent/runtime regression workflow', () => {
  it('runs daily with all nine independent combinations and manual dispatch', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '37 6 * * *' }]);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.jobs['regression-copilot'].strategy).toEqual({
      'fail-fast': false,
      matrix: { agent: ['copilot'], runtime: runtimes },
    });
    expect(workflow.jobs['regression-non-copilot'].strategy).toEqual({
      'fail-fast': false,
      matrix: { agent: ['codex', 'claude'], runtime: runtimes },
    });
    for (const job of ['regression-copilot', 'regression-non-copilot']) {
      expect(workflow.jobs[job].if).toBe(
        "${{ !cancelled() && needs.build.result == 'success' }}",
      );
      expect(workflow.jobs[job].needs).toEqual([
        'build', 'build-cloud-hypervisor', 'build-nvx',
      ]);
    }
  });

  it('pins main once and uses that exact source for every artifact and regression', () => {
    expect(step('build', 'Checkout main').with).toEqual({
      ref: 'main', 'persist-credentials': false,
    });
    expect(step('build', 'Pin source commit').run).toContain('git rev-parse HEAD');
    for (const job of ['build-cloud-hypervisor', 'build-nvx', 'regression-copilot', 'regression-non-copilot']) {
      expect(step(job, 'Checkout main').with).toEqual({
        ref: 'main',
        'persist-credentials': false,
      });
      expect(step(job, 'Pin build source commit').run).toContain('git fetch --no-tags origin "$SOURCE_SHA"');
      expect(step(job, 'Pin build source commit').run).toContain('git checkout --detach FETCH_HEAD');
    }
    for (const job of ['regression-copilot', 'regression-non-copilot']) {
      const restore = step(job, 'Load the shared CLI and images').run;
      expect(restore).toContain('sha256sum --check SHA256SUMS');
      expect(restore).toContain('test "$(cat "$output/source-sha.txt")" = "$SOURCE_SHA"');
      expect(restore).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    }
  });

  it('builds the CLI and AWF images once, without rebuilding or pulling in the fan-out', () => {
    expect(step('build', 'Build AWF').run).toContain('npm run build');
    const build = step('build', 'Build and package shared images and CLI').run;
    expect(build).toContain('for image in squid agent api-proxy; do');
    expect(build).toContain('docker save "${images[@]}"');
    expect(build).toContain('tar -czf "$output/awf.tar.gz" dist node_modules');
    for (const job of ['regression-copilot', 'regression-non-copilot']) {
      const fanout = workflow.jobs[job].steps.map(entry => entry.run ?? '').join('\n');
      expect(fanout).toContain('docker load');
      expect(fanout).not.toMatch(/docker (build|pull)|npm (ci|run build)/);
    }
    const runner = fs.readFileSync(hostScript, 'utf8');
    expect(runner).toContain('--image-registry awf-regression --image-tag "$SOURCE_SHA" --skip-pull');
    expect(runner).not.toContain('--build-local');
    expect(step('regression-copilot', 'Download shared AWF build').with?.name)
      .toBe(step('build', 'Upload shared AWF build').with?.name);
  });

  it('builds the Cloud Hypervisor guest from source and shares one pinned NVX guest', () => {
    const build = step('build-cloud-hypervisor', 'Build and verify guest artifacts').run;
    expect(step('build', 'Build and package shared images and CLI').run)
      .toContain('docker build --tag awf-regression/build-tools:local containers/build-tools');
    expect(build).toContain('BUILD_TOOLS_IMAGE=awf-regression/build-tools:local');
    expect(build).not.toContain('docker build --tag awf-regression/build-tools:local');
    expect(build).toContain('bash guest/cloud-hypervisor/build-test-artifacts.sh');
    expect(build).toContain('bash guest/cloud-hypervisor/verify-test-artifacts.sh');
    expect(step('build-cloud-hypervisor', 'Name shared manifests for runtime validation').run)
      .toContain('cp "$output/enclave-manifest.json"');
    const builder = fs.readFileSync(path.join(root, 'guest/cloud-hypervisor/build-test-artifacts.sh'), 'utf8');
    const checksumBlock = builder.match(/\n  sha256sum \\\n([\s\S]*?)\s+> SHA256SUMS/);
    if (!checksumBlock) throw new Error('Missing Cloud Hypervisor checksum list');
    const uploaded = step('build-cloud-hypervisor', 'Upload shared guest artifacts').with?.path;
    for (const line of checksumBlock[1].trim().split('\n')) {
      const file = line.trim().replace(/\\$/, '').trim();
      expect(uploaded).toContain(`release/cloud-hypervisor-test-x86_64/${file}\n`);
    }
    const nvx = step('build-nvx', 'Build shared NVX guest distro with all three agents');
    expect(nvx.run).toContain('"@github/copilot@$1" "@openai/codex@$2" "@anthropic-ai/claude-code@$3"');
    expect(nvx.run).toContain('"$COPILOT_VERSION" "$CODEX_VERSION" "$CLAUDE_VERSION"');
    expect(workflow.env).toEqual({
      COPILOT_VERSION: '1.0.90',
      CODEX_VERSION: '0.159.3',
      CLAUDE_VERSION: '2.1.280',
    });
    const prepare = fs.readFileSync(path.join(__dirname, 'prepare-agent-regression-nvx.sh'), 'utf8');
    for (const pin of [NVX_RELEASE_TAG, NVX_COMMIT, NVX_OPENVMM_COMMIT, NVX_AGENT_REGRESSION_SIGNER_WORKFLOW]) {
      expect(prepare).toContain(pin);
    }
    expect(prepare).toContain('sha256sum --check --status');
    expect(prepare).toContain('--arg commit "$(git rev-parse HEAD)"');
    expect(step('build-nvx', 'Attest NVX manifest').uses)
      .toMatch(/^actions\/attest-build-provenance@[a-f0-9]{40}$/);
    expect(workflow.jobs.build.permissions?.['attestations']).toBeUndefined();
    expect(workflow.jobs['build-nvx'].permissions?.attestations).toBe('write');
  });

  it('keeps credential scope and evidence separate from build artifacts', () => {
    expect(workflow.jobs['regression-copilot'].permissions).toEqual({
      contents: 'read',
      'copilot-requests': 'write',
    });
    expect(workflow.jobs['regression-non-copilot'].permissions).toEqual({
      contents: 'read',
    });
    for (const job of ['regression-copilot', 'regression-non-copilot']) {
      const run = step(job, 'Run real agent regression');
      expect(run.env?.COPILOT_GITHUB_TOKEN).toContain("matrix.agent == 'copilot'");
      expect(run.env?.OPENAI_API_KEY).toContain("matrix.agent == 'codex'");
      expect(run.env?.ANTHROPIC_API_KEY).toContain("matrix.agent == 'claude'");
      expect(run.run).toContain('host_script=$(<scripts/ci/run-agent-runtime-regression.sh)');
      expect(fs.readFileSync(guestScript, 'utf8'))
        .toContain('export PATH="$PWD/.awf-regression/tools/node_modules/.bin:$PATH"');
      expect(run.run).toContain('bash -c "$host_script"');
      expect(step(job, 'Upload regression evidence').if).toBe('always()');
      expect(step(job, 'Upload regression evidence').with?.path)
        .toBe('${{ runner.temp }}/agent-runtime-evidence-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.agent }}-${{ matrix.runtime }}/');
      expect(step(job, 'Upload regression evidence').with?.['retention-days']).toBe(7);
    }
    expect(fs.readFileSync(hostScript, 'utf8')).not.toContain('--env-all');
  });
});

// These fixtures execute the real shell harness, replacing only network,
// privilege, and inference boundaries. They do not start Docker or a VM.
describe('agent regression harness', () => {
  let directory: string;
  let tools: string;
  let environment: NodeJS.ProcessEnv;

  function writeTool(name: string, source: string): void {
    fs.writeFileSync(path.join(tools, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-regression-'));
    tools = path.join(directory, 'tools');
    fs.mkdirSync(tools);
    fs.mkdirSync(path.join(directory, 'runner-temp'));
    fs.mkdirSync(path.join(directory, 'scripts/ci'), { recursive: true });
    fs.copyFileSync(guestScript, path.join(directory, 'scripts/ci/run-agent-regression-guest.sh'));
    fs.copyFileSync(path.join(__dirname, 'collect-agent-regression-evidence.cjs'),
      path.join(directory, 'scripts/ci/collect-agent-regression-evidence.cjs'));
    fs.mkdirSync(path.join(directory, 'dist/constants'), { recursive: true });
    fs.copyFileSync(path.join(root, 'dist/constants/placeholders.js'),
      path.join(directory, 'dist/constants/placeholders.js'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{}');
    environment = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      GITHUB_WORKSPACE: directory,
      RUNNER_TEMP: path.join(directory, 'runner-temp'),
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
      SOURCE_SHA: 'a'.repeat(40),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
      COPILOT_TOKEN: '',
      COPILOT_PROVIDER_API_KEY: '',
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      TEST_ROOT: directory,
    };
    writeTool('curl', `
      const allowed = process.argv.includes('https://github.com');
      process.stdout.write(allowed ? (process.env.ALLOWED_CODE || '200') : (process.env.BLOCKED_CODE || '000'));
      process.exit(allowed ? 0 : (process.env.BLOCKED_CODE ? 0 : 56));
    `);
    for (const agent of agents) {
      writeTool(agent, `
        const fs = require('fs');
        const args = process.argv.slice(2);
        if (args.includes('--version')) { console.log('pinned-test-version'); process.exit(0); }
        fs.writeFileSync(process.env.TEST_ROOT + '/agent-args.json', JSON.stringify(args));
        if (process.env.AGENT_MODE === 'exit') process.exit(42);
        const prompt = args.find(arg => arg.startsWith('Use your shell tool'));
        const match = prompt.match(/write exactly '([^']+)' followed by a newline to '([^']+)'/);
        if (!match) throw new Error('Missing tool-use prompt');
        const [, marker, proof] = match;
        if (process.env.AGENT_MODE !== 'no-proof') {
          fs.writeFileSync(proof, process.env.AGENT_MODE === 'wrong-proof' ? 'wrong' : marker + '\\n');
        }
        const response = process.env.AGENT_MODE === 'wrong-response' ? 'PASS' : marker;
        if (args.includes('--output-last-message')) {
          fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], response + '\\n');
        } else {
          console.log(response);
        }
        process.stderr.write(process.env.AGENT_TERMINAL_OUTPUT || '');
      `);
    }
    writeTool('sudo', `
      const { spawnSync } = require('child_process');
      const args = process.argv.slice(2);
      if (!args[0].startsWith('--preserve-env=')) process.exit(0);
      args.shift();
      const result = spawnSync(args.shift(), args, { env: process.env, stdio: 'inherit' });
      process.exit(result.status ?? 1);
    `);
    writeTool('node', `
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      const args = process.argv.slice(2);
      if (args.length === 0 || args[0] === '-e') {
        const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'inherit' });
        process.exit(result.status ?? 1);
      }
      fs.writeFileSync(process.env.TEST_ROOT + '/awf-args.json', JSON.stringify(args));
      const delimiter = args.indexOf('--');
      const command = args[delimiter + 1];
      const guestArgs = args.slice(delimiter + 2).map(arg =>
        arg.replace(/^\\/workspace(?=\\/|$)/, process.env.TEST_ROOT)
      );
      const env = {
        ...process.env,
        COPILOT_GITHUB_TOKEN: '',
        COPILOT_TOKEN: '',
        COPILOT_PROVIDER_API_KEY: '',
        ...require(${JSON.stringify(path.join(root, 'dist/services/credentials/copilot-credential-env.js'))})
          .buildCopilotCredentialEnv({
            config: { copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN },
            proxyIp: '172.30.0.30',
          }),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'sk-placeholder-for-api-proxy' : '',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY ? 'sk-ant-placeholder-key-for-credential-isolation' : '',
      };
      const result = spawnSync(command, guestArgs, {
        cwd: process.env.TEST_ROOT, env, stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = result.stdout.toString();
      if (process.env.COMPLETION_OUTPUT !== undefined) {
        output = output.replace('AWF-REGRESSION-COMPLETE', process.env.COMPLETION_OUTPUT);
      }
      process.stdout.write(output);
      for (const [variable, file] of [['HOST_PROOF', 'agent-proof.txt'], ['HOST_RESPONSE', 'response.txt']]) {
        if (process.env[variable] !== undefined) {
          fs.writeFileSync(process.env.TEST_ROOT + '/.awf-regression/results/' + file, process.env[variable]);
        }
      }
      process.exit(Number(process.env.AWF_EXIT_CODE ?? result.status ?? 1));
    `);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function runGuest(agent: string, overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [
      guestScript, agent, `AWF-REGRESSION-${agent}-test-123-1`,
    ], { cwd: directory, env: { ...environment, ...overrides }, encoding: 'utf8' });
  }

  function runHost(overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [hostScript], {
      cwd: directory,
      env: {
        ...environment, AGENT: 'claude', RUNTIME: 'nvx',
        ANTHROPIC_API_KEY: 'test-only-credential', ...overrides,
      },
      encoding: 'utf8',
    });
  }

  it.each(agents)('requires real inference and a tool-written proof for %s', agent => {
    const result = runGuest(agent);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AWF-REGRESSION-COMPLETE');
    const args = JSON.parse(fs.readFileSync(path.join(directory, 'agent-args.json'), 'utf8')) as string[];
    expect(args).toContain(agent === 'copilot' ? '--allow-all-tools' :
      agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions');
    expect(fs.readFileSync(path.join(directory, '.awf-regression/results/agent-proof.txt'), 'utf8'))
      .toBe(`AWF-REGRESSION-${agent}-test-123-1\n`);
  });

  it.each(agents.flatMap(agent => ['no-proof', 'wrong-proof', 'wrong-response', 'exit']
    .map(mode => [agent, mode])))('fails closed for %s with %s', (agent, mode) => {
    expect(runGuest(agent, { AGENT_MODE: mode }).status).not.toBe(0);
  });

  it.each(copilotCredentialNames.flatMap(name => [
    { name, kind: 'unset', value: undefined },
    { name, kind: 'empty', value: '' },
    { name, kind: 'canonical placeholder', value: COPILOT_PLACEHOLDER_TOKEN },
  ]))('accepts $kind for $name', ({ name, value }) => {
    const result = runGuest('copilot', { [name]: value });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('AWF-REGRESSION-COMPLETE\n');
    expect(fs.readFileSync(path.join(directory, '.awf-regression/results/agent-version.txt'), 'utf8'))
      .toBe('pinned-test-version\n');
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(true);
  });

  it.each(copilotCredentialNames.flatMap(name => [
    { name, kind: 'log-redacted text', value: '*'.repeat(6) },
    { name, kind: 'arbitrary text', value: 'unexpected-token' },
    { name, kind: 'token-shaped text', value: `ghu_${'X'.repeat(36)}` },
    { name, kind: 'placeholder prefix', value: `${COPILOT_PLACEHOLDER_TOKEN}x` },
    { name, kind: 'leading whitespace', value: ` ${COPILOT_PLACEHOLDER_TOKEN}` },
    { name, kind: 'trailing newline', value: `${COPILOT_PLACEHOLDER_TOKEN}\n` },
  ]))('rejects $kind for $name without logging it', ({ name, value }) => {
    const result = runGuest('copilot', { [name]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Copilot credential is not isolated\n');
    expect(result.stdout).toBe('');
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(false);
    expect(fs.existsSync(path.join(directory, '.awf-regression/results/agent-version.txt'))).toBe(false);
  });

  it('fails closed when the canonical placeholder module is unavailable', () => {
    fs.rmSync(path.join(directory, 'dist/constants/placeholders.js'));
    const result = runGuest('copilot', { COPILOT_GITHUB_TOKEN: COPILOT_PLACEHOLDER_TOKEN });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Copilot placeholder contract is unavailable\n');
    expect(result.stdout).not.toContain('AWF-REGRESSION-COMPLETE');
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(false);
  });

  it('fails closed when the canonical placeholder value is unavailable', () => {
    fs.writeFileSync(
      path.join(directory, 'dist/constants/placeholders.js'),
      "module.exports = { COPILOT_PLACEHOLDER_TOKEN: '' };\n",
    );
    const result = runGuest('copilot', { COPILOT_GITHUB_TOKEN: COPILOT_PLACEHOLDER_TOKEN });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Copilot placeholder contract is unavailable\n');
    expect(result.stdout).not.toContain('AWF-REGRESSION-COMPLETE');
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(false);
  });

  it.each([
    { ALLOWED_CODE: '500' },
    { BLOCKED_CODE: '200' },
    { GH_TOKEN: 'unexpected-token' },
    { COPILOT_GITHUB_TOKEN: 'unexpected-token' },
    { OPENAI_API_KEY: 'unexpected-key' },
    { CODEX_API_KEY: 'unexpected-key' },
    { ANTHROPIC_API_KEY: 'unexpected-key' },
    { ANTHROPIC_AUTH_TOKEN: 'unexpected-token' },
  ])('rejects broken network or credential isolation: %j', overrides => {
    expect(runGuest('copilot', overrides).status).not.toBe(0);
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(false);
  });

  function runHost(agent: string, runtime: string, overrides: NodeJS.ProcessEnv = {}) {
    const artifacts = path.join(environment.RUNNER_TEMP!, `agent-runtime-${runtime}`);
    fs.mkdirSync(artifacts);
    if (runtime === 'cloud-hypervisor') {
      const files = ['cloud-hypervisor', 'virtiofsd', 'vmlinux.bin', 'kernel.config', 'rootfs.ext4', 'awf-supervisor'];
      const sums = files.map(file => {
       fs.writeFileSync(path.join(artifacts, file), 'test-artifact');
       return `${createHash('sha256').update('test-artifact').digest('hex')}  ${file}`;
      });
      fs.writeFileSync(path.join(artifacts, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    }
    const credential = agent === 'copilot' ? 'COPILOT_GITHUB_TOKEN' :
      agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return spawnSync('bash', [hostScript], {
      cwd: directory,
      env: { ...environment, AGENT: agent, RUNTIME: runtime, [credential]: 'test-only-credential', ...overrides },
      encoding: 'utf8',
    });
  }

  it.each(agents.flatMap(agent => runtimes.map(runtime => [agent, runtime])))(
    'wires the shared AWF build to the %s / %s runtime',
    (agent, runtime) => {
      const result = runHost(agent, runtime);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const args = JSON.parse(fs.readFileSync(path.join(directory, 'awf-args.json'), 'utf8')) as string[];
      expect(args).toContain('--skip-pull');
      expect(args[args.indexOf('--image-tag') + 1]).toBe(environment.SOURCE_SHA);
      if (runtime === 'docker') {
        expect(args).not.toContain('--container-runtime');
      } else {
        expect(args[args.indexOf('--container-runtime') + 1]).toBe(runtime);
      }
      if (runtime === 'nvx') {
        expect(args[args.indexOf('--nvx-signer-workflow') + 1]).toBe(NVX_AGENT_REGRESSION_SIGNER_WORKFLOW);
        expect(args).toContain('--nvx-artifact-manifest-bundle');
      }
      if (runtime === 'cloud-hypervisor') {
        for (const artifact of ['binary', 'virtiofsd', 'kernel', 'rootfs', 'supervisor']) {
          expect(args).toContain(`--cloud-hypervisor-${artifact}-sha256`);
        }
      }
      expect(fs.readFileSync(path.join(directory, 'summary.md'), 'utf8'))
        .toContain(`${agent} / ${runtime}: PASS`);
      const staged = path.join(environment.RUNNER_TEMP!, `agent-runtime-evidence-123-1-${agent}-${runtime}`);
      expect(fs.readdirSync(staged).sort()).toEqual([
        'agent-proof.txt', 'agent-version.txt', 'response.txt', 'source-sha.txt',
      ]);
      expect(fs.readFileSync(path.join(staged, 'agent-proof.txt'), 'utf8'))
        .toBe(`AWF-REGRESSION-${agent}-${runtime}-123-1\n`);
      expect(fs.readFileSync(path.join(staged, 'agent-version.txt'), 'utf8'))
        .toBe('pinned-test-version\n');
      expect(fs.readFileSync(path.join(staged, 'response.txt'), 'utf8'))
        .toBe(`AWF-REGRESSION-${agent}-${runtime}-123-1\n`);
      expect(fs.readFileSync(path.join(staged, 'source-sha.txt'), 'utf8')).toBe(`${environment.SOURCE_SHA}\n`);
    },
  );

  it.each(['docker', 'nvx'])('keeps completion on its own line after cursor-show output in claude / %s', runtime => {
    const result = runHost({ RUNTIME: runtime, AGENT_TERMINAL_OUTPUT: '\u001b[?25h' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('\u001b[?25h\nAWF-REGRESSION-COMPLETE\n');
    const staged = path.join(environment.RUNNER_TEMP!, `agent-runtime-evidence-123-1-claude-${runtime}`);
    for (const file of ['agent-proof.txt', 'response.txt']) {
      expect(fs.readFileSync(path.join(staged, file), 'utf8'))
        .toBe(`AWF-REGRESSION-claude-${runtime}-123-1\n`);
    }
    expect(fs.readFileSync(path.join(directory, 'summary.md'), 'utf8'))
      .toContain(`claude / ${runtime}: PASS`);
  });

  it.each([
    '',
    'AWF-REGRESSION-COMPLET',
    'AWF-REGRESSION-\nCOMPLETE',
    '"AWF-REGRESSION-COMPLETE"',
    'claimed AWF-REGRESSION-COMPLETE',
    'AWF-REGRESSION-COMPLETE extra',
    ' AWF-REGRESSION-COMPLETE',
    'AWF-REGRESSION-COMPLETE ',
    '\u001b[?25hquoted AWF-REGRESSION-COMPLETE',
  ])('rejects invalid host completion output %j even with valid proof and response', output => {
    const result = runHost({ COMPLETION_OUTPUT: output });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Missing exact inference response or guest completion marker');
    expect(fs.existsSync(path.join(directory, 'summary.md'))).toBe(false);
  });

  it.each(['HOST_PROOF', 'HOST_RESPONSE'].flatMap(variable =>
    ['', 'AWF-REGRESSION-claude-nvx-123', 'quoted AWF-REGRESSION-claude-nvx-123-1',
      'AWF-REGRESSION-claude-nvx-123-1 extra', '\u001b[?25hAWF-REGRESSION-claude-nvx-123-1']
      .map(value => [variable, value]),
  ))('retains exact host evidence requirements for %s: %j', (variable, value) => {
    const result = runHost({ [variable]: value, AGENT_TERMINAL_OUTPUT: '\u001b[?25h' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(variable === 'HOST_PROOF' ?
      'Missing or incorrect agent-written workspace proof' :
      'Missing exact inference response or guest completion marker');
    expect(fs.existsSync(path.join(directory, 'summary.md'))).toBe(false);
  });

  it('rejects a nonzero command exit even with exact evidence and a genuine completion marker', () => {
    const result = runHost({ AWF_EXIT_CODE: '42', AGENT_TERMINAL_OUTPUT: '\u001b[?25h' });
    expect(result.status).toBe(42);
    expect(result.stdout).toContain('\u001b[?25h\nAWF-REGRESSION-COMPLETE\n');
    expect(result.stdout).toContain('failed with exit code 42');
    expect(fs.existsSync(path.join(directory, 'summary.md'))).toBe(false);
  });

  it('fails rather than skipping a cell with a missing credential', () => {
    const result = spawnSync('bash', [hostScript], {
      cwd: directory, env: { ...environment, AGENT: 'codex', RUNTIME: 'docker' }, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Missing Codex credential');
    expect(fs.existsSync(path.join(directory, 'awf-args.json'))).toBe(false);
  });

  it.each(runtimes.flatMap(runtime => ['exit', 'no-proof', 'wrong-proof', 'wrong-response']
    .map(mode => [runtime, mode])))('propagates %s inference failure %s through AWF and logging', (runtime, mode) => {
    const result = runHost('copilot', runtime, { AGENT_MODE: mode });
    const status = mode === 'exit' ? 42 : 1;
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(`failed with exit code ${status}`);
    expect(result.stdout).not.toContain('AWF-REGRESSION-COMPLETE');
    expect(fs.readFileSync(path.join(directory, '.awf-regression/results/agent-version.txt'), 'utf8'))
      .toBe('pinned-test-version\n');
    expect(fs.existsSync(path.join(directory, 'agent-args.json'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'summary.md'))).toBe(false);
  });
});
