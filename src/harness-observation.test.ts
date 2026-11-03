import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { identity } from './model-information-contract/identity';
import { createEligibilityStore, HarnessRequirement, EligibilitySnapshot } from './model-information-contract/eligibility';
import {
  selectHarness, probeCommand, parseProbe, validateObservation, eligibilityEvidence,
  HarnessObservationReport,
} from './model-information-contract/harness-observation';
import {
  harnessContext, harnessProxyEnvironment, observeHarness, prepareHarnessObservation,
} from './harness-observation';
import type { WrapperConfig } from './types';
import { runMainWorkflow, WorkflowDependencies } from './cli-workflow';
import { validateCopilotModel } from './copilot-model';
import * as copilotModels from './copilot-model';
import { validateCopilotModelOption } from './commands/validators/api-proxy-validator';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pinHarnessObservation } = require('../containers/api-proxy/harness-observation') as {
  pinHarnessObservation(snapshot: EligibilitySnapshot): EligibilitySnapshot;
};

const scope = { provider: 'copilot', channel: 'copilot-api', deployment: 'fixture' };
const model = identity('copilot', 'gpt-6-sol');
const requirement: HarnessRequirement = {
  scope, name: 'copilot-cli', minimum: '1.2.0', scheme: 'semver',
  reason: 'Fixture protocol requirement', provenance: { authority: 'maintained' },
};
const input = {
  identity: model, scope, discovery: { status: 'available' as const, authoritative: true },
};
const context = { environment: 'guest:fixture', name: 'copilot-cli', binary: 'copilot' };
const result = (version = '1.2.3') => ({ exitCode: 0, stdout: `/guest/bin/copilot\n${version}\nCommit fixture\n` });

