import {
  NVX_TEARDOWN_STAGES,
  parseNvxOneShotOutcome,
} from './outcome';

function report(
  category: 'success' | 'guest-exit' | 'vmm-failure' = 'success',
  statusCode = category === 'success' ? 0 : 1,
) {
  return {
    schema_version: 1,
    instance_id: 'a'.repeat(32),
    backend: 'kvm',
    outcome: {
      operation: 'run',
      category,
      status_code: statusCode,
    },
    network_policy: {
      status: 'applied',
      status_code: 0,
      mode: 'rules',
      allow_rule_count: 2,
      deny_rule_count: 1,
      host_loopback: 'allow',
    },
    teardown: Object.fromEntries(NVX_TEARDOWN_STAGES.map((stage) => [stage, true])),
  };
}

describe('NVX one-shot outcome parser', () => {
  it('accepts complete success and guest-exit outcomes', () => {
    expect(parseNvxOneShotOutcome(JSON.stringify(report())).outcome)
      .toEqual({ operation: 'run', category: 'success', statusCode: 0 });
    expect(parseNvxOneShotOutcome(JSON.stringify(report('guest-exit', 125))).outcome)
      .toEqual({ operation: 'run', category: 'guest-exit', statusCode: 125 });
  });

  it('rejects partial, false, or additional teardown stages', () => {
    const partial = report();
    delete (partial.teardown as Record<string, boolean>).vm_stopped;
    expect(() => parseNvxOneShotOutcome(JSON.stringify(partial)))
      .toThrow(/teardown keys must be exactly/);

    const failed = report();
    failed.teardown.vm_stopped = false;
    expect(() => parseNvxOneShotOutcome(JSON.stringify(failed)))
      .toThrow(/teardown stage did not complete: vm_stopped/);

    const additional = report();
    (additional.teardown as Record<string, boolean>).unexpected = true;
    expect(() => parseNvxOneShotOutcome(JSON.stringify(additional)))
      .toThrow(/teardown keys must be exactly/);
  });

  it('rejects inconsistent categories, malformed reports, and extra fields', () => {
    expect(() => parseNvxOneShotOutcome(JSON.stringify(report('success', 125))))
      .toThrow(/success outcome must have status_code 0/);
    expect(() => parseNvxOneShotOutcome(JSON.stringify(report('guest-exit', 0))))
      .toThrow(/guest-exit outcome must have a nonzero status_code/);
    expect(() => parseNvxOneShotOutcome('{'))
      .toThrow(/not valid JSON/);
    expect(() => parseNvxOneShotOutcome(JSON.stringify({
      ...report(),
      unexpected: true,
    }))).toThrow(/outcome report keys must be exactly/);
  });
});
