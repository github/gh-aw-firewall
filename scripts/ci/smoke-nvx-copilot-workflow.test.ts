import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../src/constants/placeholders';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'smoke-nvx-copilot.md'), 'utf8');
const frontmatter = yaml.load(source.split('---')[1]) as {
  steps: Array<{ name: string; run?: string }>;
  'post-steps': Array<{ name: string; run?: string }>;
};
const layerStep = frontmatter.steps.find(step => step.name.startsWith('Build the guest distro layer'))!;
const guestScript = layerStep.run!.split("<<'EOF'\n")[1].split('\nEOF')[0];
const lock = yaml.load(fs.readFileSync(path.join(workflowsDir, 'smoke-nvx-copilot.lock.yml'), 'utf8')) as {
  jobs: { agent: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } };
};

describe('Smoke NVX Copilot nested authentication', () => {
  it('inherits only the AWF placeholder and fixed Copilot API proxy route', () => {
    expect(guestScript).toContain(`test "\${COPILOT_TOKEN:-}" = '${COPILOT_PLACEHOLDER_TOKEN}'`);
    expect(guestScript).toContain(`test "\${COPILOT_PROVIDER_API_KEY:-}" = '${COPILOT_PLACEHOLDER_TOKEN}'`);
    expect(guestScript).toContain('test "${COPILOT_API_KEY:-}" = dummy-byok-key-for-offline-mode');
    expect(guestScript).toContain('test "${COPILOT_API_URL:-}" = http://172.30.0.30:10002');
    expect(guestScript).toContain('test "${COPILOT_PROVIDER_BASE_URL:-}" = "$COPILOT_API_URL"');
    expect(guestScript).toContain('test "${COPILOT_OFFLINE:-}" = true');
    expect(guestScript).not.toMatch(/^\s*COPILOT_(?:GITHUB_TOKEN|TOKEN|PROVIDER_API_KEY|API_KEY|API_URL|PROVIDER_BASE_URL|OFFLINE)=/m);
    expect(guestScript).not.toContain('$GH_TOKEN');
    expect(guestScript).not.toContain('$GITHUB_TOKEN');
    expect(guestScript).not.toContain('${{');
  });

  it('keeps real GitHub and provider credentials forbidden in the nested guest', () => {
    expect(guestScript).toContain(
      "env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='",
    );
    expect(guestScript).toContain('real credential value reached the NVX guest via COPILOT_GITHUB_TOKEN');
    expect(guestScript).toContain(`test "\${COPILOT_PROVIDER_API_KEY:-}" = '${COPILOT_PLACEHOLDER_TOKEN}'`);
    expect(guestScript).toContain('test "${COPILOT_API_KEY:-}" = dummy-byok-key-for-offline-mode');
  });

  it('keeps the compiled workflow aligned with the nested auth boundary', () => {
    const compiledScript = lock.jobs.agent.steps.find(step => step.name === layerStep.name)?.run;
    expect(compiledScript).toBe(layerStep.run);
    expect(compiledScript).toContain(COPILOT_PLACEHOLDER_TOKEN);
  });
});

