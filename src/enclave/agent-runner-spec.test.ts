import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const containersRoot = path.join(__dirname, '..', '..', 'containers');
const {
  deriveEnclaveContainerSpec,
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_RUN_LABEL,
  ENCLAVE_MAX_FILE_BYTES,
} = require(path.join(containersRoot, 'enclave', 'agent-executor', 'enclave-runner-spec.js'));
const { createEnclaveRunner } = require(path.join(
  containersRoot,
  'enclave',
  'agent-executor',
  'enclave-runner.js',
));
const { loadAgentConfig, loadServerConfig } = require(path.join(
  containersRoot,
  'enclave',
  'mcp-server',
  'config.js',
));
const { mintGithubCapability } = require(path.join(
  containersRoot,
  'enclave',
  'agent-executor',
  'github-capability.js',
));
const { agentWorkspaceAdapter } = require(path.join(
  containersRoot,
  'enclave',
  'mcp-server',
  'agent-executor.js',
));
/* eslint-enable @typescript-eslint/no-require-imports */

const trustedConfig = {
  hostWorkDir: '/daemon/private/enclave/work',
  hostSeedsDir: '/daemon/private/enclave/seeds',
  enclaveMountDir: '/agent',
  enclaveSeedPath: '/awf/seed',
  enclaveTaskPath: '/awf/task.txt',
  enclaveSchemaPath: '/awf/schema.json',
  enclaveSeccompPath: '/opt/awf/enclave-seccomp.json',
  enclaveImage: 'ghcr.io/github/awf/enclave-agent:pinned',
  enclaveUid: 65534,
  enclaveGid: 65534,
  enclaveHostname: 'enclave-agent',
  network: 'awf-enclave-agent',
  engine: 'copilot',
  profile: 'openai',
  model: 'trusted-model',
  apiEndpoint: 'http://172.31.0.30:10002',
  memoryLimit: '768m',
  tmpfsLimit: '96m',
  cpuLimit: '0.5',
  pidsLimit: 47,
  timeoutSeconds: 120,
  maxOutputBytes: 8192,
  runLabelKey: ENCLAVE_RUN_LABEL,
  invocationLabelKey: ENCLAVE_INVOCATION_LABEL,
  containerPrefix: 'awf-enclave-agent',
};

