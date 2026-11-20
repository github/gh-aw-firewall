import * as fs from 'fs';
import * as path from 'path';
import { useTempDir } from '../test-helpers/docker-test-fixtures.test-utils';

/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('../../containers/enclave/mcp-server/config', () => ({
  ...jest.requireActual('../../containers/enclave/mcp-server/config'),
  loadServerConfig: jest.fn(),
  loadConfig: jest.fn(),
  loadAgentConfig: jest.fn(),
  loadSeedMap: jest.fn(),
}));
jest.mock('../../containers/enclave/script-executor/script-runner', () => ({ createScriptRunner: jest.fn() }));
jest.mock('../../containers/enclave/mcp-server/agent-executor', () => ({
  ...jest.requireActual('../../containers/enclave/mcp-server/agent-executor'),
  createAgentRunner: jest.fn(),
  createAgentRequestValidator: jest.fn(
    jest.requireActual('../../containers/enclave/mcp-server/agent-executor').createAgentRequestValidator,
  ),
}));
jest.mock('../../containers/enclave/mcp-server/host-executor-runner', () => ({
  ...jest.requireActual('../../containers/enclave/mcp-server/host-executor-runner'),
  createHostExecutorRunner: jest.fn(),
}));
jest.mock('../../containers/enclave/script-executor/executor-handler', () => ({ createExecutorHandler: jest.fn() }));
jest.mock('../../containers/enclave/mcp-server/delegation-channel', () => ({ createDynamicDelegationClient: jest.fn() }));
jest.mock('../../containers/enclave/mcp-server/environment-probes', () => ({ probeStartupEnvironment: jest.fn() }));
jest.mock('../../containers/bounded-execution/protected-audit', () => ({ createProtectedAuditLog: jest.fn() }));
jest.mock('../../containers/enclave/script-executor/runtime-telemetry', () => ({ createRuntimeTelemetry: jest.fn() }));
jest.mock('http', () => ({
  createServer: jest.fn(() => ({
    once: jest.fn(),
    listen: jest.fn((_port, _host, ready) => ready()),
    close: jest.fn(),
  })),
}));

const config = require('../../containers/enclave/mcp-server/config');
const agent = require('../../containers/enclave/mcp-server/agent-executor');
const { createScriptRunner } = require('../../containers/enclave/script-executor/script-runner');
const { createHostExecutorRunner } = require('../../containers/enclave/mcp-server/host-executor-runner');
const { createExecutorHandler } = require('../../containers/enclave/script-executor/executor-handler');
const { createDynamicDelegationClient } = require('../../containers/enclave/mcp-server/delegation-channel');
const { probeStartupEnvironment } = require('../../containers/enclave/mcp-server/environment-probes');
const { createProtectedAuditLog } = require('../../containers/bounded-execution/protected-audit');
const { createRuntimeTelemetry } = require('../../containers/enclave/script-executor/runtime-telemetry');
const { createStartupPlan, getExecutorBackend } = require('../../containers/enclave/mcp-server/startup-plan');
const { main } = require('../../containers/enclave/mcp-server/server');
const { createServer } = require('http');
/* eslint-enable @typescript-eslint/no-require-imports */

const scriptStages = ['script-config', 'script-selection', 'script-available', 'script-reconcile', 'script-handler'];
const agentStages = ['agent-config', 'agent-selection', 'agent-available', 'agent-reconcile', 'agent-handler'];
type HandlerParams = Record<string, unknown> & {
  lane: { tail: Promise<void> };
  clock: { nowMs: () => number };
};