describe('NVX Copilot smoke compiler contract', () => {
  it('reuses the compiler-staged musl binary without an independent package pin', () => {
    const compiledSteps = lock.jobs.agent.steps;
    expect(compiledSteps.find(step => step.name === layerStep.name)?.run).toBe(layerStep.run);
    expect(compiledSteps.find(step => step.name === 'Install GitHub Copilot CLI')?.env)
      .toMatchObject({ GH_AW_COPILOT_GUEST_LIBC: 'musl' });
    expect(compiledSteps.find(step => step.name === 'Execute GitHub Copilot CLI')?.run)
      .toContain('"/workspace/.gh-aw-nvx/gh-aw/bin/copilot"');
    expect(guestScript).toContain('copilot_bin=/workspace/.gh-aw-nvx/gh-aw/bin/copilot');
    expect(guestScript).toContain('"$copilot_bin" \\');
    expect(layerStep.run).not.toContain('npm pack');
    expect(source).not.toMatch(/COPILOT_(VERSION|PACKAGE|ARCHIVE)/);
    expect(guestScript).not.toContain('/usr/local/bin/copilot');
  });

  it('retains attestation, isolation, safe outputs, evidence, and scoped KVM cleanup', () => {
    for (const control of [
      'network-isolation: true', 'api-proxy: true', 'mount-policy: workspace-only',
      'artifact-manifest-bundle-path:', 'signer-workflow:', 'Attest the pinned NVX artifact manifest',
      'Upload NVX smoke evidence', 'Validate safe outputs were invoked',
    ]) expect(source).toContain(control);
    const compiled = fs.readFileSync(path.join(workflowsDir, 'smoke-nvx-copilot.lock.yml'), 'utf8');
    expect(compiled).toContain('GH_AW_NVX_KVM_ACL_PERMISSIONS');
    expect(compiled).toContain('"$setfacl_bin" -x "u:${acl_uid}" /dev/kvm');
    expect(compiled).toContain('Remove staged NVX artifacts');
  });

  let root: string;
  let workspace: string;
  let binary: string;
  let script: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-copilot-smoke-'));
    workspace = path.join(root, 'workspace');
    binary = path.join(workspace, '.gh-aw-nvx/gh-aw/bin/copilot');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    fs.writeFileSync(binary, `#!/bin/sh
mkdir -p "$COPILOT_HOME/session-state/nested"
printf '%s\\n' '{"type":"session.shutdown","data":{"modelMetrics":{"test-model":{"usage":{"inputTokens":10,"outputTokens":1}}}}}' > "$COPILOT_HOME/session-state/nested/events.jsonl"
printf "NVX-COPILOT-PROOF\\n"
`, { mode: 0o755 });
    script = guestScript.split('/workspace').join(workspace)
      .replace('/tmp/copilot-home', path.join(root, 'copilot-home'));
    env = {
      PATH: process.env.PATH,
      AWF_NVX_SMOKE_MARKER: 'test-marker',
      HTTPS_PROXY: 'http://172.30.0.10:3128',
      COPILOT_OFFLINE: 'true',
      COPILOT_API_URL: 'http://172.30.0.30:10002',
      COPILOT_PROVIDER_BASE_URL: 'http://172.30.0.30:10002',
      COPILOT_TOKEN: COPILOT_PLACEHOLDER_TOKEN,
      COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN,
      COPILOT_GITHUB_TOKEN: COPILOT_PLACEHOLDER_TOKEN,
      COPILOT_API_KEY: 'dummy-byok-key-for-offline-mode',
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const runGuest = () => spawnSync('/bin/sh', ['-c', script], {
    cwd: workspace, env, encoding: 'utf8', timeout: 5000,
  });

  it('runs with only the inherited offline proxy environment and a writable HOME', () => {
    const result = runGuest();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AWF-NVX-SMOKE-COMPLETE');
    expect(fs.readFileSync(path.join(workspace, 'nvx-smoke-copilot-proof.txt'), 'utf8'))
      .toContain('NVX-COPILOT-PROOF');
    expect(fs.statSync(path.join(root, 'copilot-home')).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['COPILOT_OFFLINE', undefined],
    ['COPILOT_API_URL', 'https://api.githubcopilot.com'],
    ['COPILOT_PROVIDER_BASE_URL', 'https://api.githubcopilot.com'],
    ['COPILOT_TOKEN', 'unexpected-value'],
    ['COPILOT_TOKEN', '******'],
    ['COPILOT_PROVIDER_API_KEY', 'unexpected-value'],
    ['COPILOT_PROVIDER_API_KEY', '******'],
    ['COPILOT_API_KEY', 'unexpected-value'],
    ['COPILOT_GITHUB_TOKEN', 'unexpected-value'],
    ['GH_TOKEN', 'unexpected-value'],
    ['GITHUB_TOKEN', 'unexpected-value'],
    ['OPENAI_API_KEY', 'unexpected-value'],
    ['ANTHROPIC_API_KEY', 'unexpected-value'],
  ])('fails closed for invalid %s', (name, value) => {
    env[name!] = value;
    expect(runGuest().status).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, 'nvx-smoke-complete.txt'))).toBe(false);
  });

  it.each(['missing', 'non-executable', 'symlink'])('rejects a %s compiler binary', state => {
    if (state === 'non-executable') fs.chmodSync(binary, 0o644);
    else {
      fs.renameSync(binary, `${binary}.original`);
      if (state === 'symlink') fs.symlinkSync(`${binary}.original`, binary);
    }
    expect(runGuest().status).not.toBe(0);
  });

  it('fails if the nested CLI does not persist its own session', () => {
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "NVX-COPILOT-PROOF\\n"\n');
    expect(runGuest().status).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, 'nvx-smoke-complete.txt'))).toBe(false);
  });

  it.each([
    ['nonzero usage', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'PASS'],
    ['zero usage', '{"event":"token_usage","input_tokens":0,"output_tokens":0}\n', 'FAIL'],
    ['empty usage', '', 'FAIL'],
    ['unrelated events', '{"event":"other","input_tokens":10}\n', 'FAIL'],
    ['malformed usage', 'not-json\n', 'FAIL'],
    ['missing usage', undefined, 'FAIL'],
    ['missing nested proof', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'FAIL'],
    ['zero nested usage', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'FAIL'],
    ['missing nested usage', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'FAIL'],
  ])('requires a nested response and %s in host evidence', (name, usage, status) => {
    expect(runGuest().status).toBe(0);
    if (name === 'missing nested proof') fs.unlinkSync(path.join(workspace, 'nvx-smoke-copilot-proof.txt'));
    const eventsFile = path.join(workspace, 'nvx-smoke-copilot-events.jsonl');
    if (name === 'zero nested usage') {
      fs.writeFileSync(eventsFile, '{"type":"session.shutdown","data":{"modelMetrics":{}}}\n');
    }
    if (name === 'missing nested usage') fs.unlinkSync(eventsFile);
    const dataDir = path.join(root, 'evidence');
    const usageFile = path.join(root, 'token-usage.jsonl');
    if (usage !== undefined) fs.writeFileSync(usageFile, usage);
    const collect = frontmatter['post-steps']
      .find(step => step.name === 'Collect declarative NVX smoke evidence')!.run!
      .split('/tmp/gh-aw/agent/smoke-nvx-copilot').join(dataDir)
      .replace('sudo chown -R "$(id -u):$(id -g)" "$data_dir"', ':');
    const result = spawnSync('/bin/bash', ['-c', collect], {
      cwd: workspace,
      env: { ...env, GITHUB_WORKSPACE: workspace, AWF_TOKEN_USAGE_LOG: usageFile, AGENT_OUTCOME: 'success' },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    const scenarios = fs.readFileSync(path.join(dataDir, 'scenarios.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { check: string; status: string });
    expect(scenarios).toHaveLength(4);
    expect(scenarios.find(scenario => scenario.check === 'copilot-inference')?.status).toBe(status);
    expect(fs.existsSync(path.join(workspace, 'nvx-smoke-copilot-proof.txt'))).toBe(false);
    expect(fs.existsSync(eventsFile)).toBe(false);
    if (status === 'PASS') {
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'copilot-token-usage.json'), 'utf8')))
        .toEqual({ input_tokens: 10, output_tokens: 1 });
    }
  });
});
