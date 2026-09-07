import {
  CANONICAL_DENIAL_REASON,
  DynamicRepositoryRegistry,
  DynamicUsageAccountingError,
  isCanonicalDynamicSelector,
  resolveDenialTimingBucketMs,
  type DynamicAdmissionClock,
  type DynamicRepositoryRegistryOptions,
} from './dynamic-registry';
import { createEnclaveInformationBudgetLedger } from './information-budget';
import { TIMING_BUCKETS_MS } from '../bounded-execution';
import type { EnclaveDynamicPolicy } from '../types/enclave-options';

function policy(overrides: Partial<EnclaveDynamicPolicy> = {}): EnclaveDynamicPolicy {
  return {
    allowedOwners: ['octo-org'],
    allowedRepositories: ['other-org/exact-repo'],
    sensitivity: 'confidential',
    executor: 'agent',
    githubPolicy: { version: 'github-repository-read-v1', tools: ['list_issues', 'issue_read'] },
    maxRepositories: 2,
    limits: {
      timeoutSeconds: 120,
      memoryLimit: '1g',
      cpuLimit: '1',
      pidsLimit: 128,
      tmpfsLimit: '256m',
      maxOutputBytes: 8192,
      maxTaskBytes: 4096,
      maxModelRequests: 8,
      maxModelTokens: 4096,
    },
    quotas: { maxInvocations: 3, maxOutputBytes: 1_000_000, maxExecutionSeconds: 3600 },
    auditLabels: ['awf-enclave-dynamic'],
    expiresAt: '2999-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Deterministic clock: `sleep` advances virtual time instantly, so timing
 * normalization is asserted exactly instead of raced against real timers.
 */
function fakeClock(): DynamicAdmissionClock & { elapsed: number; sleeps: number[] } {
  const clock = {
    elapsed: 0,
    sleeps: [] as number[],
    nowMs(): number {
      return clock.elapsed;
    },
    async sleep(ms: number): Promise<void> {
      clock.sleeps.push(ms);
      clock.elapsed += ms;
    },
  };
  return clock;
}

function registry(
  overrides: Partial<DynamicRepositoryRegistryOptions> = {},
): DynamicRepositoryRegistry {
  return new DynamicRepositoryRegistry({
    policy: policy(),
    resolveDefaultBranchSha: () => 'sha',
    ledger: createEnclaveInformationBudgetLedger(new Map()),
    clock: fakeClock(),
    jitter: () => 0,
    ...overrides,
  });
}

describe('isCanonicalDynamicSelector', () => {
  it('accepts exact canonical lowercase owner/repo selectors', () => {
    expect(isCanonicalDynamicSelector('octo-org/private-service')).toBe(true);
  });

  it('rejects uppercase, trimmed, or path-traversal selectors with no normalization', () => {
    expect(isCanonicalDynamicSelector('Octo-Org/private-service')).toBe(false);
    expect(isCanonicalDynamicSelector(' octo-org/private-service')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/private-service ')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/..')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/repo/extra')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org%2Fprivate-service')).toBe(false);
  });
});

