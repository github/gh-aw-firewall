import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const containersRoot = path.join(__dirname, '..', '..', 'containers');
const {
  DELEGATION_CHANNEL_DIR,
  ENCLAVE_GITHUB_BEARER_PATH,
  loadAgentConfig,
  loadServerConfig,
} = require(path.join(containersRoot, 'enclave', 'mcp-server', 'config.js'));
const {
  deriveEnclaveContainerSpec,
} = require(path.join(containersRoot, 'enclave', 'agent-executor', 'enclave-runner-spec.js'));
const agentWorkspace = require(path.join(containersRoot, 'enclave', 'agent-executor', 'workspace.js'));
const {
  createExecutorHandler,
} = require(path.join(containersRoot, 'enclave', 'script-executor', 'executor-handler.js'));
const {
  createEnclaveInformationBudgetLedger,
} = require(path.join(containersRoot, 'bounded-execution', 'sensitivity-ledger.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const BASE_ENV = {
  AWF_ENCLAVE_PRIMARY_BACKEND: 'docker',
  AWF_ENCLAVE_AGENT_BACKEND: 'docker',
  AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
  AWF_ENCLAVE_AGENT_PROFILE: 'openai',
  AWF_ENCLAVE_AGENT_MODEL: 'gpt-test',
  AWF_ENCLAVE_AGENT_IMAGE: 'ghcr.io/example/enclave-agent:test',
  AWF_ENCLAVE_AGENT_API_ENDPOINT: 'http://172.31.0.30:10000',
  AWF_ENCLAVE_AGENT_NETWORK: 'awf-enclave-agent',
  AWF_ENCLAVE_AGENT_HOST_WORK_DIR: '/var/tmp/awf-enclave-private/work',
};

const DYNAMIC_ENV = {
  ...BASE_ENV,
  AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
  AWF_ENCLAVE_AGENT_DYNAMIC_CHANNEL_DIR: '/run/awf-enclave-delegation',
  AWF_ENCLAVE_AGENT_DYNAMIC_SENSITIVITY: 'confidential',
  AWF_ENCLAVE_AGENT_DYNAMIC_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
  AWF_ENCLAVE_AGENT_GITHUB_GATEWAY_CONTAINER: 'awmg-mcpg',
  AWF_ENCLAVE_SEED_MAP_ENABLED: 'false',
  AWF_ENCLAVE_RUN_ID: 'f'.repeat(32),
};

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWF_ENCLAVE_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const serverStub = { primaryBackend: 'docker', auditDir: '/var/log/awf-enclave' };

describe('dynamic broker configuration', () => {
  it('loads a dynamic agent entry without a seed catalog or seeds directory', () => {
    withEnv(DYNAMIC_ENV, () => {
      const config = loadAgentConfig(serverStub);
      expect(config).toMatchObject({
        dynamicEnabled: true,
        dynamicChannelDir: DELEGATION_CHANNEL_DIR,
        dynamicSensitivity: 'confidential',
        dynamicGithubMcpUrl: 'http://172.31.0.40:8080/mcp/github',
        enclaveGithubBearerPath: ENCLAVE_GITHUB_BEARER_PATH,
        githubEnabled: false,
        // Needed by the per-launch network-isolation proof: a dynamic entry
        // reaches the same shared gateway as the static profile.
        githubGatewayContainer: 'awmg-mcpg',
      });
      expect(config.hostSeedsDir).toBeUndefined();
    });
  });

  it('resolves the run id from AWF when no seed catalog is staged', () => {
    withEnv(DYNAMIC_ENV, () => {
      const server = loadServerConfig({ readFileSync: () => 'a'.repeat(64) });
      expect(server).toMatchObject({ seedMapEnabled: false, runId: 'f'.repeat(32) });
    });
  });

  it('keeps the static seed catalog when AWF stages one', () => {
    withEnv({ ...BASE_ENV, AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR: '/seeds' }, () => {
      const server = loadServerConfig({ readFileSync: () => 'a'.repeat(64) });
      expect(server.seedMapEnabled).toBe(true);
    });
  });

  it.each([
    ['a foreign channel directory', { AWF_ENCLAVE_AGENT_DYNAMIC_CHANNEL_DIR: '/tmp/attacker' }],
    ['an unsupported sensitivity', { AWF_ENCLAVE_AGENT_DYNAMIC_SENSITIVITY: 'bogus' }],
    ['a non-fixed MCP endpoint', { AWF_ENCLAVE_AGENT_DYNAMIC_GITHUB_MCP_URL: 'http://evil.example/mcp/github' }],
    ['a static GitHub profile alongside the dynamic policy', { AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true' }],
    ['a missing shared gateway container', { AWF_ENCLAVE_AGENT_GITHUB_GATEWAY_CONTAINER: undefined }],
  ])('fails closed for %s', (_label, overrides) => {
    withEnv({ ...DYNAMIC_ENV, ...overrides }, () => {
      expect(() => loadAgentConfig(serverStub)).toThrow();
    });
  });

  it('requires a run id when no seed catalog is staged', () => {
    withEnv({ ...DYNAMIC_ENV, AWF_ENCLAVE_RUN_ID: undefined }, () => {
      expect(() => loadServerConfig({ readFileSync: () => 'a'.repeat(64) })).toThrow(
        /AWF_ENCLAVE_RUN_ID is required/,
      );
    });
  });
});

describe('dynamic enclave container specification', () => {
  const config = {
    dynamicEnabled: true,
    dynamicGithubMcpUrl: 'http://172.31.0.40:8080/mcp/github',
    dynamicRepository: 'octo-org/service',
    dynamicReadMode: 'live',
    enclaveGithubBearerPath: ENCLAVE_GITHUB_BEARER_PATH,
    hostWorkDir: '/var/tmp/work',
    enclaveSeccompPath: '/opt/awf/enclave-seccomp.json',
    enclaveMountDir: '/agent',
    enclaveSeedPath: '/awf/seed',
    enclaveTaskPath: '/awf/task.txt',
    enclaveSchemaPath: '/awf/schema.json',
    enclaveUid: 65534,
    enclaveGid: 65534,
    enclaveImage: 'ghcr.io/example/enclave-agent:test',
    engine: 'copilot',
    profile: 'openai',
    model: 'gpt-test',
    apiEndpoint: 'http://172.31.0.30:10000',
    network: 'awf-enclave-agent',
    timeoutSeconds: 120,
    memoryLimit: '1g',
    cpuLimit: '1',
    pidsLimit: 128,
    tmpfsLimit: '256m',
    maxOutputBytes: 8192,
  };
  const spec = deriveEnclaveContainerSpec({
    config,
    runId: 'a'.repeat(32),
    invocationId: 'b'.repeat(24),
  });
  const args: string[] = [...spec.launchArgs];
  const joined = args.join(' ');

  it('mounts no repository seed', () => {
    expect(joined).not.toContain('/awf/seed');
    expect(args.filter((arg) => arg.startsWith('/var/tmp/work')).join(' ')).not.toContain('seed');
  });

  it('runs from the invocation-private runtime directory instead of a checkout', () => {
    expect(args[args.indexOf('--workdir') + 1]).toBe('/agent');
  });

  it('mounts only the invocation-private bearer read-only', () => {
    expect(args).toContain(
      `/var/tmp/work/${'b'.repeat(24)}/github-bearer:${ENCLAVE_GITHUB_BEARER_PATH}:ro`,
    );
  });

  it('exposes the admitted repository and its read mode to the executor', () => {
    expect(args).toContain('AWF_ENCLAVE_AGENT_DYNAMIC_REPO=octo-org/service');
    expect(args).toContain('AWF_ENCLAVE_AGENT_DYNAMIC_READ_MODE=live');
    expect(args).toContain('AWF_ENCLAVE_AGENT_GITHUB_MCP_URL=http://172.31.0.40:8080/mcp/github');
  });

  it('keeps the executor on the dedicated api-proxy-only network', () => {
    expect(args[args.indexOf('--network') + 1]).toBe('awf-enclave-agent');
  });

  it.each([
    ['the delegation control endpoint', 'awf-enclave-mcp-control'],
    ['the control capability variable', 'DELEGATION_CONTROL_CAPABILITY'],
    ['the control endpoint variable', 'DELEGATION_CONTROL_ENDPOINT'],
    ['an identity handle', 'dlg_'],
    ['mcpg delegation state', 'MCP_GATEWAY_DELEGATION'],
    ['the private admission channel', '/run/awf-enclave-delegation'],
  ])('never hands the executor %s', (_label, needle) => {
    expect(joined).not.toContain(needle);
  });

  it('masks every provider credential slot rather than passing a token', () => {
    for (const masked of ['COPILOT_GITHUB_TOKEN=******', 'COPILOT_TOKEN=******']) {
      expect(args).toContain(masked.split('=')[0] + '=' + masked.split('=')[1]);
    }
    expect(joined).not.toMatch(/(?:GH|GITHUB)_TOKEN=(?!\*)/);
    expect(joined).not.toMatch(/gh[pousr]_/);
  });

  it('still requires a trusted seed id for a static entry', () => {
    expect(() => deriveEnclaveContainerSpec({
      config: { ...config, dynamicEnabled: false },
      runId: 'a'.repeat(32),
      invocationId: 'b'.repeat(24),
    })).toThrow(/seedId/);
  });
});

describe('dynamic invocation workspace', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const config = () => ({
    workDir,
    enclaveUid: process.getuid?.() ?? 0,
    enclaveGid: process.getgid?.() ?? 0,
    dynamicEnabled: true,
  });

  it('writes the bearer invocation-private and read-only', () => {
    const layout = agentWorkspace.createInvocationWorkspace({
      config: config(),
      invocationId: 'c'.repeat(24),
      task: 'summarize',
      schema: { type: 'boolean' },
      executorBearer: 'dlgbearer_abcdef0123456789',
    });
    expect(fs.readFileSync(layout.githubBearerPath, 'utf8').trim())
      .toBe('dlgbearer_abcdef0123456789');
    expect(fs.statSync(layout.githubBearerPath).mode & 0o777).toBe(0o400);
  });

  it.each([
    ['a missing bearer', undefined],
    ['an empty bearer', ''],
    ['a bearer with whitespace', 'dlgbearer with space'],
  ])('refuses %s', (_label, bearer) => {
    expect(() => agentWorkspace.createInvocationWorkspace({
      config: config(),
      invocationId: 'd'.repeat(24),
      task: 'summarize',
      schema: { type: 'boolean' },
      executorBearer: bearer,
    })).toThrow(/delegated executor bearer/);
  });

  it('writes no bearer for a static entry', () => {
    const layout = agentWorkspace.createInvocationWorkspace({
      config: { ...config(), dynamicEnabled: false },
      invocationId: 'e'.repeat(24),
      task: 'summarize',
      schema: { type: 'boolean' },
    });
    expect(fs.existsSync(layout.githubBearerPath)).toBe(false);
  });
});

describe('dynamic executor handler routing', () => {
  function buildHandler(overrides: Record<string, unknown> = {}) {
    const events: string[] = [];
    const admissionCalls: unknown[] = [];
    const settlements: unknown[] = [];
    const workspaceCalls: unknown[] = [];
    const handler = createExecutorHandler({
      config: {
        workDir: '/srv/awf/work',
        primaryBackend: 'docker',
        executorBackend: 'docker',
        timeoutSeconds: 5,
        maxInvocations: 8,
        maxOutputBytes: 8192,
        dynamicEnabled: true,
      },
      seedMap: new Map(),
      runId: 'a'.repeat(32),
      audit: {
        failure: (_id: string, reason: string) => events.push(`failure:${reason}`),
        invocation: () => events.push('invocation'),
        lifecycle: () => undefined,
      },
      ledger: createEnclaveInformationBudgetLedger(new Map()),
      clock: { nowMs: () => 0, sleep: async () => undefined },
      responseJitterSource: () => 0,
      validateRequest: (request: Record<string, unknown>) => ({
        valid: true,
        request: { privateRepo: request.privateRepo, schema: request.schema, prompt: 'go' },
      }),
      payloadKey: 'prompt',
      executorKind: 'agent',
      uniformTiming: true,
      workspace: {
        createInvocationWorkspace(params: Record<string, unknown>) {
          workspaceCalls.push(params);
          return { outPath: '/srv/awf/work/out' };
        },
        readQueryOutput: () => 'true',
        destroyInvocationWorkspace: () => undefined,
      },
      runner: {
        runScriptContainer: async () => ({ exitCode: 0, timedOut: false }),
      },
      admission: {
        async admit(params: Record<string, unknown>) {
          admissionCalls.push(params);
          return {
            admitted: true,
            repo: params.selector,
            executorBearer: 'dlgbearer_1',
            readMode: 'live',
            sensitivity: 'confidential',
          };
        },
        async settle(params: Record<string, unknown>) {
          settlements.push(params);
          return { settled: true, revoked: true };
        },
        ...overrides,
      },
      ...(overrides.handlerOverrides as object ?? {}),
    });
    return { handler, events, admissionCalls, settlements, workspaceCalls };
  }

  function invoke(handler: { handle: (request: unknown, respond: (json: string) => void) => Promise<void> }) {
    return new Promise<string>((resolve) => {
      void handler.handle(
        { privateRepo: 'octo-org/service', schema: { type: 'boolean' }, prompt: 'go' },
        resolve,
      );
    });
  }

  it('admits before any workspace or container exists', async () => {
    const { handler, admissionCalls, workspaceCalls } = buildHandler();
    const result = await invoke(handler as never);
    expect(JSON.parse(result)).toMatchObject({ status: 'ok' });
    expect(admissionCalls).toHaveLength(1);
    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]).toMatchObject({ executorBearer: 'dlgbearer_1', readMode: 'live' });
  });

  it('returns the canonical error and creates nothing when admission is denied', async () => {
    const { handler, workspaceCalls, settlements } = buildHandler({
      async admit() {
        return { admitted: false };
      },
    });
    const result = await invoke(handler as never);
    expect(JSON.parse(result)).toEqual({ status: 'error' });
    expect(workspaceCalls).toHaveLength(0);
    expect(settlements).toHaveLength(0);
  });

  it('settles the invocation on the success path', async () => {
    const { handler, settlements } = buildHandler();
    await invoke(handler as never);
    expect(settlements[0]).toMatchObject({ outcome: 'success' });
  });

  it('downgrades a successful invocation when revocation is unresolved', async () => {
    const { handler } = buildHandler({
      async settle() {
        return { settled: false, revoked: false };
      },
    });
    const result = await invoke(handler as never);
    expect(JSON.parse(result)).toEqual({ status: 'error' });
  });

  it('settles and revokes even when the pipeline throws after admission', async () => {
    const settlements: unknown[] = [];
    const handler = createExecutorHandler({
      config: {
        workDir: '/srv/awf/work',
        primaryBackend: 'docker',
        executorBackend: 'docker',
        timeoutSeconds: 5,
        maxInvocations: 8,
        maxOutputBytes: 8192,
        dynamicEnabled: true,
      },
      seedMap: new Map(),
      runId: 'a'.repeat(32),
      audit: { failure: () => undefined, invocation: () => undefined, lifecycle: () => undefined },
      // An unexpected internal error after admission must not strand a live
      // delegated identity.
      ledger: {
        registerRepository: () => undefined,
        tryDebit: () => {
          throw new Error('ledger exploded');
        },
        remainingBits: () => 0,
      },
      clock: { nowMs: () => 0, sleep: async () => undefined },
      responseJitterSource: () => 0,
      validateRequest: (request: Record<string, unknown>) => ({
        valid: true,
        request: { privateRepo: request.privateRepo, schema: request.schema, prompt: 'go' },
      }),
      payloadKey: 'prompt',
      executorKind: 'agent',
      uniformTiming: true,
      workspace: {
        createInvocationWorkspace: () => ({ outPath: '/srv/awf/work/out' }),
        readQueryOutput: () => 'true',
        destroyInvocationWorkspace: () => undefined,
      },
      runner: {
        runScriptContainer: async () => ({ exitCode: 0, timedOut: false }),
      },
      admission: {
        async admit(params: Record<string, unknown>) {
          return {
            admitted: true,
            repo: params.selector,
            executorBearer: 'dlgbearer_1',
            readMode: 'live',
            sensitivity: 'confidential',
          };
        },
        async settle(params: Record<string, unknown>) {
          settlements.push(params);
          return { settled: true, revoked: true };
        },
      },
    });
    const result = await new Promise<string>((resolve) => {
      void (handler as { handle: (request: unknown, respond: (json: string) => void) => Promise<void> })
        .handle(
          { privateRepo: 'octo-org/service', schema: { type: 'boolean' }, prompt: 'go' },
          resolve,
        );
    });
    expect(JSON.parse(result)).toEqual({ status: 'error' });
    expect(settlements).toEqual([expect.objectContaining({ outcome: 'broker-error' })]);
  });
});

