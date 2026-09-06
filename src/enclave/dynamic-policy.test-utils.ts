/**
 * The exact `enclaves[].dynamic` envelope the gh-aw compiler emits.
 *
 * Copied verbatim from `buildAWFDynamicEnclavePolicy` in
 * `pkg/workflow/enclaves.go` as merged by gh-aw#58880: field names, field set,
 * and value shapes are the compiler's, not AWF's. AWF's types, both JSON
 * schemas, and preflight validation are asserted against this fixture so a
 * valid compiler envelope can never be rejected by AWF, and so a drift in
 * either direction fails a test rather than a workflow run.
 */
import type { EnclaveDynamicPolicy } from '../types/enclave-options';

export const GH_AW_DYNAMIC_ENCLAVE_POLICY_FIXTURE = {
  allowedOwners: ['octo-org'],
  allowedRepositories: ['other-org/exact-repo'],
  sensitivity: 'confidential',
  executor: 'agent',
  githubPolicy: {
    version: 'github-repository-read-v1',
    tools: ['list_issues', 'issue_read'],
  },
  maxRepositories: 4,
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
  quotas: {
    maxInvocations: 10,
    maxOutputBytes: 1_000_000,
    maxExecutionSeconds: 3600,
  },
  auditLabels: ['awf-enclave-dynamic', 'gh-aw-run-1'],
  expiresAt: '2999-01-01T00:00:00Z',
} as const;

/** The compiler envelope as AWF's own `EnclaveDynamicPolicy` type. */
export function typedDynamicEnclavePolicyFixture(): EnclaveDynamicPolicy {
  return structuredClone(
    GH_AW_DYNAMIC_ENCLAVE_POLICY_FIXTURE,
  ) as unknown as EnclaveDynamicPolicy;
}

/** A structurally valid compiler envelope with targeted field overrides. */
export function dynamicEnclavePolicyFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...structuredClone(GH_AW_DYNAMIC_ENCLAVE_POLICY_FIXTURE as unknown as Record<string, unknown>),
    ...overrides,
  };
}