describe('actual-environment harness observations', () => {
  let directory: string;
  let config: WrapperConfig;
  const savedEnv = { ...process.env };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-harness-test-'));
    fs.mkdirSync(path.join(directory, 'api-proxy-logs'));
    config = {
      workDir: directory, agentCommand: 'copilot --model gpt-6-sol',
      containerRuntime: 'cloud-hypervisor', enableApiProxy: true,
      allowedDomains: [], logLevel: 'error', keepContainers: false,
    };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ['AWF_HARNESS_ENVIRONMENT', 'AWF_SELECTED_HARNESS', 'AWF_HARNESS_BINARY']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function report(): HarnessObservationReport {
    return JSON.parse(fs.readFileSync(path.join(directory, 'api-proxy-logs/harness-observation.json'), 'utf8'));
  }
  function connectProxy() {
    Object.assign(process.env, harnessProxyEnvironment(config));
    const open = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation((filename, flags, mode) =>
      open(filename === '/var/log/api-proxy/harness-observation.json'
        ? path.join(directory, 'api-proxy-logs/harness-observation.json') : filename, flags, mode));
  }
  function store(harnesses = [requirement]) {
    return createEligibilityStore({ models: [{ identity: model, harnesses }] });
  }

  it.each([
    ['copilot --model x', 'copilot-cli', 'copilot'],
    ['/tools/claude -p "hello"', 'claude-code', '/tools/claude'],
    ['./codex exec hello', 'codex-cli', './codex'],
  ])('binds only a direct selected executable: %s', (command, name, binary) => {
    expect(selectHarness(command)).toEqual({ name, binary });
  });
  it.each([
    'bash -c copilot', 'env FOO=bar copilot', 'cd /other && copilot', 'copilot | tee x',
    'copilot; codex', '"copilot" --help', '$ENGINE --help', 'echo copilot', 'copilot\ncodex',
    'copilot $(echo x)', 'COPILOT_MODEL=x copilot',
  ])('does not infer an opaque selected executable: %s', command => {
    expect(selectHarness(command)).toBeUndefined();
  });
  it.each([
    ['copilot', 'copilot-cli', 'GitHub Copilot CLI v1.2.3', '1.2.3'],
    ['claude', 'claude-code', '2.1.3 (Claude Code)', '2.1.3'],
    ['codex', 'codex-cli', 'codex-cli 0.89.0', '0.89.0'],
    ['copilot', 'copilot-cli', '1.2.3-rc.2+fixture', '1.2.3-rc.2+fixture'],
  ])('parses bounded %s version output without retaining metadata', (binary, name, output, version) => {
    expect(parseProbe({ ...context, name, binary }, {
      exitCode: 0, stdout: `/tools/${binary}\n${output}\nsecret=discarded`,
    })).toEqual({
      ...context, name, binary, resolvedBinary: `/tools/${binary}`, status: 'observed', version,
    });
  });
  it.each([
    [{ stdout: '', exitCode: 127 }, 'binary_missing'],
    [{ stdout: 'token=do-not-disclose', exitCode: 1 }, 'probe_failed'],
    [{ ...result(), timedOut: true }, 'probe_timed_out'],
    [{ ...result(), overflow: true }, 'probe_output_limit'],
    [{ stdout: 'x'.repeat(4097), exitCode: 0 }, 'probe_output_limit'],
    [{ stdout: '/guest/copilot\n1.2\n', exitCode: 0 }, 'probe_output_invalid'],
    [{ stdout: '/guest/codex\n1.2.3\n', exitCode: 0 }, 'probe_output_invalid'],
    [{ stdout: '/guest/copilot\nBearer credential\n', exitCode: 0 }, 'probe_output_invalid'],
  ])('classifies invalid probes without raw error disclosure', (probe, reason) => {
    expect(parseProbe(context, probe)).toEqual({ ...context, status: 'unavailable', reason });
  });

  it('executes a deterministic --version fixture using the selected PATH, not the host-installed harness', async () => {
    const binary = path.join(directory, 'copilot');
    fs.writeFileSync(binary, '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf "1.2.3\\n"\n', { mode: 0o700 });
    const selected = selectHarness(`${binary} --model ignored`)!;
    const executed = await execa('/bin/sh', ['-c', probeCommand(selected)], { timeout: 1000 });
    const observed = parseProbe({ ...context, ...selected }, executed);
    expect(observed).toMatchObject({ status: 'observed', version: '1.2.3', resolvedBinary: binary });
  });

  it('rejects path substitutions, contradictory evidence and changes to the pinned selection', async () => {
    expect(parseProbe({ ...context, binary: '/selected/copilot' }, result())).toMatchObject({
      status: 'unavailable', reason: 'probe_output_invalid',
    });
    const observed = parseProbe(context, result());
    expect(validateObservation({ ...observed, verified: false }, context)).toMatchObject({
      status: 'unavailable', reason: 'observation_invalid',
    });
    expect(validateObservation({ ...observed, reason: 'probe_failed' }, context)).toMatchObject({
      status: 'unavailable', reason: 'observation_invalid',
    });
    prepareHarnessObservation(config);
    config.agentCommand = '/other/copilot --model x';
    const probe = jest.fn().mockResolvedValue(result());
    expect(await observeHarness(config, probe)).toMatchObject({
      status: 'unavailable', reason: 'selection_unavailable',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('wires ready-backend output through the atomic file to immutable scoped proxy eligibility pins', async () => {
    prepareHarnessObservation(config);
    connectProxy();
    const evidence = store();
    const before = pinHarnessObservation(evidence.pin());
    expect(before.evaluate(input)).toMatchObject({ admitted: false, harness: 'unverified' });
    expect(before.evaluate(input).reasons[0].observationReason).toBe('probe_pending');
    const probe = jest.fn().mockResolvedValue(result());
    await observeHarness(config, probe);
    expect(probe).toHaveBeenCalledWith(probeCommand({ name: 'copilot-cli', binary: 'copilot' }));
    expect(report()).toMatchObject({ ...harnessContext(config), status: 'observed', version: '1.2.3' });
    const pinned = pinHarnessObservation(evidence.pin());
    expect(pinned.evaluate(input)).toMatchObject({ admitted: true, harness: 'compatible' });
    expect(pinned.evaluate(input).scope).toEqual(scope);
    await observeHarness(config, jest.fn().mockResolvedValue(result('1.0.0')));
    expect(pinHarnessObservation(evidence.pin()).evaluate(input)).toMatchObject({
      admitted: false, harness: 'incompatible',
    });
    expect(pinned.evaluate(input)).toMatchObject({ admitted: true, harness: 'compatible' });
    expect(before.evaluate(input)).toMatchObject({ admitted: false, harness: 'unverified' });
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.evaluate(input))).toBe(true);
    expect(fs.readdirSync(path.join(directory, 'api-proxy-logs'))).toEqual(['harness-observation.json']);
  });

  it.each(['missing', 'malformed', 'environment', 'harness', 'binary', 'oversized'] as const)(
    'keeps %s evidence explicitly unverified', async failure => {
      prepareHarnessObservation(config);
      connectProxy();
      await observeHarness(config, jest.fn().mockResolvedValue(result()));
      const filename = path.join(directory, 'api-proxy-logs/harness-observation.json');
      const changed = report();
      if (failure === 'missing') fs.unlinkSync(filename);
      else if (failure === 'malformed') fs.writeFileSync(filename, '{invalid');
      else if (failure === 'oversized') fs.writeFileSync(filename, 'x'.repeat(4097));
      else fs.writeFileSync(filename, JSON.stringify({
        ...changed, [failure === 'harness' ? 'name' : failure]: 'wrong',
      }));
      const decision = pinHarnessObservation(store().pin()).evaluate(input);
      expect(decision).toMatchObject({ admitted: false, harness: 'unverified' });
      expect(decision.reasons[0].observationReason).toMatch(/^observation_/);
      expect(pinHarnessObservation(store([]).pin()).evaluate(input)).toMatchObject({
        admitted: true, harness: 'unconstrained',
      });
    },
  );
  it.each(['runc', 'gvisor', 'kata', 'nvx'])('never substitutes the host version for unsupported %s probes', async runtime => {
    config.containerRuntime = runtime;
    prepareHarnessObservation(config);
    expect(report()).toMatchObject({ status: 'unavailable', reason: 'runtime_probe_unsupported' });
    expect(await observeHarness(config)).toMatchObject({ status: 'unavailable', reason: 'runtime_probe_unsupported' });
  });
  it('records probe exceptions without credentials and leaves unconstrained admission unchanged', async () => {
    await observeHarness(config, async () => { throw new Error('Bearer do-not-disclose'); });
    expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
    expect(JSON.stringify(report())).not.toContain('do-not-disclose');
    expect(validateCopilotModel('gpt-6-sol', eligibilityEvidence(report(), {
      provider: 'copilot', channel: 'copilot-cli',
    }))).toMatchObject({ valid: true });
  });
  it('feeds actual observations into host CLI constraints without enabling a bundled floor', async () => {
    const cliScope = { provider: 'copilot', channel: 'copilot-cli' };
    const cliEvidence = (value: HarnessObservationReport) => ({
      ...eligibilityEvidence(value, cliScope),
      harnesses: [{ ...requirement, scope: cliScope }],
    });
    const observed = await observeHarness(config, jest.fn().mockResolvedValue(result()));
    expect(validateCopilotModel('gpt-6-sol', cliEvidence(observed))).toMatchObject({ valid: true });
    const failed = await observeHarness(config, jest.fn().mockResolvedValue({ exitCode: 127, stdout: '' }));
    expect(validateCopilotModel('gpt-6-sol', cliEvidence(failed))).toMatchObject({
      valid: false, message: expect.stringContaining('observation=binary_missing'),
    });
    expect(validateCopilotModel('gpt-6-sol', eligibilityEvidence(failed, cliScope))).toMatchObject({ valid: true });
  });
  it.each(['sbx', 'cloud-hypervisor'])('defers only pending host harness checks until %s is ready, then enforces the real report', async runtime => {
    config.containerRuntime = runtime;
    config.copilotGithubToken = 'fixture-token';
    config.additionalEnv = { COPILOT_MODEL: 'gpt-6-sol' };
    const actualValidation = copilotModels.validateCopilotModel;
    jest.spyOn(copilotModels, 'validateCopilotModel').mockImplementation((model, evidence) =>
      actualValidation(model, {
        ...evidence,
        harnesses: [{ ...requirement, scope: { provider: 'copilot', channel: 'copilot-cli' } }],
      }));
    validateCopilotModelOption(config, {
      additionalEnv: config.additionalEnv, volumeMounts: undefined, allowedUrls: undefined,
    });
    expect(config.additionalEnv.COPILOT_MODEL).toBe('gpt-6-sol');
    await expect(observeHarness(config, jest.fn().mockResolvedValue(result()))).resolves
      .toMatchObject({ status: 'observed' });
    await expect(observeHarness(config, jest.fn().mockResolvedValue(result('1.0.0')))).rejects
      .toThrow('harness_incompatible');
    await expect(observeHarness(config, jest.fn().mockResolvedValue({ exitCode: 127, stdout: '' }))).rejects
      .toThrow('observation=binary_missing');
  });
  it('does not impose the first alias candidate floor on a later eligible runtime sibling', async () => {
    config.copilotGithubToken = 'fixture-token';
    config.additionalEnv = { COPILOT_MODEL: 'coding' };
    config.modelAliases = { coding: ['gpt-6-sol', 'gpt-5.3-codex'] };
    const actualValidation = copilotModels.validateCopilotModel;
    jest.spyOn(copilotModels, 'validateCopilotModel').mockImplementation((model, evidence) =>
      actualValidation(model, {
        ...evidence,
        harnesses: [{ ...requirement, scope: { provider: 'copilot', channel: 'copilot-cli' } }],
      }));
    validateCopilotModelOption(config, {
      additionalEnv: config.additionalEnv, volumeMounts: undefined, allowedUrls: undefined,
    });
    await expect(observeHarness(config)).resolves.toMatchObject({ status: 'unavailable' });
    expect(config.additionalEnv.COPILOT_MODEL).toBe('coding');
  });
  it('preserves policy, lifecycle, exact scope and excluded/prerelease comparison semantics', () => {
    const observed = parseProbe(context, result('1.3.0-rc.1'));
    const evidence = eligibilityEvidence(observed, scope);
    const pinned = store([{ ...requirement, minimum: '1.3.0' }]).pin();
    expect(pinned.evaluate({ ...input, ...evidence })).toMatchObject({ admitted: false, harness: 'incompatible' });
    const compatible = store().pin();
    expect(compatible.evaluate({ ...input, ...evidence, policy: { status: 'deny' } }).admitted).toBe(false);
    expect(compatible.evaluate({ ...input, ...evidence, lifecycle: { status: 'retired' } }).admitted).toBe(false);
    expect(compatible.evaluate({ ...input, ...evidence, scope: { ...scope, deployment: 'other' } }).harness)
      .toBe('unconstrained');
    const excluded = store([{ ...requirement, excludedRanges: ['>=1.3.0-rc.1 <1.3.0'] }]).pin();
    expect(excluded.evaluate({ ...input, ...evidence }).admitted).toBe(false);
    expect(validateObservation({ ...observed, environment: 'host' }, context)).toMatchObject({
      status: 'unavailable', reason: 'observation_environment_mismatch',
    });
  });
  it('runs observation after backend readiness and before agent execution, without changing exit/cleanup', async () => {
    const order: string[] = [];
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn(), setupHostIptables: jest.fn(),
      writeConfigs: async () => { prepareHarnessObservation(config); order.push('config'); },
      startContainers: async () => { order.push('ready'); },
      probeHarness: async () => { order.push('observe'); return result(); },
      runAgentCommand: async () => {
        order.push('agent');
        expect(report()).toMatchObject({ status: 'observed', version: '1.2.3' });
        return { exitCode: 23 };
      },
    };
    config.networkIsolation = true;
    const code = await runMainWorkflow(config, dependencies, {
      logger: { info: jest.fn(), warn: jest.fn(), success: jest.fn() },
      performCleanup: async () => { order.push('cleanup'); },
    });
    expect(code).toBe(23);
    expect(order).toEqual(['config', 'ready', 'observe', 'agent', 'cleanup']);
  });
});