describe('dynamic tool advertisement', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    AGENT_TOOL_NAME,
    TOOL_NAME,
    dispatchJsonRpc,
  } = require(path.join(containersRoot, 'enclave', 'mcp-server', 'mcp-protocol.js'));
  /* eslint-enable @typescript-eslint/no-require-imports */

  it('advertises only enclave_run_agent for a dynamic entry', async () => {
    const listed = await dispatchJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { handlers: { [AGENT_TOOL_NAME]: { handle: () => undefined } }, maxPromptBytes: 4096 },
    );
    const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual([AGENT_TOOL_NAME]);
    expect(names).not.toContain(TOOL_NAME);
  });

  it('refuses to dispatch enclave_run_script for a dynamic entry', async () => {
    const called = await dispatchJsonRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { privateRepo: 'octo-org/service' } },
      },
      { handlers: { [AGENT_TOOL_NAME]: { handle: () => undefined } }, maxPromptBytes: 4096 },
    );
    expect(called.error).toBeDefined();
  });
});

describe('dynamic enclave runner binding', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    createAgentRunner,
  } = require(path.join(containersRoot, 'enclave', 'mcp-server', 'agent-executor.js'));
  /* eslint-enable @typescript-eslint/no-require-imports */

  const runnerConfig = {
    backend: 'docker',
    dynamicEnabled: true,
    dynamicGithubMcpUrl: 'http://172.31.0.40:8080/mcp/github',
    githubGatewayContainer: 'awmg-mcpg',
    enclaveGithubBearerPath: ENCLAVE_GITHUB_BEARER_PATH,
    hostWorkDir: '/var/tmp/work',
    enclaveSeccompPath: '/opt/awf/enclave-seccomp.json',
    enclaveMountDir: '/agent',
    enclaveSeedPath: '/awf/seed',
    enclaveTaskPath: '/awf/task.txt',
    enclaveSchemaPath: '/awf/schema.json',
    enclaveUid: 65534,
    enclaveGid: 65534,
    enclaveImage: 'ghcr.io/example/enclave-agent:test',
    engine: 'copilot',
    profile: 'openai',
    model: 'gpt-test',
    apiEndpoint: 'http://172.31.0.30:10000',
    network: 'awf-enclave-agent',
    timeoutSeconds: 120,
    memoryLimit: '1g',
    cpuLimit: '1',
    pidsLimit: 128,
    tmpfsLimit: '256m',
    maxOutputBytes: 8192,
  };

  const DYNAMIC_TOPOLOGY =
    'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,awmg-mcpg@172.31.0.40/24,';

  function stubDocker(topology = DYNAMIC_TOPOLOGY) {
    const calls: string[][] = [];
    return {
      calls,
      async runDocker(args: string[]) {
        calls.push(args);
        if (args[0] === 'network') return { exitCode: 0, stdout: topology, timedOut: false };
        if (args[0] === 'ps') return { exitCode: 0, stdout: '', timedOut: false };
        return { exitCode: 0, stdout: '', timedOut: false };
      },
    };
  }

  it('threads the admitted repository and read mode into the launch vector', async () => {
    const docker = stubDocker();
    const runner = createAgentRunner(runnerConfig, { docker });
    await runner.runScriptContainer({
      runId: 'a'.repeat(32),
      invocationId: 'b'.repeat(24),
      timeoutMs: 1000,
      dynamic: { repository: 'octo-org/service', readMode: 'live' },
    });
    const launch = docker.calls.find((args) => args[0] === 'run')!;
    expect(launch).toContain('AWF_ENCLAVE_AGENT_DYNAMIC_REPO=octo-org/service');
    expect(launch).toContain('AWF_ENCLAVE_AGENT_DYNAMIC_READ_MODE=live');
    expect(launch.join(' ')).not.toContain('undefined');
  });

  it('carries a pinned read mode through unchanged', async () => {
    const docker = stubDocker();
    const runner = createAgentRunner(runnerConfig, { docker });
    await runner.runScriptContainer({
      runId: 'a'.repeat(32),
      invocationId: 'c'.repeat(24),
      timeoutMs: 1000,
      dynamic: { repository: 'octo-org/service', readMode: 'pinned' },
    });
    const launch = docker.calls.find((args) => args[0] === 'run')!;
    expect(launch).toContain('AWF_ENCLAVE_AGENT_DYNAMIC_READ_MODE=pinned');
  });

  it('accepts the steady-state topology a dynamic run actually creates', async () => {
    const docker = stubDocker();
    const runner = createAgentRunner(runnerConfig, { docker });
    await expect(runner.runScriptContainer({
      runId: 'a'.repeat(32),
      invocationId: 'd'.repeat(24),
      timeoutMs: 1000,
      dynamic: { repository: 'octo-org/service', readMode: 'live' },
    })).resolves.toMatchObject({ exitCode: 0 });
  });

  it('still refuses a network with an unexpected member', async () => {
    const docker = stubDocker(
      'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,'
      + 'awmg-mcpg@172.31.0.40/24,intruder@172.31.0.99/24,',
    );
    const runner = createAgentRunner(runnerConfig, { docker });
    await expect(runner.runScriptContainer({
      runId: 'a'.repeat(32),
      invocationId: 'e'.repeat(24),
      timeoutMs: 1000,
      dynamic: { repository: 'octo-org/service', readMode: 'live' },
    })).rejects.toThrow(/not isolated/);
  });

  it.each([
    ['a missing binding', undefined],
    ['a non-canonical repository', { repository: 'Octo-Org/Service', readMode: 'live' }],
    ['an unknown read mode', { repository: 'octo-org/service', readMode: 'cached' }],
  ])('refuses to launch a dynamic enclave with %s', async (_label, dynamic) => {
    const docker = stubDocker();
    const runner = createAgentRunner(runnerConfig, { docker });
    await expect(runner.runScriptContainer({
      runId: 'a'.repeat(32),
      invocationId: 'f'.repeat(24),
      timeoutMs: 1000,
      dynamic,
    })).rejects.toThrow();
    expect(docker.calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('reconciles a dynamic run without an invocation binding', async () => {
    const docker = stubDocker();
    const runner = createAgentRunner(runnerConfig, { docker });
    await expect(runner.reconcileRun('a'.repeat(32))).resolves.toBeUndefined();
    expect(docker.calls.some((args) => args[0] === 'ps')).toBe(true);
  });
});

describe('dynamic enclave agent instructions', () => {
  const entrypoint = path.join(containersRoot, 'enclave', 'agent-entrypoint.py');

  function runHarness(script: string, env: Record<string, string>) {
    return spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ENTRYPOINT: entrypoint, ...env },
    });
  }

  const loader = String.raw`
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("agent_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

  it('tells the enclave there is no checkout and names the single admitted repository', () => {
    const result = runHarness(
      `${loader}print(module.build_prompt("summarize", json.dumps({"type": "boolean"})))`,
      {
        AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
        AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'octo-org/service',
        AWF_ENCLAVE_AGENT_DYNAMIC_READ_MODE: 'live',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('There is no repository checkout');
    expect(result.stdout).not.toContain('/awf/seed');
    expect(result.stdout).toContain('octo-org/service');
    expect(result.stdout).toContain('Reads are live');
    for (const prohibition of [
      'must not clone',
      'arbitrary URLs',
      'GitHub CLI',
      'write or mutation',
      'unscoped or organization-wide search',
      'enumerate or discover repositories',
    ]) {
      expect(result.stdout).toContain(prohibition);
    }
  });

  it('marks reads as pinned only when the control binding carries a SHA', () => {
    const result = runHarness(
      `${loader}print(module.build_prompt("summarize", json.dumps({"type": "boolean"})))`,
      {
        AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
        AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'octo-org/service',
        AWF_ENCLAVE_AGENT_DYNAMIC_READ_MODE: 'pinned',
      },
    );
    expect(result.stdout).toContain('Reads are pinned');
  });

  it('keeps the static seed-backed instructions unchanged', () => {
    const result = runHarness(
      `${loader}print(module.build_prompt("summarize", json.dumps({"type": "boolean"})))`,
      {},
    );
    expect(result.stdout).toContain('mounted read-only at /awf/seed');
  });

  it('writes a bearer-only GitHub MCP config confined to the two delegated tools', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-entrypoint-'));
    try {
      fs.mkdirSync(path.join(stage, 'agent'));
      fs.writeFileSync(path.join(stage, 'bearer'), 'dlgbearer_abcdef0123456789\n');
      const result = runHarness(
        `${loader}