describe('unified enclave agent runner specification', () => {
  const spec = deriveEnclaveContainerSpec({
    config: trustedConfig,
    runId: 'abcdef1234567890',
    invocationId: '0123456789abcdef',
    seedId: 'b'.repeat(32),
  });

  it('uses unified enclave labels so one reconcile pass covers both executors', () => {
    expect(spec.containerName).toBe('awf-enclave-agent-abcdef123456-0123456789abcdef');
    expect(spec.launchArgs).toEqual(expect.arrayContaining([
      '--label', 'awf.enclave.run=abcdef1234567890',
      '--label', 'awf.enclave.invocation=0123456789abcdef',
    ]));
    expect(spec.runListArgs).toContain('label=awf.enclave.run=abcdef1234567890');
    expect(spec.invocationListArgs).toContain('label=awf.enclave.invocation=0123456789abcdef');
  });

  it('preserves every mandatory single-use isolation control', () => {
    expect(spec.launchArgs).toEqual(expect.arrayContaining([
      '--network', 'awf-enclave-agent',
      '--read-only',
      '--user', '65534:65534',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--security-opt', 'seccomp=/opt/awf/enclave-seccomp.json',
      '--memory', '768m',
      '--memory-swap', '768m',
      '--cpus', '0.5',
      '--pids-limit', '47',
      '--ulimit', `fsize=${ENCLAVE_MAX_FILE_BYTES}`,
      '--pull', 'never',
    ]));
    expect(spec.launchArgs).toContain('/tmp:rw,noexec,nosuid,nodev,size=96m');
    expect(spec.launchArgs).toContain(
      '/agent:rw,nosuid,nodev,size=96m,uid=65534,gid=65534,mode=0700',
    );
    expect(spec.launchArgs).toContain(`${trustedConfig.hostSeedsDir}/${'b'.repeat(32)}:/awf/seed:ro`);
    expect(spec.launchArgs).toContain(
      '/daemon/private/enclave/work/0123456789abcdef/out:/awf/out:rw',
    );
    expect(spec.launchArgs).toContain(
      '/daemon/private/enclave/work/0123456789abcdef/session.jsonl:/awf/session.jsonl:rw',
    );
    expect(spec.launchArgs).toContain('--entrypoint');
  });

  it('mounts only the invocation capability for issues-read-v1', () => {
    const githubSpec = deriveEnclaveContainerSpec({
      config: {
        ...trustedConfig,
        githubEnabled: true,
        githubProfile: 'issues-read-v1',
        githubProxyUrl: 'http://172.31.0.40:11000',
        enclaveGithubCapabilityPath: '/run/awf-enclave-github/capability',
      },
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      seedId: 'b'.repeat(32),
    });
    expect(githubSpec.launchArgs).toEqual(expect.arrayContaining([
      '--env', 'AWF_ENCLAVE_AGENT_GITHUB_PROFILE=issues-read-v1',
      '--env', 'AWF_ENCLAVE_AGENT_GITHUB_PROXY_URL=http://172.31.0.40:11000',
      '-v',
      '/daemon/private/enclave/work/0123456789abcdef/github-capability:' +
        '/run/awf-enclave-github/capability:ro',
    ]));
    expect(githubSpec.launchArgs.join(' ')).not.toMatch(/MCP_GATEWAY|githubCapabilityKey|GH_TOKEN/);
  });

  it('never accepts an invocation-supplied control', () => {
    const hostile = deriveEnclaveContainerSpec({
      config: trustedConfig,
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      seedId: 'b'.repeat(32),
      request: {
        image: 'attacker/image',
        network: 'host',
        memoryLimit: '99g',
        mounts: ['/etc:/host'],
        model: 'attacker-model',
      },
    });
    expect(hostile.launchArgs).toEqual(spec.launchArgs);
    expect(spec.launchArgs.join(' ')).not.toMatch(/attacker|99g|--network host|\/etc:\/host/);
  });

  it('rejects an untrusted OCI runtime name and never downgrades gVisor', () => {
    expect(() => deriveEnclaveContainerSpec({
      config: trustedConfig,
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      seedId: 'b'.repeat(32),
      runtimeName: 'kata',
    })).toThrow(/Unsupported OCI runtime/);
    expect(deriveEnclaveContainerSpec({
      config: trustedConfig,
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      seedId: 'b'.repeat(32),
      runtimeName: 'runsc',
    }).launchArgs).toEqual(expect.arrayContaining(['--runtime', 'runsc']));
  });

  it('fails closed for an unimplemented enclave backend', () => {
    expect(() => createEnclaveRunner({ ...trustedConfig, backend: 'unsupported' }))
      .toThrow(/Unsupported enclave-agent backend/);
  });

  it.each([
    'false|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,',
    'true|bridge|172.29.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,',
    'true|overlay|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,',
    'true|bridge|172.31.0.0/24,|unexpected@172.31.0.40/24,',
    'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,unexpected@172.31.0.40/24,',
  ])('rejects a non-isolated dedicated network topology (%s)', async (networkTopology) => {
    const runner = createEnclaveRunner(
      { ...trustedConfig, backend: 'docker' },
      {
        docker: {
          runDocker: async (args: string[]) => ({
            exitCode: 0,
            timedOut: false,
            stdout: args[0] === 'network' ? networkTopology : '[]',
            stderr: '',
          }),
        },
      },
    );
    await expect(runner.assertAvailable()).rejects.toThrow(/unavailable or not isolated/);
  });

  it('accepts only the internal bridge network with the enclave subnet', async () => {
    const runner = createEnclaveRunner(
      { ...trustedConfig, backend: 'docker' },
      {
        docker: {
          runDocker: async (args: string[]) => ({
            exitCode: 0,
            timedOut: false,
            stdout: args[0] === 'network'
              ? 'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,'
              : '[]',
            stderr: '',
          }),
        },
      },
    );
    await expect(runner.assertAvailable()).resolves.toBeUndefined();
  });

  it('requires the PAT-free CLI proxy as the second steady-state peer when enabled', async () => {
    const runner = createEnclaveRunner(
      { ...trustedConfig, backend: 'docker', githubEnabled: true },
      {
        docker: {
          runDocker: async (args: string[]) => ({
            exitCode: 0,
            timedOut: false,
            stdout: args[0] === 'network'
              ? 'true|bridge|172.31.0.0/24,|' +
                'awf-enclave-agent-api-proxy@172.31.0.30/24,' +
                'awf-enclave-agent-cli-proxy@172.31.0.40/24,'
              : '[]',
            stderr: '',
          }),
        },
      },
    );
    await expect(runner.assertAvailable()).resolves.toBeUndefined();
  });

  it('revalidates exact network membership immediately before every launch', async () => {
    const calls: string[][] = [];
    const runner = createEnclaveRunner(
      { ...trustedConfig, backend: 'docker' },
      {
        docker: {
          runDocker: async (args: string[]) => {
            calls.push(args);
            return {
              exitCode: 0,
              timedOut: false,
              stdout: args[0] === 'network'
                ? 'true|bridge|172.31.0.0/24,|unexpected@172.31.0.40/24,'
                : '',
              stderr: '',
            };
          },
        },
      },
    );
    await expect(runner.runEnclaveContainer({
      runId: 'abcdef1234567890',
      invocationId: '0123456789abcdef',
      seedId: 'b'.repeat(32),
    })).rejects.toThrow(/unavailable or not isolated/);
    expect(calls.some((args) => args[0] === 'run')).toBe(false);
  });

  describe('issues-read-v1 capability serialization', () => {
    it('matches the canonical mcpg v1 vector byte for byte', () => {
      expect(mintGithubCapability({
        keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        runId: 'run-123',
        invocationId: 'inv-456',
        repo: 'octo/private',
        notBefore: 1787594400,
        expiresAt: 1787594520,
      })).toBe(
        'awf-egh1.' +
        'eyJ2IjoxLCJhdWQiOiJnaC1hdy1lbmNsYXZlLWdpdGh1YiIsInJ1biI6InJ1bi0xMjMiLCJpbnYiOiJpbnYtNDU2IiwicmVwbyI6Im9jdG8vcHJpdmF0ZSIsInByb2ZpbGUiOiJpc3N1ZXMtcmVhZC12MSIsIm9wcyI6WyJpc3N1ZXMuY29tbWVudHMubGlzdCIsImlzc3Vlcy5nZXQiLCJpc3N1ZXMubGlzdCJdLCJuYmYiOjE3ODc1OTQ0MDAsImV4cCI6MTc4NzU5NDUyMH0.' +
        '6fDSD-uxmi_fCZMOFmSuckdNBGx5qcWMI1HCgoXtA3o',
      );
    });

    it.each([
      { keyHex: 'A'.repeat(64) },
      { repo: 'Octo/private' },
      { repo: '' },
      { repo: 'octo' },
      { repo: 'octo/*' },
      { repo: 'private:octo/private' },
      { runId: '../run' },
      { notBefore: -1 },
      { expiresAt: 1787594399 },
    ])('rejects noncanonical signer input (%j)', (override) => {
      expect(() => mintGithubCapability({
        keyHex: '0'.repeat(64),
        runId: 'run-123',
        invocationId: 'inv-456',
        repo: 'octo/private',
        notBefore: 1787594400,
        expiresAt: 1787594520,
        ...override,
      })).toThrow();
    });

    it('uses the compiler identity and exact assigned repository as capability claims', () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-capability-run-'));
      try {
        const seedRunId = '0123456789abcdef0123456789abcdef';
        const githubRunIdentity = 'gh-aw-egh-123456-1-abcdef123456';
        const layout = agentWorkspaceAdapter.createInvocationWorkspace({
          config: {
            workDir,
            auditDir: path.join(workDir, 'audit'),
            enclaveUid: process.getuid?.() ?? 0,
            enclaveGid: process.getgid?.() ?? 0,
            timeoutSeconds: 120,
            githubEnabled: true,
            githubCapabilityKey: '0'.repeat(64),
            githubRunIdentity,
          },
          runId: seedRunId,
          invocationId: 'abcdef1234567890',
          privateRepo: 'octo/private',
          schema: { type: 'object' },
          prompt: 'read one issue',
        });
        const token = fs.readFileSync(layout.githubCapabilityPath, 'utf8').trim();
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
        );
        expect(payload.run).toBe(githubRunIdentity);
        expect(payload.run).not.toBe(seedRunId);
        expect(payload.repo).toBe('octo/private');
        expect(Object.keys(payload)).toEqual([
          'v', 'aud', 'run', 'inv', 'repo', 'profile', 'ops', 'nbf', 'exp',
        ]);
        expect(JSON.stringify(payload)).not.toMatch(/private:|secrecy|label/i);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});

describe('unified enclave agent server configuration', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  function setEnv(overrides: Record<string, string> = {}): void {
    Object.assign(process.env, {
      AWF_ENCLAVE_PRIMARY_BACKEND: 'docker',
      AWF_ENCLAVE_AGENT_BACKEND: 'gvisor',
      AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
      AWF_ENCLAVE_AGENT_PROFILE: 'anthropic',
      AWF_ENCLAVE_AGENT_MODEL: 'trusted-model',
      AWF_ENCLAVE_AGENT_IMAGE: 'image:pinned',
      AWF_ENCLAVE_AGENT_NETWORK: 'awf-enclave-agent',
      AWF_ENCLAVE_AGENT_API_ENDPOINT: 'http://172.31.0.30:10001',
      AWF_ENCLAVE_AGENT_HOST_WORK_DIR: '/daemon/private/enclave/work',
      AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR: '/daemon/private/enclave/seeds',
      AWF_ENCLAVE_AGENT_TIMEOUT: '90',
      AWF_ENCLAVE_AGENT_MEMORY: '700m',
      AWF_ENCLAVE_AGENT_CPU: '0.25',
      AWF_ENCLAVE_AGENT_PIDS: '33',
      AWF_ENCLAVE_AGENT_TMPFS: '80m',
      AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: '4096',
      AWF_ENCLAVE_AGENT_MAX_PROMPT_BYTES: '2048',
      AWF_ENCLAVE_AGENT_MAX_INVOCATIONS: '3',
      ...overrides,
    });
  }

  const server = { auditDir: '/var/log/awf-enclave', primaryBackend: 'docker' };

  it('derives every enclave control from the trusted server environment', () => {
    setEnv();
    expect(loadAgentConfig(server)).toMatchObject({
      backend: 'gvisor',
      engine: 'copilot',
      profile: 'anthropic',
      model: 'trusted-model',
      network: 'awf-enclave-agent',
      apiEndpoint: 'http://172.31.0.30:10001',
      timeoutSeconds: 90,
      memoryLimit: '700m',
      cpuLimit: '0.25',
      pidsLimit: 33,
      tmpfsLimit: '80m',
      maxOutputBytes: 4096,
      maxPromptBytes: 2048,
      maxInvocations: 3,
      enclaveUid: 65534,
      enclaveGid: 65534,
      enclaveSeccompPath: '/opt/awf/enclave-seccomp.json',
      runLabelKey: 'awf.enclave.run',
      invocationLabelKey: 'awf.enclave.invocation',
      containerPrefix: 'awf-enclave-agent',
    });
  });

  it.each([
    ['AWF_ENCLAVE_AGENT_BACKEND', 'sbx'],
    ['AWF_ENCLAVE_AGENT_ENGINE', 'claude'],
    ['AWF_ENCLAVE_AGENT_PROFILE', 'vertex'],
    ['AWF_ENCLAVE_AGENT_API_ENDPOINT', 'https://api.example.com'],
    ['AWF_ENCLAVE_AGENT_NETWORK', 'not a network!'],
    ['AWF_ENCLAVE_AGENT_CPU', '0'],
  ])('fails closed for an unsupported %s', (name, value) => {
    setEnv({ [name]: value });
    expect(() => loadAgentConfig(server)).toThrow();
  });

  it('loads the capability root and compiler run identity only from fixed private files', () => {
    setEnv({
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
      AWF_ENCLAVE_AGENT_GITHUB_PROXY_URL: 'http://172.31.0.40:11000',
      AWF_ENCLAVE_AGENT_GITHUB_CAPABILITY_KEY_PATH:
        '/run/awf-enclave-mcp/github-capability-key',
      AWF_ENCLAVE_AGENT_GITHUB_RUN_IDENTITY_PATH:
        '/run/awf-enclave-mcp/github-run-identity',
    });
    const config = loadAgentConfig(server, {
      readFileSync: (target: string) => target.endsWith('github-capability-key')
        ? '0'.repeat(64)
        : 'gh-aw-egh-123456-1-abcdef123456',
    });
    expect(config.githubCapabilityKey).toBe('0'.repeat(64));
    expect(config.githubRunIdentity).toBe('gh-aw-egh-123456-1-abcdef123456');
    expect(process.env.AWF_ENCLAVE_GITHUB_PROXY_IDENTITY).toBeUndefined();
  });

  it('requires an AWF capability before serving either executor', () => {
    setEnv();
    expect(() => loadServerConfig({ readFileSync: () => 'not-a-capability' })).toThrow(
      /does not contain an AWF capability/,
    );
    expect(loadServerConfig({ readFileSync: () => 'a'.repeat(64) })).toMatchObject({
      primaryBackend: 'docker',
      listenHost: '0.0.0.0',
      listenPort: 8080,
      auditDir: '/var/log/awf-enclave',
    });
  });
});
