/* eslint-disable @typescript-eslint/no-require-imports */
const { createExecutorInvocationAdmission } = require('../../containers/enclave/script-executor/executor-invocation-admission');
const { createExecutorInvocationExecution } = require('../../containers/enclave/script-executor/executor-invocation-execution');
const { createExecutorInvocationTiming } = require('../../containers/enclave/script-executor/executor-invocation-timing');
const { validateEnclaveScriptRequest, TIMING_BUCKETS_MS } = require('../../containers/bounded-execution/finite-disclosure');
const { createEnclaveInformationBudgetLedger } = require('../../containers/bounded-execution/sensitivity-ledger');
/* eslint-enable @typescript-eslint/no-require-imports */

const request = { privateRepo: 'Octo/Private', schema: { type: 'boolean' }, script: 'private script' };

describe('executor invocation admission without a sandbox', () => {
  function fixture(sensitivity = 'confidential') {
    const seedMap = new Map([['octo/private', { seedId: 'seed', sensitivity }]]);
    const ledger = createEnclaveInformationBudgetLedger(seedMap);
    const debit = jest.spyOn(ledger, 'tryDebit');
    const register = jest.spyOn(ledger, 'registerRepository');
    const reject = jest.fn(async (_reason: string, _detail?: string) => undefined);
    const markAdmitted = jest.fn();
    const settleDynamic = jest.fn(async () => ({ revoked: true }));
    const params = {
      config: {}, seedMap, runner: {}, ledger, executorKind: 'script',
      validateRequest: validateEnclaveScriptRequest, payloadKey: 'script', markAdmitted, settleDynamic,
    };
    const create = (overrides = {}) => createExecutorInvocationAdmission({ ...params, ...overrides });
    return { create, ledger, debit, register, reject, markAdmitted, settleDynamic };
  }

  it('rejects invalid requests and unknown repositories before charging', async () => {
    const f = fixture();
    const admit = f.create();
    expect(await admit({}, 'invalid', f.reject)).toBeUndefined();
    expect(await admit({ ...request, privateRepo: 'octo/unknown' }, 'unknown', f.reject)).toBeUndefined();
    expect(f.reject.mock.calls).toEqual([
      ['invalid-request', expect.any(String)],
      ['repo-not-allowed', 'octo/unknown'],
    ]);
    expect(f.debit).not.toHaveBeenCalled();
  });

  it('normalizes seed lookup and debits each schema without refilling a spent budget', async () => {
    const f = fixture();
    const admit = f.create();
    expect(await admit(request, 'first', f.reject)).toEqual({
      privateRepo: 'Octo/Private', repoKey: 'octo/private', schema: request.schema,
      payload: request.script, seed: { seedId: 'seed', sensitivity: 'confidential' },
      admitted: undefined, charge: 6,
    });
    expect(f.debit).toHaveBeenCalledWith('octo/private', 6, 'script');
    expect(f.ledger.remainingBits('octo/private')).toBe(2);
    expect(await admit(request, 'second', f.reject)).toBeUndefined();
    expect(f.reject).toHaveBeenCalledWith('bit-budget-exhausted', 'repo=Octo/Private charge=6');
    expect(f.ledger.remainingBits('octo/private')).toBe(2);
  });

  it.each(['confidential', 'trusted'])('allows freeform output only for sensitivity=%s', async sensitivity => {
    const f = fixture(sensitivity);
    const result = await f.create()({ ...request, schema: { type: 'string' } }, 'id', f.reject);
    if (sensitivity === 'trusted') {
      expect(result.charge).toBe(0);
      expect(f.debit).toHaveBeenCalledWith('octo/private', 0, 'script');
    } else {
      expect(result).toBeUndefined();
      expect(f.reject).toHaveBeenCalledWith('trusted-schema-required', 'repo=Octo/Private sensitivity=confidential');
      expect(f.debit).not.toHaveBeenCalled();
    }
  });

  it('reserves host-owned dynamic disclosure without consulting the seed catalog', async () => {
    const f = fixture();
    const admit = f.create({
      seedMap: new Map(), runner: { hostOwned: true },
      config: { dynamicEnabled: true, dynamicSensitivity: 'internal' }, executorKind: 'agent',
    });
    const result = await admit({ ...request, privateRepo: 'Octo/Dynamic' }, 'id', f.reject);
    expect(result.seed).toEqual({ seedId: undefined, sensitivity: 'internal' });
    expect(f.register).toHaveBeenCalledWith('octo/dynamic', 'internal');
    expect(f.debit).toHaveBeenCalledWith('octo/dynamic', 6, 'agent');
    expect(f.register.mock.invocationCallOrder[0]).toBeLessThan(f.debit.mock.invocationCallOrder[0]);
  });

  it('charges the admitted repository and marks its identity before registering the ledger', async () => {
    const f = fixture();
    const admitted = {
      admitted: true, repo: 'octo/resolved', sensitivity: 'internal',
      executorBearer: 'fixture-bearer', readMode: 'live',
    };
    const admission = { admit: jest.fn(async () => admitted) };
    const result = await f.create({ admission })(request, 'id', f.reject);
    expect(admission.admit).toHaveBeenCalledWith({ invocationId: 'id', selector: request.privateRepo, schema: request.schema });
    expect(result.admitted).toBe(admitted);
    expect(f.markAdmitted).toHaveBeenCalledWith('id');
    expect(f.register).toHaveBeenCalledWith('octo/resolved', 'internal');
    expect(f.debit).toHaveBeenCalledWith('octo/resolved', 6, 'script');
    expect(f.markAdmitted.mock.invocationCallOrder[0]).toBeLessThan(f.register.mock.invocationCallOrder[0]);
    expect(f.register.mock.invocationCallOrder[0]).toBeLessThan(f.debit.mock.invocationCallOrder[0]);
  });

  it.each([
    [undefined, 'dynamic-admission-denied', undefined],
    [{ admitted: true, repo: 'octo/resolved', sensitivity: 'invalid' }, 'dynamic-sensitivity-invalid', 'broker-error'],
    [{ admitted: true, repo: 'octo/resolved', sensitivity: 'confidential' }, 'bit-budget-exhausted', 'broker-error'],
  ])('settles only admitted identities on rejection %s', async (admitted, reason, outcome) => {
    const f = fixture();
    f.debit.mockReturnValue(false);
    const admission = { admit: async () => admitted };
    expect(await f.create({ admission })(request, 'id', f.reject)).toBeUndefined();
    expect(f.reject.mock.calls[0][0]).toBe(reason);
    if (outcome) {
      expect(f.settleDynamic).toHaveBeenCalledWith('id', outcome, 0, 0);
      expect(f.settleDynamic.mock.invocationCallOrder[0]).toBeLessThan(f.reject.mock.invocationCallOrder[0]);
    } else {
      expect(f.markAdmitted).not.toHaveBeenCalled();
      expect(f.register).not.toHaveBeenCalled();
      expect(f.settleDynamic).not.toHaveBeenCalled();
    }
  });
});

