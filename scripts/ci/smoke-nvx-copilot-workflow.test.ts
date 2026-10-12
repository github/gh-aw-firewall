import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

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
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "NVX-COPILOT-PROOF\\n"\n', { mode: 0o755 });
    script = guestScript.split('/workspace').join(workspace)
      .replace('/tmp/copilot-home', path.join(root, 'copilot-home'));
    env = {
      PATH: process.env.PATH,
      AWF_NVX_SMOKE_MARKER: 'test-marker',
      HTTPS_PROXY: 'http://172.30.0.10:3128',
      COPILOT_OFFLINE: 'true',
      COPILOT_API_URL: 'http://172.30.0.30:10002',
      COPILOT_PROVIDER_BASE_URL: 'http://172.30.0.30:10002',
      COPILOT_TOKEN: '******',
      COPILOT_PROVIDER_API_KEY: '******',
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
    ['COPILOT_PROVIDER_API_KEY', 'unexpected-value'],
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

  it.each([
    ['nonzero usage', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'PASS'],
    ['zero usage', '{"event":"token_usage","input_tokens":0,"output_tokens":0}\n', 'FAIL'],
    ['empty usage', '', 'FAIL'],
    ['unrelated events', '{"event":"other","input_tokens":10}\n', 'FAIL'],
    ['malformed usage', 'not-json\n', 'FAIL'],
    ['missing usage', undefined, 'FAIL'],
    ['missing nested proof', '{"event":"token_usage","input_tokens":10,"output_tokens":1}\n', 'FAIL'],
  ])('requires a nested response and %s in host evidence', (name, usage, status) => {
    expect(runGuest().status).toBe(0);
    if (name === 'missing nested proof') fs.unlinkSync(path.join(workspace, 'nvx-smoke-copilot-proof.txt'));
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
  });
});
