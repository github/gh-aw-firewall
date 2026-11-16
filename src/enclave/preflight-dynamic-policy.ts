import type { EnclaveDynamicPolicy } from '../types/enclave-options';
import {
  CANONICAL_DYNAMIC_AUDIT_LABEL_PATTERN,
  CANONICAL_DYNAMIC_OWNER_PATTERN,
  CANONICAL_DYNAMIC_REPOSITORY_PATTERN,
  ENCLAVE_AGENT_GITHUB_TOOLS,
  ENCLAVE_SENSITIVITIES,
} from '../types/enclave-options';
import {
  MAX_RESULT_BYTES,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
} from '../bounded-execution';
import { ENCLAVE_AGENT_MAX_TASK_BYTES } from './protocol';
import { validatePositiveInteger, validateResourceLimits } from './preflight-resources';

const DYNAMIC_GITHUB_POLICY_VERSIONS = new Set(['github-repository-read-v1']);

/** AWF-enforceable upper bound on the number of repositories one dynamic envelope may admit. */
const MAX_DYNAMIC_REPOSITORIES = 1000;
/** AWF-enforceable upper bound on the number of owner/repository selectors listed in one envelope. */
const MAX_DYNAMIC_SELECTOR_LIST_LENGTH = 256;
const MAX_DYNAMIC_AUDIT_LABELS = 32;
const MAX_DYNAMIC_MODEL_REQUESTS = 64;
const MAX_DYNAMIC_MODEL_TOKENS = 32768;
const MAX_DYNAMIC_QUOTA_INVOCATIONS = 10_000;
const MAX_DYNAMIC_QUOTA_OUTPUT_BYTES = 1024 * 1024;
const MAX_DYNAMIC_QUOTA_EXECUTION_SECONDS = 86_400;

/**
 * Validates the closed `enclaves[].dynamic` policy envelope per ADR 0001.
 * AWF rejects any field it does not understand, any policy version other
 * than the closed v1 GitHub tool set, and any bound it cannot enforce. The
 * invocation-time selector is validated separately by the dynamic registry
 * against this already-validated envelope.
 */