describe('executor invocation execution and cleanup', () => {
  function fixture() {
    const layout = { outPath: 'private-output' };
    const workspace = {
      createInvocationWorkspace: jest.fn(() => layout),
      readQueryOutput: jest.fn(() => 'true'),
      preserveInvocationArtifacts: jest.fn(),
    };
    const runner = { hostOwned: false, runInvocation: jest.fn(async () => ({ exitCode: 0, timedOut: false })) };
    const safeDestroy = jest.fn(() => true);
    const settleDynamic = jest.fn(async () => ({ revoked: true }));
    const state = { accepting: true };
    const lane = { closed: false };
    const execute = createExecutorInvocationExecution({
      config: { timeoutSeconds: 30, maxOutputBytes: 8192 }, runId: 'run', audit: { failure: jest.fn() },
      workspace, runner, clock: { nowMs: () => 0 }, executorKind: 'script', payloadKey: 'script',
      exitCategories: {}, state, lane, timing: jest.fn(), diagnosticReason: () => 'none',
      safeDestroy, settleDynamic,
    });
    const invocation = {
      repoKey: 'octo/private', schema: request.schema, payload: request.script, seed: { seedId: 'seed' },
    };
    return { execute, invocation, workspace, runner, safeDestroy, settleDynamic, state, lane };
  }

  it('forwards the workspace and runner arguments and preserves artifacts before destruction', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.execute(f.invocation, 'id', signal, 0)).toEqual({
      canonicalResult: 'true', failureReason: undefined, cleanupFailed: false,
    });
    expect(f.workspace.createInvocationWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run', invocationId: 'id', privateRepo: 'octo/private', seedId: 'seed',
      schema: request.schema, script: request.script,
    }));
    expect(f.runner.runInvocation).toHaveBeenCalledWith({
      runId: 'run', invocationId: 'id', seedId: 'seed', deadlineMs: 30_000, signal,
    });
    expect(f.workspace.preserveInvocationArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(f.safeDestroy.mock.invocationCallOrder[0]);
    expect(f.safeDestroy).toHaveBeenCalledWith('id');
  });

  it('destroys partially created workspaces after creation throws', async () => {
    const f = fixture();
    f.workspace.createInvocationWorkspace.mockImplementation(() => { throw new Error('partial workspace'); });
    expect(await f.execute(f.invocation, 'id', undefined, 0)).toEqual({
      canonicalResult: undefined, failureReason: ['workspace-create-failed', 'partial workspace'], cleanupFailed: false,
    });
    expect(f.runner.runInvocation).not.toHaveBeenCalled();
    expect(f.workspace.preserveInvocationArtifacts).not.toHaveBeenCalled();
    expect(f.safeDestroy).toHaveBeenCalledWith('id');
  });

  it.each(['artifacts', 'destroy', 'revocation'])('downgrades success on %s failure before responding', async failure => {
    const f = fixture();
    const admitted = { repo: 'octo/resolved', executorBearer: 'fixture-bearer', readMode: 'live' };
    if (failure === 'artifacts') {
      f.workspace.preserveInvocationArtifacts.mockImplementation(() => { throw new Error('preserve failed'); });
    }
    if (failure === 'destroy') f.safeDestroy.mockReturnValue(false);
    if (failure === 'revocation') f.settleDynamic.mockResolvedValue({ revoked: false });
    const result = await f.execute({ ...f.invocation, admitted }, 'id', undefined, 0);
    expect(result.canonicalResult).toBeUndefined();
    expect(result.cleanupFailed).toBe(true);
    expect(f.settleDynamic).toHaveBeenCalledWith(
      'id', failure === 'revocation' ? 'success' : 'broker-error', failure === 'revocation' ? 4 : 0, 0,
    );
    expect(f.safeDestroy.mock.invocationCallOrder[0]).toBeLessThan(f.settleDynamic.mock.invocationCallOrder[0]);
    expect(f.workspace.createInvocationWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      privateRepo: admitted.repo, executorBearer: admitted.executorBearer, readMode: admitted.readMode,
    }));
    expect(f.runner.runInvocation).toHaveBeenCalledWith(expect.objectContaining({
      binding: { repository: admitted.repo, readMode: admitted.readMode },
    }));
  });

  it.each([false, true])('closes the lane on launch failure only for hostOwned=%s', async hostOwned => {
    const f = fixture();
    f.runner.hostOwned = hostOwned;
    f.runner.runInvocation.mockRejectedValue(new Error('launch failed'));
    const result = await f.execute(f.invocation, 'id', undefined, 0);
    expect(result.failureReason).toEqual(['launch-failed', 'launch failed']);
    expect(f.state.accepting).toBe(!hostOwned);
    expect(f.lane.closed).toBe(hostOwned);
    expect(f.safeDestroy).toHaveBeenCalledWith('id');
  });
});

