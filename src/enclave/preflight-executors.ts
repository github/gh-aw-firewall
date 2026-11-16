import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveScriptExecutorConfig,
  EnclavesConfig,
} from '../types/enclave-options';
import {
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
} from '../bounded-execution';
import { ENCLAVE_AGENT_MAX_TASK_BYTES } from './protocol';
import type { EnclaveDynamicDelegationHandoffResolution } from './dynamic-delegation-handoff';
import { validateEnclaveDynamicPolicy } from './preflight-dynamic-policy';
import { validateEnclaveAgentGithubConfig } from './preflight-github-tools';
import { validatePositiveInteger, validateResourceLimits } from './preflight-resources';

const RUNTIMES = new Set(['docker', 'gvisor', 'sbx', 'cloud-hypervisor']);
const ENGINES = new Set(['copilot', 'claude', 'codex', 'gemini']);

/**
 * Why a validated dynamic envelope may still be refused.
 *
 * ADR 0001 binds every dynamic invocation to a single-repository mcpg identity
 * minted through the `github-repository-delegation-v1` controller. AWF only
 * runs a dynamic entry when the compiler has actually started that controller
 * and handed AWF both private values — a loopback-only control endpoint and
 * the AWF-only control capability. Without them a dynamic invocation has no
 * identity to mint and no immutable seed to fall back to, so AWF refuses the
 * run and says exactly which handoff is missing. AWF never falls back to a
 * static seed catalog, a job-lifetime identity, or a broader policy.
 */
export const DYNAMIC_ENCLAVE_EXECUTION_UNSUPPORTED_REASON =
  'enclaves[].dynamic repository admission requires the compiler-issued mcpg delegation-control '
  + 'handoff: ADR 0001 binds every dynamic invocation to a single-repository identity created '
  + 'through the "github-repository-delegation-v1" control channel. AWF never falls back to a '
  + 'static seed catalog, a job-lifetime identity, or a broader policy. Upgrade to a gh-aw '
  + 'release that starts the delegation controller, or remove enclaves[].dynamic.';

/** Engines with a published, audited enclave image and a fixed AWF model loop. */
const IMPLEMENTED_AGENT_ENGINES = new Set(['copilot', 'codex', 'claude']);

/**
 * Resolves whether the configured agent profile has a usable API-proxy route.
 *
 * An agent enclave holds no credentials: it can only reach a model through the
 * dedicated AWF API proxy, which injects the real key. If the profile's
 * provider is not routed for this run the enclave would sit on an internal
 * network with nothing to talk to, so the run is rejected rather than started
 * in a state where every invocation returns the canonical error.
 */
export function resolveEnclaveAgentApiRoute(
  config: WrapperConfig,
  agent: Pick<EnclaveAgentExecutorConfig, 'engine' | 'profile'>,
): { routed: boolean; detail: string } {
  if (agent.engine === 'copilot') {
    return {
      routed: Boolean(
        config.copilotGithubToken
        || config.copilotProviderApiKey,
      ),
      detail: 'apiProxy.targets.copilot (COPILOT_GITHUB_TOKEN or Copilot BYOK route) is not configured',
    };
  }
  if (agent.profile === 'anthropic') {
    return {
      routed: Boolean(config.anthropicApiKey),
      detail: 'apiProxy.targets.anthropic (ANTHROPIC_API_KEY) is not configured',
    };
  }
  return {
    routed: Boolean(config.openaiApiKey),
    detail: 'apiProxy.targets.openai (OPENAI_API_KEY) is not configured',
  };
}

/**
 * Static, fail-closed checks for the unified enclave foundation.
 *
 * `options.delegationHandoff` carries the already-validated mcpg
 * delegation-control handoff, which is required for — and only for — an entry
 * that declares `enclaves[].dynamic`.
 *
 * `options.requireDelegationHandoff` exists because taking custody of that
 * handoff *consumes* it: `takeEnclaveDynamicDelegationHandoff` deletes both
 * environment variables so nothing can inherit them, so exactly one caller
 * (`prepareEnclaves`) may read them. Early structural validation therefore
 * passes `false` and defers the handoff check to that single custodian, which
 * runs before any container exists.
 */
