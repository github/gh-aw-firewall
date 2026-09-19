export const NVX_OUTCOME_SCHEMA_VERSION = 1;
export const NVX_TEARDOWN_STAGES = [
  'control_channels_closed',
  'guest_workload_stopped',
  'network_released',
  'openvmm_process_terminated',
  'temporary_storage_removed',
  'virtiofs_released',
  'vm_stopped',
] as const;

export type NvxOutcomeCategory = 'success' | 'guest-exit' | 'vmm-failure';

export interface NvxOneShotOutcome {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly backend: 'kvm';
  readonly outcome: {
    readonly operation: 'run';
    readonly category: NvxOutcomeCategory;
    readonly statusCode: number;
  };
  readonly networkPolicy: {
    readonly status: string;
    readonly statusCode: number;
    readonly mode: string;
    readonly allowRuleCount: number;
    readonly denyRuleCount: number;
    readonly hostLoopback: string;
  };
  readonly teardown: Readonly<Record<typeof NVX_TEARDOWN_STAGES[number], true>>;
}

export function parseNvxOneShotOutcome(contents: string): NvxOneShotOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`NVX outcome report is not valid JSON: ${formatError(error)}`);
  }
  const report = requireObject(parsed, 'NVX outcome report');
  assertExactKeys(report, [
    'schema_version',
    'instance_id',
    'backend',
    'outcome',
    'network_policy',
    'teardown',
  ], 'NVX outcome report');
  if (report.schema_version !== NVX_OUTCOME_SCHEMA_VERSION) {
    throw new Error('NVX outcome report schema_version must be 1');
  }
  const instanceId = requireString(report.instance_id, 'instance_id');
  if (!/^[a-f0-9]{32}$/.test(instanceId)) {
    throw new Error('NVX outcome instance_id must be 32 lowercase hexadecimal characters');
  }
  if (report.backend !== 'kvm') {
    throw new Error('NVX outcome backend must be "kvm"');
  }

  const outcome = requireObject(report.outcome, 'outcome');
  assertExactKeys(outcome, ['operation', 'category', 'status_code'], 'outcome');
  if (outcome.operation !== 'run') {
    throw new Error('NVX one-shot outcome operation must be "run"');
  }
  if (
    outcome.category !== 'success' &&
    outcome.category !== 'guest-exit' &&
    outcome.category !== 'vmm-failure'
  ) {
    throw new Error(`Unsupported NVX one-shot outcome category: ${String(outcome.category)}`);
  }
  const statusCode = requireInteger(outcome.status_code, 'outcome.status_code', 0, 255);
  if (outcome.category === 'success' && statusCode !== 0) {
    throw new Error('NVX success outcome must have status_code 0');
  }
  if (outcome.category !== 'success' && statusCode === 0) {
    throw new Error(`NVX ${outcome.category} outcome must have a nonzero status_code`);
  }

  const network = requireObject(report.network_policy, 'network_policy');
  assertExactKeys(network, [
    'status',
    'status_code',
    'mode',
    'allow_rule_count',
    'deny_rule_count',
    'host_loopback',
  ], 'network_policy');
  const teardown = requireObject(report.teardown, 'teardown');
  assertExactKeys(teardown, [...NVX_TEARDOWN_STAGES], 'teardown');
  const incompleteStage = NVX_TEARDOWN_STAGES.find((stage) =>
    Object.entries(teardown).some(([name, value]) => name === stage && value !== true)
  );
  if (incompleteStage) {
    throw new Error(`NVX teardown stage did not complete: ${incompleteStage}`);
  }

  return {
    schemaVersion: 1,
    instanceId,
    backend: 'kvm',
    outcome: {
      operation: 'run',
      category: outcome.category,
      statusCode,
    },
    networkPolicy: {
      status: requireString(network.status, 'network_policy.status'),
      statusCode: requireInteger(
        network.status_code,
        'network_policy.status_code',
        0,
        255,
      ),
      mode: requireString(network.mode, 'network_policy.mode'),
      allowRuleCount: requireInteger(
        network.allow_rule_count,
        'network_policy.allow_rule_count',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      denyRuleCount: requireInteger(
        network.deny_rule_count,
        'network_policy.deny_rule_count',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      hostLoopback: requireString(
        network.host_loopback,
        'network_policy.host_loopback',
      ),
    },
    teardown: Object.fromEntries(
      NVX_TEARDOWN_STAGES.map((stage) => [stage, true]),
    ) as Record<typeof NVX_TEARDOWN_STAGES[number], true>,
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer in ${minimum}-${maximum}`);
  }
  return value as number;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `${label} keys must be exactly: ${normalizedExpected.join(', ')}`,
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