describe('executor invocation response timing without a sandbox', () => {
  function fixture(uniformTiming = true) {
    let now = 0;
    const clock = { nowMs: () => now, sleep: jest.fn(async (ms: number) => { now += ms; }) };
    const respond = jest.fn();
    const audit = { failure: jest.fn(), invocation: jest.fn() };
    const timing = jest.fn();
    const emitInvocationTelemetry = jest.fn();
    const response = createExecutorInvocationTiming({
      audit, clock, uniformTiming, responseJitterSource: () => 17, timing,
      diagnosticReason: (failure?: string[]) => failure?.[0] ?? 'none', emitInvocationTelemetry,
    })(respond, 'id');
    const invocation = { privateRepo: request.privateRepo, seed: { sensitivity: 'internal' }, charge: 6 };
    return { response, invocation, respond, audit, timing, emitInvocationTelemetry, clock,
      advance: (ms: number) => { now += ms; }, now: () => now };
  }

  it.each([false, true])('preserves admission rejection timing for uniformTiming=%s', async uniformTiming => {
    const f = fixture(uniformTiming);
    f.advance(30);
    await f.response.rejectBeforeExecution('invalid-request', 'protected detail');
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(f.respond).toHaveBeenCalledWith('{"status":"error"}');
    expect(f.now()).toBe(uniformTiming ? 117 : 30);
    expect(f.audit.failure).toHaveBeenCalledWith('id', 'invalid-request', 'protected detail');
  });

  it('pads through the cleanup-selected bucket plus jitter before emitting canonical success', async () => {
    const f = fixture();
    f.advance(60_001);
    await f.response.completeResponse(f.invocation, 0, { canonicalResult: 'true', cleanupFailed: false });
    expect(f.clock.sleep.mock.calls).toEqual([[59_999], [17]]);
    expect(f.now()).toBe(120_017);
    expect(f.respond).toHaveBeenCalledWith('{"status":"ok","result":true}');
    expect(f.audit.invocation).toHaveBeenCalledWith({
      invocationId: 'id', repo: request.privateRepo, sensitivity: 'internal', bits: 6, bucketMs: 120_000,
    });
    expect(f.timing.mock.calls.map(call => call[2].phase)).toEqual([
      'cleanup-complete', 'bucket-selected', 'padding-start', 'padding-wake',
      'jitter-start', 'padding-complete', 'response',
    ]);
  });

  it('fails closed on processing overflow and never emits an unbucketed successful result', async () => {
    const f = fixture();
    f.advance(TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] + 1);
    await f.response.completeResponse(f.invocation, 0, { canonicalResult: 'true', cleanupFailed: false });
    expect(f.clock.sleep).not.toHaveBeenCalled();
    expect(f.respond).toHaveBeenCalledWith('{"status":"error"}');
    expect(f.audit.invocation).not.toHaveBeenCalled();
    expect(f.audit.failure).toHaveBeenCalledWith('id', 'timing-bucket-overflow', undefined);
    expect(f.emitInvocationTelemetry).toHaveBeenCalledWith('timing-bucket-overflow');
  });
});