export interface ValidateEnclavesOptions {
  delegationHandoff?: EnclaveDynamicDelegationHandoffResolution;
  requireDelegationHandoff?: boolean;
}

export function validateEnclaveExecutors(
  config: WrapperConfig,
  enclaves: EnclavesConfig,
  options: ValidateEnclavesOptions,
  errors: string[],
): void {
  const { script, agent } = enclaves.executors;
  const hostExecutorSelected = (script.enabled && script.runtime === 'cloud-hypervisor')
    || (agent.enabled && agent.runtime === 'cloud-hypervisor');
  if (hostExecutorSelected) {
    if (config.containerRuntime === 'sbx' || config.containerRuntime === 'nvx') {
      errors.push(`Cloud Hypervisor enclaves cannot be combined with the primary ${config.containerRuntime} runtime`);
    }
    if (config.dockerHostPathPrefix) {
      errors.push('Cloud Hypervisor enclaves cannot use a Docker host path prefix or split-filesystem DinD');
    }
    if ([script, agent].some((entry) => entry.enabled && entry.runtime !== 'cloud-hypervisor')) {
      errors.push('Cloud Hypervisor enclaves cannot be mixed with other enclave runtimes; no runtime fallback');
    }
    if (!config.cloudHypervisor?.previewEnabled) {
      errors.push('Cloud Hypervisor enclaves require explicit --cloud-hypervisor-preview opt-in');
    }
  }
  if (!script.enabled && !agent.enabled) {
    errors.push('enclaves is enabled but no enclave executor entry is configured');
  }
  if (script.enabled) validateScriptExecutor(script, errors);
  if (agent.enabled) validateAgentExecutor(config, agent, options, errors);
}