from pathlib import Path
root = Path(os.environ["HARNESS_ROOT"])
module.AGENT_DIR = root / "agent"
module.GITHUB_BEARER_PATH = root / "bearer"
module.GITHUB_MCP_CONFIG_PATH = module.AGENT_DIR / "github-mcp.json"
module.configure_github_mcp()
print(module.GITHUB_MCP_CONFIG_PATH.read_text())
`,
        {
          HARNESS_ROOT: stage,
          AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
          AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'octo-org/service',
          AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
        },
      );
      expect(result.status).toBe(0);
      const config = JSON.parse(result.stdout);
      expect(config.mcpServers.github).toEqual({
        type: 'http',
        url: 'http://172.31.0.40:8080/mcp/github',
        headers: { Authorization: 'dlgbearer_abcdef0123456789' },
        tools: ['list_issues', 'issue_read'],
      });
      expect(fs.statSync(path.join(stage, 'agent', 'github-mcp.json')).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it.each([
    ['a non-fixed endpoint', { AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://evil.example/mcp/github' }],
    ['a non-canonical repository', { AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'Octo-Org/Service' }],
  ])('refuses to build a dynamic MCP config with %s', (_label, overrides) => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-entrypoint-'));
    try {
      fs.mkdirSync(path.join(stage, 'agent'));
      fs.writeFileSync(path.join(stage, 'bearer'), 'dlgbearer_abcdef0123456789\n');
      const result = runHarness(
        `${loader}
from pathlib import Path
root = Path(os.environ["HARNESS_ROOT"])
module.AGENT_DIR = root / "agent"
module.GITHUB_BEARER_PATH = root / "bearer"
module.GITHUB_MCP_CONFIG_PATH = module.AGENT_DIR / "github-mcp.json"
try:
    module.configure_github_mcp()
    print("accepted")
except ValueError:
    print("rejected")
`,
        {
          HARNESS_ROOT: stage,
          AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
          AWF_ENCLAVE_AGENT_DYNAMIC_REPO: 'octo-org/service',
          AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
          ...overrides,
        },
      );
      expect(result.stdout.trim()).toBe('rejected');
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});