export function validateEnclaveDynamicPolicy(dynamic: EnclaveDynamicPolicy, errors: string[]): void {
  if (typeof dynamic !== 'object' || dynamic === null) {
    errors.push('enclaves[].dynamic must be an object');
    return;
  }
  if (dynamic.executor !== 'agent') {
    errors.push('enclaves[].dynamic.executor must be "agent"');
  }
  const owners = dynamic.allowedOwners;
  const repositories = dynamic.allowedRepositories;
  if (!Array.isArray(owners) || !Array.isArray(repositories)) {
    errors.push('enclaves[].dynamic.allowedOwners and allowedRepositories must be arrays');
  } else {
    if (owners.length === 0 && repositories.length === 0) {
      errors.push('enclaves[].dynamic must declare at least one allowed owner or repository');
    }
    if (owners.length > MAX_DYNAMIC_SELECTOR_LIST_LENGTH || repositories.length > MAX_DYNAMIC_SELECTOR_LIST_LENGTH) {
      errors.push(
        `enclaves[].dynamic.allowedOwners and allowedRepositories must each have at most ` +
        `${MAX_DYNAMIC_SELECTOR_LIST_LENGTH} entries`,
      );
    }
    for (const owner of owners) {
      if (typeof owner !== 'string' || !CANONICAL_DYNAMIC_OWNER_PATTERN.test(owner)) {
        errors.push(`enclaves[].dynamic.allowedOwners entry "${owner}" is not a canonical lowercase owner`);
      }
    }
    for (const repo of repositories) {
      if (typeof repo !== 'string' || !CANONICAL_DYNAMIC_REPOSITORY_PATTERN.test(repo)) {
        errors.push(
          `enclaves[].dynamic.allowedRepositories entry "${repo}" is not a canonical lowercase "owner/repository"`,
        );
      }
    }
  }
  if (!ENCLAVE_SENSITIVITIES.includes(dynamic.sensitivity)) {
    errors.push(`enclaves[].dynamic.sensitivity "${dynamic.sensitivity}" is not supported`);
  }
  validatePositiveInteger('enclaves[].dynamic.maxRepositories', dynamic.maxRepositories, errors);
  if (dynamic.maxRepositories > MAX_DYNAMIC_REPOSITORIES) {
    errors.push(`enclaves[].dynamic.maxRepositories must be at most ${MAX_DYNAMIC_REPOSITORIES}`);
  }
  const githubPolicy = dynamic.githubPolicy;
  if (typeof githubPolicy !== 'object' || githubPolicy === null) {
    errors.push('enclaves[].dynamic.githubPolicy must be an object');
  } else {
    if (!DYNAMIC_GITHUB_POLICY_VERSIONS.has(githubPolicy.version)) {
      errors.push(
        `enclaves[].dynamic.githubPolicy.version "${githubPolicy.version}" is not supported; ` +
        `only ${JSON.stringify([...DYNAMIC_GITHUB_POLICY_VERSIONS])} is accepted`,
      );
    }
    const tools = githubPolicy.tools;
    if (
      !Array.isArray(tools)
      || tools.length !== ENCLAVE_AGENT_GITHUB_TOOLS.length
      || new Set(tools).size !== ENCLAVE_AGENT_GITHUB_TOOLS.length
      || !ENCLAVE_AGENT_GITHUB_TOOLS.every(tool => tools.includes(tool))
    ) {
      errors.push(
        'enclaves[].dynamic.githubPolicy.tools must be exactly '
        + JSON.stringify(ENCLAVE_AGENT_GITHUB_TOOLS),
      );
    }
  }
  const limits = dynamic.limits;
  if (typeof limits !== 'object' || limits === null) {
    errors.push('enclaves[].dynamic.limits must be an object');
  } else {
    validateResourceLimits('enclaves[].dynamic.limits', limits, errors);
    if (
      !Number.isInteger(limits.timeoutSeconds)
      || limits.timeoutSeconds < 1
      || limits.timeoutSeconds > MAX_ENCLAVE_TIMEOUT_SECONDS
    ) {
      errors.push(
        `enclaves[].dynamic.limits.timeoutSeconds must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`,
      );
    }
    validatePositiveInteger('enclaves[].dynamic.limits.maxTaskBytes', limits.maxTaskBytes, errors);
    if (limits.maxTaskBytes > ENCLAVE_AGENT_MAX_TASK_BYTES) {
      errors.push(`enclaves[].dynamic.limits.maxTaskBytes must be at most ${ENCLAVE_AGENT_MAX_TASK_BYTES}`);
    }
    if (limits.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves[].dynamic.limits.maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validateBoundedQuota(
      'enclaves[].dynamic.limits.maxModelRequests',
      limits.maxModelRequests,
      MAX_DYNAMIC_MODEL_REQUESTS,
      errors,
    );
    validateBoundedQuota(
      'enclaves[].dynamic.limits.maxModelTokens',
      limits.maxModelTokens,
      MAX_DYNAMIC_MODEL_TOKENS,
      errors,
    );
  }
  const quotas = dynamic.quotas;
  if (typeof quotas !== 'object' || quotas === null) {
    errors.push('enclaves[].dynamic.quotas must be an object');
  } else {
    validateBoundedQuota(
      'enclaves[].dynamic.quotas.maxInvocations',
      quotas.maxInvocations,
      MAX_DYNAMIC_QUOTA_INVOCATIONS,
      errors,
    );
    validateBoundedQuota(
      'enclaves[].dynamic.quotas.maxOutputBytes',
      quotas.maxOutputBytes,
      MAX_DYNAMIC_QUOTA_OUTPUT_BYTES,
      errors,
    );
    validateBoundedQuota(
      'enclaves[].dynamic.quotas.maxExecutionSeconds',
      quotas.maxExecutionSeconds,
      MAX_DYNAMIC_QUOTA_EXECUTION_SECONDS,
      errors,
    );
  }
  const auditLabels = dynamic.auditLabels;
  if (!Array.isArray(auditLabels) || auditLabels.length === 0) {
    errors.push('enclaves[].dynamic.auditLabels must be a non-empty array of canonical audit labels');
  } else {
    if (auditLabels.length > MAX_DYNAMIC_AUDIT_LABELS) {
      errors.push(`enclaves[].dynamic.auditLabels must have at most ${MAX_DYNAMIC_AUDIT_LABELS} entries`);
    }
    if (new Set(auditLabels).size !== auditLabels.length) {
      errors.push('enclaves[].dynamic.auditLabels must not contain duplicate labels');
    }
    for (const label of auditLabels) {
      if (typeof label !== 'string' || !CANONICAL_DYNAMIC_AUDIT_LABEL_PATTERN.test(label)) {
        errors.push(
          `enclaves[].dynamic.auditLabels entry "${label}" must match `
          + CANONICAL_DYNAMIC_AUDIT_LABEL_PATTERN.source,
        );
      }
    }
  }
  if (typeof dynamic.expiresAt !== 'string' || Number.isNaN(Date.parse(dynamic.expiresAt))) {
    errors.push('enclaves[].dynamic.expiresAt must be a valid ISO-8601 timestamp');
  } else if (Date.parse(dynamic.expiresAt) <= Date.now()) {
    errors.push('enclaves[].dynamic.expiresAt must be in the future');
  }
}

/** Validates one compiler-owned bound: a positive integer within AWF's own ceiling. */
function validateBoundedQuota(name: string, value: number, maximum: number, errors: string[]): void {
  validatePositiveInteger(name, value, errors);
  if (Number.isSafeInteger(value) && value > maximum) {
    errors.push(`${name} must be at most ${maximum}`);
  }
}