describe('enclave MCP startup', () => {
  const { getDir } = useTempDir();
  const originalEnv = process.env;
  const runId = 'a'.repeat(32);
  const seeds = new Map([['octo/private', { seedId: 'seed', sensitivity: 'confidential' }]]);
  const audit = { lifecycle: jest.fn() };
  const telemetry = { emit: jest.fn() };
  let records: { stage: string; status: string; executorKind: string; reasonId?: string }[];

  function makeRunner() {
    return {
      hostOwned: false,
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      reconcileRun: jest.fn().mockResolvedValue(undefined),
    };
  }

  let scriptRunner: ReturnType<typeof makeRunner>;
  let agentRunner: ReturnType<typeof makeRunner>;
  let serverConfig: Record<string, unknown>;
  let scriptConfig: Record<string, unknown>;
  let agentConfig: Record<string, unknown>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AWF_ENCLAVE_SCRIPT_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_ENABLED: 'true',
      AWF_ENCLAVE_PRIMARY_BACKEND: 'docker',
      AWF_ENCLAVE_BACKEND: 'gvisor',
      AWF_ENCLAVE_AGENT_BACKEND: 'gvisor',
    };
    records = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
      return true;
    });
    jest.spyOn(process, 'on').mockReturnValue(process);
    jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    serverConfig = {
      primaryBackend: 'docker',
      seedMapEnabled: true,
      seedMapPath: path.join(getDir(), 'seed-map.json'),
      controlDir: getDir(),
      auditDir: getDir(),
      readyPath: path.join(getDir(), 'server.ready'),
      listenHost: '127.0.0.1',
      listenPort: 8080,
      capability: 'b'.repeat(64),
      runId,
    };
    scriptConfig = { primaryBackend: 'docker', executorBackend: 'gvisor', maxScriptBytes: 1234 };
    agentConfig = {
      primaryBackend: 'docker', executorBackend: 'gvisor', maxPromptBytes: 5678,
      githubEnabled: true, dynamicEnabled: false,
    };
    scriptRunner = makeRunner();
    agentRunner = makeRunner();
    config.loadServerConfig.mockReturnValue(serverConfig);
    config.loadConfig.mockReturnValue(scriptConfig);
    config.loadAgentConfig.mockReturnValue(agentConfig);
    config.loadSeedMap.mockReturnValue({ runId, seeds });
    createScriptRunner.mockReturnValue(scriptRunner);
    agent.createAgentRunner.mockReturnValue(agentRunner);
    createHostExecutorRunner.mockImplementation((selected: unknown) =>
      selected === scriptConfig ? scriptRunner : agentRunner);
    createExecutorHandler.mockImplementation(() => ({ close: jest.fn(), handle: jest.fn() }));
    createDynamicDelegationClient.mockReturnValue({ admit: jest.fn() });
    createProtectedAuditLog.mockReturnValue(audit);
    createRuntimeTelemetry.mockReturnValue(telemetry);
    probeStartupEnvironment.mockResolvedValue({ probes: [] });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it.each([
    [false, false, 'none', undefined],
    [true, false, 'script', 'gvisor'],
    [false, true, 'agent', 'docker'],
    [true, true, 'both', 'mixed'],
  ])('plans only enabled executors (script=%s, agent=%s)', (scriptEnabled, agentEnabled, executorKind, executorBackend) => {
    process.env.AWF_ENCLAVE_SCRIPT_ENABLED = String(scriptEnabled);
    process.env.AWF_ENCLAVE_AGENT_ENABLED = String(agentEnabled);
    process.env.AWF_ENCLAVE_AGENT_BACKEND = 'docker';
    const plan = createStartupPlan();
    expect(plan).toEqual({
      scriptEnabled, agentEnabled,
      context: { primaryBackend: 'docker', executorKind, executorBackend },
      stages: [
        'server-config', 'audit', 'seed-map', 'executors', 'executor-state',
        ...(scriptEnabled ? scriptStages : []),
        ...(agentEnabled ? agentStages : []),
        'backend-consistency', 'tool-budget', 'listener-binding', 'ready-file',
      ],
    });
  });

  it.each<[string[], string]>([
    [[], 'mixed'],
    [['docker'], 'docker'],
    [['gvisor', 'gvisor'], 'gvisor'],
    [['docker', 'cloud-hypervisor'], 'mixed'],
  ])('summarizes selected backends %j as %s', (backends, expected) => {
    expect(getExecutorBackend(backends.map(executorBackend => ({ config: { executorBackend } })))).toBe(expected);
  });

  it.each([
    ['gvisor', 'gvisor'],
    ['docker', 'docker'],
    ['cloud-hypervisor', 'gvisor'],
    ['gvisor', 'cloud-hypervisor'],
  ])('wires both executors sequentially with shared admission state (%s, %s)', async (scriptBackend, agentBackend) => {
    scriptConfig.executorBackend = scriptBackend;
    agentConfig.executorBackend = agentBackend;
    process.env.AWF_ENCLAVE_AGENT_BACKEND = agentBackend;
    await main();

    const [script, selectedAgent] = createExecutorHandler.mock.calls.map(([params]: [HandlerParams]) => params);
    expect(script).toMatchObject({
      config: scriptConfig, seedMap: seeds, runId, audit, diagnosticAudit: audit,
      runner: scriptRunner, executorKind: 'script', uniformTiming: true,
    });
    expect(selectedAgent).toMatchObject({
      config: agentConfig, seedMap: seeds, runId, runner: agentRunner,
      executorKind: 'agent', uniformTiming: true, payloadKey: 'prompt',
      workspace: agent.agentWorkspaceAdapter, exitCategories: agent.ENCLAVE_EXIT_CATEGORIES,
    });
    for (const key of ['ledger', 'lane', 'clock', 'telemetry', 'audit', 'diagnosticAudit']) {
      expect(selectedAgent[key]).toBe(script[key]);
    }
    expect(script).not.toHaveProperty('workspace');
    expect(script).not.toHaveProperty('admission');
    expect(agent.createAgentRequestValidator).toHaveBeenCalledWith(5678, {
      githubEnabled: true, dynamicEnabled: false,
    });
    expect(createScriptRunner).toHaveBeenCalledTimes(scriptBackend === 'gvisor' ? 1 : 0);
    expect(agent.createAgentRunner).toHaveBeenCalledTimes(agentBackend === 'gvisor' ? 1 : 0);
    for (const [selected, deps] of createHostExecutorRunner.mock.calls) {
      expect(deps).toEqual({ nowMs: script.clock.nowMs, audit });
      expect([scriptConfig, agentConfig]).toContain(selected);
    }
    expect(scriptRunner.reconcileRun).toHaveBeenCalledWith(runId);
    expect(agentRunner.reconcileRun).toHaveBeenCalledWith(runId);
    expect(records.map(({ stage, status }) => [stage, status])).toEqual(
      ['environment-probes', ...createStartupPlan().stages].flatMap(stage => [
        [stage, 'started'], [stage, 'passed'],
      ]),
    );
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer.mock.results[0].value.listen).toHaveBeenCalledWith(8080, '127.0.0.1', expect.any(Function));
    expect(fs.statSync(String(serverConfig.readyPath)).mode & 0o777).toBe(0o600);
    expect(telemetry.emit).toHaveBeenCalledWith(expect.objectContaining({
      category: 'ready', executorBackend: scriptBackend === agentBackend ? scriptBackend : 'mixed',
    }));
  });

  it('does not load or register the agent executor in script-only runs', async () => {
    process.env.AWF_ENCLAVE_AGENT_ENABLED = 'false';
    await main();
    expect(config.loadAgentConfig).not.toHaveBeenCalled();
    expect(createExecutorHandler).toHaveBeenCalledTimes(1);
    expect(createExecutorHandler.mock.calls[0][0].executorKind).toBe('script');
    expect(records.some(({ stage }) => agentStages.includes(stage))).toBe(false);
  });

  it.each([false, true])('keeps dynamic admission on its owning side (hostOwned=%s)', async (hostOwned) => {
    process.env.AWF_ENCLAVE_SCRIPT_ENABLED = 'false';
    serverConfig.seedMapEnabled = false;
    agentConfig.dynamicEnabled = true;
    agentRunner.hostOwned = hostOwned;
    if (hostOwned) agentConfig.executorBackend = 'docker';
    await main();
    expect(config.loadSeedMap).not.toHaveBeenCalled();
    expect(config.loadConfig).not.toHaveBeenCalled();
    expect(config.loadAgentConfig).toHaveBeenCalledWith(serverConfig);
    expect(createExecutorHandler).toHaveBeenCalledTimes(1);
    const params = createExecutorHandler.mock.calls[0][0];
    expect(params.seedMap.size).toBe(0);
    expect(params.executorKind).toBe('agent');
    expect(createDynamicDelegationClient).toHaveBeenCalledTimes(hostOwned ? 0 : 1);
    if (hostOwned) expect(params).not.toHaveProperty('admission');
    else expect(params.admission).toBe(createDynamicDelegationClient.mock.results[0].value);
    expect(agent.createAgentRequestValidator).toHaveBeenCalledWith(5678, {
      githubEnabled: true, dynamicEnabled: true,
    });
    expect(records.some(({ stage }) => scriptStages.includes(stage))).toBe(false);
  });

  describe.each(['script', 'agent'])('%s executor startup failures', (kind) => {
    it.each([
      ['config', 'config-invalid'],
      ['selection', 'runner-initialization-failed'],
      ['available', 'availability-failed'],
      ['reconcile', 'reconciliation-failed'],
      ['handler', 'handler-construction-failed'],
    ])('stops at %s without binding the listener or publishing readiness', async (step, reason) => {
      const error = new Error('startup fixture failure');
      const runner = kind === 'script' ? scriptRunner : agentRunner;
      process.env.AWF_ENCLAVE_SCRIPT_ENABLED = String(kind === 'script');
      process.env.AWF_ENCLAVE_AGENT_ENABLED = String(kind === 'agent');
      const operations: Record<string, jest.Mock> = {
        config: kind === 'script' ? config.loadConfig : config.loadAgentConfig,
        selection: kind === 'script' ? createScriptRunner : agent.createAgentRunner,
        available: runner.assertAvailable,
        reconcile: runner.reconcileRun,
        handler: createExecutorHandler,
      };
      operations[step].mockImplementationOnce(() => { throw error; });
      await expect(main()).rejects.toBe(error);
      expect(records[records.length - 1]).toMatchObject({
        stage: `${kind}-${step}`, status: 'failed', executorKind: kind, reasonId: `${kind}-${reason}`,
      });
      expect(createServer).not.toHaveBeenCalled();
      expect(fs.existsSync(String(serverConfig.readyPath))).toBe(false);
    });
  });

  it('rejects startup with no enabled executors', async () => {
    process.env.AWF_ENCLAVE_SCRIPT_ENABLED = 'false';
    process.env.AWF_ENCLAVE_AGENT_ENABLED = 'false';
    await expect(main()).rejects.toThrow('No enclave executor is enabled');
    expect(records[records.length - 1]).toMatchObject({ stage: 'executors', status: 'failed' });
    expect(createExecutorHandler).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('rejects a primary backend mismatch before listener binding', async () => {
    agentConfig.primaryBackend = 'gvisor';
    await expect(main()).rejects.toThrow('Executor primary backend differs from server configuration');
    expect(records[records.length - 1]).toMatchObject({
      stage: 'backend-consistency', status: 'failed', reasonId: 'backend-consistency-failed',
    });
    expect(createServer).not.toHaveBeenCalled();
    expect(fs.existsSync(String(serverConfig.readyPath))).toBe(false);
  });

  it('closes both handlers and drains the shared lane before reconciling shutdown once', async () => {
    await main();
    const [script, selectedAgent] = createExecutorHandler.mock.calls.map(([params]: [HandlerParams]) => params);
    expect(script.lane).toBe(selectedAgent.lane);
    let drain!: () => void;
    script.lane.tail = new Promise<void>(resolve => { drain = resolve; });
    const shutdown = jest.mocked(process.on).mock.calls.find(([signal]) => signal === 'SIGTERM')![1];
    expect(jest.mocked(process.on).mock.calls.find(([signal]) => signal === 'SIGINT')![1]).toBe(shutdown);
    const stopping = shutdown();
    await shutdown();
    for (const { value: handler } of createExecutorHandler.mock.results) {
      expect(handler.close).toHaveBeenCalledTimes(1);
    }
    expect(createServer.mock.results[0].value.close).toHaveBeenCalledTimes(1);
    expect(scriptRunner.reconcileRun).toHaveBeenCalledTimes(1);
    expect(agentRunner.reconcileRun).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(String(serverConfig.readyPath))).toBe(true);
    drain();
    await stopping;
    expect(scriptRunner.reconcileRun).toHaveBeenCalledTimes(2);
    expect(agentRunner.reconcileRun).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(String(serverConfig.readyPath))).toBe(false);
    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