describe('DynamicRepositoryRegistry', () => {
  it('admits a selector within an allowed owner and resolves the default-branch SHA', async () => {
    const outcome = await registry({ resolveDefaultBranchSha: () => 'abc123' }).admit({
      runId: 'run-1',
      entryId: 'agent',
      invocationId: 'inv-1',
      selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({
      admitted: true,
      repo: 'octo-org/private-service',
      defaultBranchSha: 'abc123',
      usageHandle: expect.any(String),
    });
  });

  it('admits an exact allowed repository even outside the allowed owners', async () => {
    const outcome = await registry().admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'other-org/exact-repo',
    });
    expect(outcome.admitted).toBe(true);
  });

  it('admits without a SHA when no confined resolver is available, for a live read', async () => {
    const outcome = await registry({ resolveDefaultBranchSha: () => undefined }).admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/service',
    });
    expect(outcome).toEqual({
      admitted: true,
      repo: 'octo-org/service',
      usageHandle: expect.any(String),
    });
    expect(outcome).not.toHaveProperty('defaultBranchSha');
  });

  it('denies when a resolver returns an empty SHA rather than admitting a live read', async () => {
    const outcome = await registry({ resolveDefaultBranchSha: () => '' }).admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('returns the same canonical denial for malformed, out-of-policy, and expired selectors', async () => {
    const live = registry();
    const malformed = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-a', selector: 'Not-Canonical/Repo',
    });
    const outOfPolicy = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-b', selector: 'unrelated-org/repo',
    });
    const expired = await registry({ policy: policy({ expiresAt: '2000-01-01T00:00:00Z' }) }).admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-c', selector: 'octo-org/private-service',
    });
    expect(malformed).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(outOfPolicy).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(expired).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('denies a selector once the resolver rejects it, without disclosing why', async () => {
    const outcome = await registry({
      resolveDefaultBranchSha: () => {
        throw new Error('repository is private and inaccessible to this token');
      },
    }).admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('is idempotent by (run, entry, invocation, repository): a retry returns the same outcome', async () => {
    let calls = 0;
    const live = registry({
      resolveDefaultBranchSha: () => {
        calls += 1;
        return `sha-${calls}`;
      },
    });
    const request = {
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    };
    const first = await live.admit(request);
    const retry = await live.admit(request);
    expect(retry).toEqual(first);
    expect(calls).toBe(1);
    expect(live.quotaUsage.invocations.debited).toBe(1);
  });

  it('replays a terminal denial for a retried request without re-evaluating policy', async () => {
    let calls = 0;
    const live = registry({
      resolveDefaultBranchSha: () => {
        calls += 1;
        throw new Error('inaccessible');
      },
    });
    const request = {
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    };
    expect(await live.admit(request)).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(await live.admit(request)).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(calls).toBe(1);
  });

  it('coalesces concurrent identical retries into one reservation and one lookup', async () => {
    let calls = 0;
    let release!: (sha: string) => void;
    const live = registry({
      resolveDefaultBranchSha: () => {
        calls += 1;
        return new Promise<string>((resolve) => { release = resolve; });
      },
    });
    const request = {
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    };
    const pending = [live.admit(request), live.admit(request), live.admit(request)];
    release('sha-1');
    const [a, b, c] = await Promise.all(pending);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.admitted).toBe(true);
    // One reservation, one debit: identical retries never double-charge quota.
    expect(live.quotaUsage.invocations.debited).toBe(1);
    expect(live.quotaUsage.invocations.reserved).toBe(0);
    expect(live.admittedRepositoryCount).toBe(1);
  });

  it('coalesces a retry that arrives after the first admission already completed', async () => {
    let calls = 0;
    const live = registry({
      resolveDefaultBranchSha: () => {
        calls += 1;
        return 'sha';
      },
    });
    const request = {
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    };
    await live.admit(request);
    const results = await Promise.all([live.admit(request), live.admit(request)]);
    expect(calls).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(live.quotaUsage.invocations.debited).toBe(1);
  });

  it('denies rebinding one invocation id to a different repository', async () => {
    const live = registry();
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'other-org/exact-repo',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('enforces maxRepositories across distinct invocations', async () => {
    const live = registry({ policy: policy({ maxRepositories: 1 }) });
    const first = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'other-org/exact-repo',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(live.admittedRepositoryCount).toBe(1);
  });

  it('re-admits an already-admitted repository from a different invocation without exceeding maxRepositories', async () => {
    const live = registry({ policy: policy({ maxRepositories: 1 }) });
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(outcome.admitted).toBe(true);
    expect(live.admittedRepositoryCount).toBe(1);
  });

  it('cannot race two concurrent admissions past maxRepositories', async () => {
    const live = registry({ policy: policy({ maxRepositories: 1 }) });
    const outcomes = await Promise.all([
      live.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' }),
      live.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'other-org/exact-repo' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(1);
    expect(live.admittedRepositoryCount).toBe(1);
  });

  it('keeps a successful concurrent admission counted when a sibling for the same repository rolls back', async () => {
    // Two different invocations select the same repository concurrently. The
    // first fails its lookup and rolls back; the second succeeds. The rollback
    // must not release a repository slot the sibling now owns.
    const pendingResolvers: Array<(sha: string) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    const live = registry({
      policy: policy({ maxRepositories: 1 }),
      resolveDefaultBranchSha: () => new Promise<string>((resolve, reject) => {
        pendingResolvers.push(resolve);
        rejecters.push(reject);
      }),
    });
    const failing = live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const succeeding = live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    pendingResolvers[1]('sha-ok');
    await succeeding;
    rejecters[0](new Error('inaccessible'));
    expect(await failing).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect((await succeeding).admitted).toBe(true);
    expect(live.admittedRepositoryCount).toBe(1);
    expect(live.quotaUsage.invocations.debited).toBe(1);
    expect(live.quotaUsage.invocations.reserved).toBe(0);
    // The repository slot is still owned by the committed admission.
    const third = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-3', selector: 'other-org/exact-repo',
    });
    expect(third).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('releases every reserved quota when an admission rolls back', async () => {
    const live = registry({
      resolveDefaultBranchSha: () => {
        throw new Error('inaccessible');
      },
    });
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(live.quotaUsage).toEqual({
      invocations: { debited: 0, reserved: 0, limit: 3 },
      outputBytes: { debited: 0, reserved: 0, limit: 1_000_000 },
      executionSeconds: { debited: 0, reserved: 0, limit: 3600 },
    });
    expect(live.admittedRepositoryCount).toBe(0);
  });
});

describe('DynamicRepositoryRegistry quota accounting', () => {
  it('enforces the run-wide invocation quota', async () => {
    const live = registry({
      policy: policy({ quotas: { maxInvocations: 1, maxOutputBytes: 1_000_000, maxExecutionSeconds: 3600 } }),
    });
    const first = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('reserves the per-invocation output-byte worst case against the run-wide byte quota', async () => {
    // limits.maxOutputBytes is 8192 and the run-wide quota is 10000, so only
    // one invocation can hold a worst-case byte reservation at a time.
    const live = registry({
      policy: policy({ quotas: { maxInvocations: 10, maxOutputBytes: 10_000, maxExecutionSeconds: 3600 } }),
    });
    const first = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(live.quotaUsage.outputBytes).toEqual({ debited: 0, reserved: 8192, limit: 10_000 });
    const blocked = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(blocked).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });

    if (!first.admitted) throw new Error('unreachable');
    live.commitUsage(first.usageHandle, { outputBytes: 100, executionSeconds: 5 });
    expect(live.quotaUsage.outputBytes).toEqual({ debited: 100, reserved: 0, limit: 10_000 });
    expect(live.quotaUsage.executionSeconds).toEqual({ debited: 5, reserved: 0, limit: 3600 });
    const afterSettle = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-3', selector: 'octo-org/private-service',
    });
    expect(afterSettle.admitted).toBe(true);
  });

  it('reserves the per-invocation timeout against the run-wide execution-second quota', async () => {
    const live = registry({
      policy: policy({ quotas: { maxInvocations: 10, maxOutputBytes: 1_000_000, maxExecutionSeconds: 200 } }),
    });
    const first = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(live.quotaUsage.executionSeconds).toEqual({ debited: 0, reserved: 120, limit: 200 });
    const blocked = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(blocked).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('keeps charges committed after admission even when the invocation later fails', async () => {
    const live = registry();
    const outcome = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    if (!outcome.admitted) throw new Error('expected admission');
    live.commitUsage(outcome.usageHandle, { outputBytes: 2048, executionSeconds: 90 });
    expect(live.quotaUsage.invocations.debited).toBe(1);
    expect(live.quotaUsage.outputBytes.debited).toBe(2048);
    expect(live.quotaUsage.executionSeconds.debited).toBe(90);
    // A settlement retry never double-charges.
    live.commitUsage(outcome.usageHandle, { outputBytes: 2048, executionSeconds: 90 });
    expect(live.quotaUsage.outputBytes.debited).toBe(2048);
    expect(live.quotaUsage.executionSeconds.debited).toBe(90);
  });

  it('rejects usage that exceeds the reserved per-invocation limits or an unknown handle', async () => {
    const live = registry();
    const outcome = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    if (!outcome.admitted) throw new Error('expected admission');
    expect(() => live.commitUsage(outcome.usageHandle, { outputBytes: 8193, executionSeconds: 1 }))
      .toThrow(DynamicUsageAccountingError);
    expect(() => live.commitUsage(outcome.usageHandle, { outputBytes: 1, executionSeconds: 121 }))
      .toThrow(DynamicUsageAccountingError);
    expect(() => live.commitUsage(outcome.usageHandle, { outputBytes: -1, executionSeconds: 1 }))
      .toThrow(DynamicUsageAccountingError);
    expect(() => live.commitUsage('no-such-handle', { outputBytes: 1, executionSeconds: 1 }))
      .toThrow(DynamicUsageAccountingError);
  });
});

describe('DynamicRepositoryRegistry shared information ledger', () => {
  it('registers an admitted repository into the same ledger static executors debit', async () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map());
    const live = registry({ ledger });
    expect(ledger.remainingBits('octo-org/private-service')).toBeUndefined();
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    // 'confidential' is bounded at 8 run bits by ENCLAVE_SENSITIVITY_RUN_BITS.
    expect(ledger.remainingBits('octo-org/private-service')).toBe(8);
    expect(ledger.tryDebit('octo-org/private-service', 8, 'agent')).toBe(true);
    expect(ledger.tryDebit('octo-org/private-service', 1, 'agent')).toBe(false);
  });

  it('never refills a spent budget when the same repository is admitted again', async () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map());
    const live = registry({ ledger });
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(ledger.tryDebit('octo-org/private-service', 8, 'agent')).toBe(true);
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(ledger.remainingBits('octo-org/private-service')).toBe(0);
    expect(ledger.tryDebit('octo-org/private-service', 1, 'agent')).toBe(false);
  });

  it('does not register a repository whose admission was denied', async () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map());
    const live = registry({
      ledger,
      resolveDefaultBranchSha: () => {
        throw new Error('inaccessible');
      },
    });
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(ledger.remainingBits('octo-org/private-service')).toBeUndefined();
  });
});