function validateScriptExecutor(script: EnclaveScriptExecutorConfig, errors: string[]): void {
  if (!RUNTIMES.has(script.runtime)) errors.push(`enclaves[].runtime "${script.runtime}" is not supported`);
  if (script.runtime === 'cloud-hypervisor' && script.image !== undefined) {
    errors.push(
      'enclaves[].image is not supported with runtime "cloud-hypervisor": the preview requires '
      + 'AWF release-attested script rootfs artifacts and never falls back to a custom image',
    );
  }
  if (script.network !== 'none') errors.push('enclaves[].script.network must be "none"');
  if (script.interpreter !== 'python3') errors.push('enclaves[].script.interpreter must be "python3"');
  if (!Number.isInteger(script.timeout) || script.timeout < 1 || script.timeout > MAX_ENCLAVE_TIMEOUT_SECONDS) {
    errors.push(
      `enclaves[].timeout must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`,
    );
  }
  validateResourceLimits('enclaves[]', script, errors);
  validatePositiveInteger('enclaves[].script.maxScriptBytes', script.maxScriptBytes, errors);
  if (script.maxScriptBytes > MAX_SCRIPT_BYTES) {
    errors.push(`enclaves[].script.maxScriptBytes must be at most ${MAX_SCRIPT_BYTES}`);
  }
  if (script.maxOutputBytes > MAX_RESULT_BYTES) {
    errors.push(`enclaves[].maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
  }
  validatePositiveInteger('enclaves[].maxInvocations', script.maxInvocations, errors);
}

function validateAgentExecutor(
  config: WrapperConfig,
  agent: EnclaveAgentExecutorConfig,
  options: ValidateEnclavesOptions,
  errors: string[],
): void {
  if (!RUNTIMES.has(agent.runtime)) errors.push(`enclaves[].runtime "${agent.runtime}" is not supported`);
  if (agent.runtime === 'cloud-hypervisor' && agent.image !== undefined) {
    errors.push(
      'enclaves[].image is not supported with runtime "cloud-hypervisor": the preview requires '
      + 'AWF release-attested agent rootfs artifacts and never falls back to a custom image',
    );
  }
  if (agent.runtime === 'cloud-hypervisor' && agent.dynamic !== undefined) {
    errors.push(
      'enclaves[].dynamic is not supported with runtime "cloud-hypervisor" in the initial preview; '
      + 'only static script and static agent microVM enclaves are in scope, with no runtime fallback',
    );
  }
  if (!ENGINES.has(agent.engine)) {
    errors.push(`enclaves[].agent.engine "${agent.engine}" is not supported`);
  } else if (!IMPLEMENTED_AGENT_ENGINES.has(agent.engine)) {
    errors.push(
      `enclaves[].agent.engine "${agent.engine}" is not implemented. Only "copilot", "codex" and "claude" have a ` +
      'pinned native enclave image and an AWF-authored model loop; enclaves never fall back to a ' +
      'different engine.',
    );
  }
  if ((agent.engine === 'claude' && agent.profile !== 'anthropic')
    || (agent.engine === 'codex' && agent.profile !== 'openai')) {
    errors.push(`enclaves[].agent.profile does not match engine "${agent.engine}"`);
  }
  if (agent.engine === 'claude' && agent.maxModelTokens !== undefined) {
    errors.push('enclaves[].agent.maxModelTokens is not supported with the Claude engine');
  }
  if (agent.engine !== 'copilot' && (agent.dynamic !== undefined
    || agent.tools !== undefined || agent.github !== undefined)) {
    errors.push('GitHub MCP and dynamic repository admission currently require the Copilot enclave engine');
  }
  if (agent.network !== 'api-proxy-only') {
    errors.push('enclaves[].agent.network must be "api-proxy-only"');
  }
  if (!agent.model) errors.push('enclaves[].agent.model is required when the agent executor is enabled');
  validateAgentRepositories(agent, options, errors);
  if (!config.enableApiProxy) {
    errors.push('enclaves agent executor requires the AWF API proxy');
  } else {
    const route = resolveEnclaveAgentApiRoute(config, agent);
    if (!route.routed) {
      errors.push(
        `enclaves agent executor requires a configured API target for engine "${agent.engine}": ` +
        `${route.detail}`,
      );
    }
  }
  if (!Number.isInteger(agent.timeout) || agent.timeout < 1 || agent.timeout > MAX_ENCLAVE_TIMEOUT_SECONDS) {
    errors.push(
      `enclaves[].timeout must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`,
    );
  }
  validateResourceLimits('enclaves[]', agent, errors);
  validatePositiveInteger('enclaves[].agent.maxTaskBytes', agent.maxTaskBytes, errors);
  if (agent.maxTaskBytes > ENCLAVE_AGENT_MAX_TASK_BYTES) {
    errors.push(`enclaves[].agent.maxTaskBytes must be at most ${ENCLAVE_AGENT_MAX_TASK_BYTES}`);
  }
  if (agent.maxOutputBytes > MAX_RESULT_BYTES) {
    errors.push(`enclaves[].maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
  }
  validatePositiveInteger('enclaves[].maxInvocations', agent.maxInvocations, errors);
  if (agent.maxModelRequests !== undefined) {
    validatePositiveInteger('enclaves[].agent.maxModelRequests', agent.maxModelRequests, errors);
  }
  if (agent.maxModelTokens !== undefined) {
    validatePositiveInteger('enclaves[].agent.maxModelTokens', agent.maxModelTokens, errors);
  }
  validateEnclaveAgentGithubConfig(agent, errors);
}

function validateAgentRepositories(
  agent: EnclaveAgentExecutorConfig,
  options: ValidateEnclavesOptions,
  errors: string[],
): void {
  if (agent.dynamic !== undefined && agent.repos.length > 0) {
    errors.push(
      'enclaves[].dynamic and enclaves[].repos are mutually exclusive: an entry declares a static '
      + 'seed catalog or a dynamic policy, never both',
    );
  } else if (agent.dynamic === undefined && agent.repos.length === 0) {
    errors.push('enclaves[].agent requires either a non-empty "repos" list or a "dynamic" policy');
  } else if (agent.dynamic !== undefined) {
    validateEnclaveDynamicPolicy(agent.dynamic, errors);
    const { delegationHandoff, requireDelegationHandoff = true } = options;
    if (requireDelegationHandoff) {
      if (!delegationHandoff) {
        errors.push(DYNAMIC_ENCLAVE_EXECUTION_UNSUPPORTED_REASON);
      } else if (!delegationHandoff.handoff) {
        errors.push(...delegationHandoff.errors);
      }
    }
  }
}