describe('DynamicRepositoryRegistry admission timing normalization', () => {
  /** Elapsed lookup cost, in ms, injected by a resolver that advances the clock. */
  function timedRegistry(lookupMs: number, options: Partial<DynamicRepositoryRegistryOptions> = {}) {
    const clock = fakeClock();
    const live = new DynamicRepositoryRegistry({
      policy: policy(),
      resolveDefaultBranchSha: () => {
        clock.elapsed += lookupMs;
        return 'sha';
      },
      ledger: createEnclaveInformationBudgetLedger(new Map()),
      clock,
      jitter: () => 7,
      ...options,
    });
    return { live, clock };
  }

  it('delays a successful admission to the fixed bucket plus jitter', async () => {
    const { live, clock } = timedRegistry(30);
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(clock.sleeps).toEqual([100 - 30 + 7]);
    expect(clock.elapsed).toBe(107);
  });

  it('delays a slow admission to the next bucket rather than returning early', async () => {
    const { live, clock } = timedRegistry(450);
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(clock.elapsed).toBe(1_000 + 7);
  });

  it('delays a malformed selector, a policy denial, and a resolution denial identically', async () => {
    const malformed = timedRegistry(0);
    await malformed.live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'Not-Canonical/Repo',
    });

    const outOfPolicy = timedRegistry(0);
    await outOfPolicy.live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'unrelated-org/repo',
    });

    const resolutionFailure = timedRegistry(0, {
      resolveDefaultBranchSha: () => {
        throw new Error('inaccessible');
      },
    });
    await resolutionFailure.live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });

    const success = timedRegistry(0);
    await success.live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });

    expect(malformed.clock.elapsed).toBe(107);
    expect(outOfPolicy.clock.elapsed).toBe(107);
    expect(resolutionFailure.clock.elapsed).toBe(107);
    expect(success.clock.elapsed).toBe(107);
  });

  it('caps normalization at the largest fixed bucket', async () => {
    const largest = TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1];
    const { live, clock } = timedRegistry(largest + 5_000);
    await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    // Already past the largest bucket: never sleeps a negative duration.
    expect(clock.sleeps).toEqual([0]);
  });

  it('fails closed for new admissions while reconciliation is incomplete', async () => {
    const live = registry();
    live.markReconciliationIncomplete();
    const outcome = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    live.markReconciled();
    const afterReconcile = await live.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(afterReconcile.admitted).toBe(true);
  });
});

describe('resolveDenialTimingBucketMs', () => {
  it('always resolves to a fixed bucket boundary plus bounded jitter, never raw elapsed time', () => {
    for (const elapsed of [0, 50, 500, 5_000, 50_000, 5_000_000]) {
      const bucketed = resolveDenialTimingBucketMs(elapsed);
      const bucket = Math.max(...TIMING_BUCKETS_MS.filter((candidate) => candidate <= bucketed));
      const jitter = bucketed - bucket;
      expect(TIMING_BUCKETS_MS).toContain(bucket);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1001);
    }
  });

  it('uses the injected secret-independent jitter source', () => {
    expect(resolveDenialTimingBucketMs(0, () => 42)).toBe(100 + 42);
    expect(resolveDenialTimingBucketMs(999, () => 0)).toBe(1_000);
    const largest = TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1];
    expect(resolveDenialTimingBucketMs(largest + 1, () => 0)).toBe(largest);
  });
});
